//! Turning two marks on a timeline into a shorter recording.
//!
//! A screen recording has two kinds of waste in it, and this covers both:
//!
//! * **Keep** — throw away everything outside the marks. The dead air at each
//!   end, which is the reach for the hotkey and the reach back for it.
//! * **Cut** — throw away everything *between* the marks and close the gap.
//!   The doorbell, the notification, the thirty seconds of looking for a menu.
//!
//! They are the same operation seen from two sides, and underneath they are
//! literally the same: a list of the parts worth keeping, handed to `compose`.
//! Keeping is a list of one part; cutting is a list of two. Everything specific
//! to either lives in `plan`, which is where the ways a selection can be wrong
//! are named, and which needs no file on disk to test.
//!
//! # Why a new file
//!
//! The original is never touched. A screenshot can be taken again; the thing
//! that happened on screen for those thirty seconds cannot, and an overwrite
//! that took the wrong two seconds off would be unrecoverable. The result lands
//! beside it as `<name> trimmed`, and the player switches to it, so sharing or
//! copying next picks up the short one.
//!
//! One suffix for both operations, deliberately. A file that has been shortened
//! is a trimmed file whichever end the missing part came out of, and a second
//! suffix would only produce names like `X trimmed cut trimmed`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::compose::Segment;

/// The shortest part worth keeping, and the closest two marks may get.
///
/// Matches `MIN_SELECTION` in `TrimBar.tsx`, which stops the handles from
/// meeting in the first place. Enforced here as well because the page is not
/// the only thing that can call this, and a zero-length segment reaches
/// AVFoundation as a bare failure with nothing useful to say about it.
const MIN_SECONDS: f64 = 0.2;

/// The suffix a shortened recording is filed under.
const SUFFIX: &str = " trimmed";

/// Which side of the marks to throw away.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Keep what is between the marks.
    Keep,
    /// Cut out what is between the marks and close the gap.
    Cut,
}

/// Where the result landed, in the shape the player needs to switch to it.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Trimmed {
    pub path: String,
    pub name: String,
    /// Running time of the new file.
    pub seconds: f64,
}

/// Shorten `path` about the marks at `start` and `end`, and file the result.
///
/// **`async`, and that is load-bearing** — the same trap `library_thumbnail`
/// documents, walked into again. A synchronous `#[tauri::command]` runs on the
/// **main thread**, and this one waits on an export for seconds. Shipped that
/// way in 0.9.5 it froze the whole interface for the length of the trim: the
/// button never even repainted to say it was working, because the thread that
/// would have drawn it was the thread doing the waiting. It read as a dead app,
/// which is what it was.
#[tauri::command]
pub async fn video_trim(
    app: AppHandle,
    path: String,
    start: f64,
    end: f64,
    mode: Mode,
) -> Result<Trimmed, String> {
    tauri::async_runtime::spawn_blocking(move || cut(&app, &path, start, end, mode))
        .await
        .map_err(|e| format!("the trim did not finish: {e}"))?
}

/// Everything the command does, off the main thread.
fn cut(app: &AppHandle, path: &str, start: f64, end: f64, mode: Mode) -> Result<Trimmed, String> {
    let source = PathBuf::from(path);
    if !crate::video::is_video(&source) {
        return Err("that file is not a recording".into());
    }
    if !source.is_file() {
        return Err("that recording is no longer where the library left it".into());
    }

    // The movie's own header rather than whatever the page believed. The page
    // learns the duration from WebKit, and a cut is about to be turned into a
    // range of somebody's recording; a file that will not measure gives zero,
    // which `plan` reads as "no known end".
    let whole = crate::video::probe(&source).map(|info| info.seconds).unwrap_or(0.0);
    let keep = plan(mode, start, end, whole)?;
    let seconds = keep.iter().map(|part| part.seconds).sum();

    let scratch = scratch_path(&source)?;
    // Said before the work starts, not after the first poll: an export of a
    // short recording can finish inside one tick, and a progress bar that only
    // ever appears for slow trims is a progress bar nobody trusts.
    let _ = app.emit("trim:progress", 0.0_f32);
    let written = crate::compose::write(&source, &scratch, &keep, &mut |fraction| {
        let _ = app.emit("trim:progress", fraction);
    });
    if written.is_err() {
        let _ = std::fs::remove_file(&scratch);
    }
    written?;

    let stem = trimmed_stem(source.file_stem().and_then(|s| s.to_str()).unwrap_or("Recording"));
    let landed = crate::commands::move_into_library(app, &scratch, &stem, &container(&source))?;
    let name = Path::new(&landed)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| stem.clone());

    Ok(Trimmed { path: landed, name, seconds })
}

/// Turn a mode and two marks into the parts of the source to keep.
///
/// This is where a shortening goes wrong in ways worth naming — marks the wrong
/// way round, a selection of nothing, a selection that is the whole recording,
/// a cut that would leave nothing behind — and none of them need a file on disk
/// to find out about.
fn plan(mode: Mode, start: f64, end: f64, whole: f64) -> Result<Vec<Segment>, String> {
    if !start.is_finite() || !end.is_finite() {
        return Err("those marks are not numbers".into());
    }

    let start = start.max(0.0);
    // `whole` is zero for a movie whose header would not measure. A keep can
    // still be done from the marks alone; a cut cannot, because the part after
    // the second mark has no known end.
    let end = if whole > 0.0 { end.min(whole) } else { end };

    if end - start < MIN_SECONDS {
        return Err(format!(
            "that selection is too short — move the handles at least {MIN_SECONDS} seconds apart"
        ));
    }

    let parts = match mode {
        Mode::Keep => {
            // Keeping everything is not an error, it is a no-op, and quietly
            // writing a second identical copy of a 300 MB recording would be a
            // surprising way to answer it.
            if whole > 0.0 && start <= 0.0 && end >= whole - MIN_SECONDS {
                return Err(
                    "that is the whole recording — move a handle to trim something off".into()
                );
            }
            vec![Segment { start, seconds: end - start }]
        }
        Mode::Cut => {
            if whole <= 0.0 {
                return Err("Shotly cannot measure that recording, so it cannot cut from the middle of it".into());
            }
            vec![
                Segment { start: 0.0, seconds: start },
                Segment { start: end, seconds: whole - end },
            ]
        }
    };

    // A part too short to be worth a frame is dropped rather than written: a
    // cut that starts at 0.05s would otherwise leave a sliver of head on the
    // front of the result, which is worse than not having it.
    let parts: Vec<Segment> = parts.into_iter().filter(|p| p.seconds >= MIN_SECONDS).collect();
    if parts.is_empty() {
        return Err(match mode {
            Mode::Cut => "that would cut away the whole recording".into(),
            Mode::Keep => "there would be nothing left".into(),
        });
    }
    Ok(parts)
}

/// The name a shortened recording is filed under, given the original's.
///
/// Shortening a shortened recording gives `X trimmed` again rather than
/// `X trimmed trimmed`; the collision is then resolved by `free_name_in` into
/// `X trimmed (2)`, which is what someone tightening a cut twice would expect.
fn trimmed_stem(stem: &str) -> String {
    let base = stem.strip_suffix(SUFFIX).unwrap_or(stem);
    format!("{base}{SUFFIX}")
}

/// The container to write, which is always the one that came in.
///
/// Lower-cased because it becomes a name in the library, and `Recording.MOV`
/// beside `Recording.mov` is a distinction nothing else in Shotly draws.
fn container(source: &Path) -> String {
    source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_else(|| "mov".into())
}

/// Somewhere to write the result before it earns a place in the library.
fn scratch_path(source: &Path) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("shotly");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok(dir.join(format!("trim-{stamp}.{}", container(source))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keep(start: f64, end: f64, whole: f64) -> Result<Vec<Segment>, String> {
        plan(Mode::Keep, start, end, whole)
    }
    fn cut_out(start: f64, end: f64, whole: f64) -> Result<Vec<Segment>, String> {
        plan(Mode::Cut, start, end, whole)
    }
    fn seg(start: f64, seconds: f64) -> Segment {
        Segment { start, seconds }
    }

    #[test]
    fn keeping_the_middle_is_one_part() {
        // Three seconds of fumbling off the front, four off the back of forty.
        assert_eq!(keep(3.0, 36.0, 40.0), Ok(vec![seg(3.0, 33.0)]));
        // A handle dragged past the end is clamped rather than refused; the
        // page's duration comes from WebKit and need not agree with the header
        // to the millisecond.
        assert_eq!(keep(3.0, 99.0, 40.0), Ok(vec![seg(3.0, 37.0)]));
        // A movie the header would not measure can still be trimmed.
        assert_eq!(keep(1.0, 5.0, 0.0), Ok(vec![seg(1.0, 4.0)]));
    }

    /// The operation that could not be done with a converter at all: two parts,
    /// which `compose` joins into one movie with the gap closed.
    #[test]
    fn cutting_the_middle_out_leaves_the_two_ends() {
        assert_eq!(cut_out(10.0, 20.0, 40.0), Ok(vec![seg(0.0, 10.0), seg(20.0, 20.0)]));
    }

    /// A cut against one end of the recording is a trim, and must come out as
    /// one part rather than one part and a sliver.
    #[test]
    fn a_cut_that_reaches_an_end_is_simply_a_trim() {
        // Nothing before the first mark: only the tail survives.
        assert_eq!(cut_out(0.0, 12.0, 40.0), Ok(vec![seg(12.0, 28.0)]));
        // Nothing after the second: only the head.
        assert_eq!(cut_out(28.0, 40.0, 40.0), Ok(vec![seg(0.0, 28.0)]));
        // A head too short to be worth a frame is dropped, not written.
        assert_eq!(cut_out(0.05, 12.0, 40.0), Ok(vec![seg(12.0, 28.0)]));
    }

    #[test]
    fn a_selection_of_nothing_is_refused_before_the_exporter_sees_it() {
        // Marks on top of each other, and marks the wrong way round, are the
        // same mistake and get the same answer.
        assert!(keep(10.0, 10.0, 40.0).is_err());
        assert!(keep(30.0, 10.0, 40.0).is_err());
        assert!(cut_out(10.0, 10.0, 40.0).is_err());
        assert!(keep(f64::NAN, 10.0, 40.0).is_err());
        assert!(keep(0.0, f64::INFINITY, 0.0).is_err());
    }

    /// Keeping everything would write a second copy of a file that can be
    /// hundreds of megabytes, under a name saying it had been shortened.
    #[test]
    fn shortening_that_removes_nothing_is_refused_rather_than_duplicated() {
        assert!(keep(0.0, 40.0, 40.0).is_err());
        // Dragged a hair short of the end, on purpose: still a trim.
        assert_eq!(keep(0.0, 39.0, 40.0), Ok(vec![seg(0.0, 39.0)]));
    }

    /// The mirror image, and the one that would otherwise produce a zero-byte
    /// movie: cutting out everything there is.
    #[test]
    fn cutting_away_the_whole_recording_is_refused() {
        assert!(cut_out(0.0, 40.0, 40.0).is_err());
        // And a cut cannot be planned at all without a known duration, because
        // the part after the second mark has no end to measure to.
        assert!(cut_out(1.0, 2.0, 0.0).is_err());
    }

    #[test]
    fn shortening_a_shortened_recording_does_not_stack_the_word_up() {
        assert_eq!(trimmed_stem("Recording 2026-08-17"), "Recording 2026-08-17 trimmed");
        assert_eq!(trimmed_stem("Recording 2026-08-17 trimmed"), "Recording 2026-08-17 trimmed");
    }

    /// The container is the source's. A trimmed `.mov` must not come back a
    /// `.mp4`, because that is what chooses the format written.
    #[test]
    fn the_output_keeps_the_source_container() {
        assert_eq!(container(Path::new("/x/Recording.mov")), "mov");
        assert_eq!(container(Path::new("/x/Screen.MP4")), "mp4");
        // Nothing to go on: a recording is a .mov everywhere else in Shotly.
        assert_eq!(container(Path::new("/x/Recording")), "mov");
        assert_eq!(scratch_path(Path::new("/x/R.mov")).unwrap().extension().unwrap(), "mov");
    }
}
