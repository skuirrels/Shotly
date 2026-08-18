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
//! # Why a cut resumes later than you asked
//!
//! A passthrough export cannot re-encode, so the samples of a segment that
//! begins anywhere but time zero are copied from the previous sync sample
//! onwards — the first frame cannot be decoded otherwise — and the run-up is
//! then hidden behind an edit list rather than deleted. Measured on a real
//! recording: cutting 4s out of the middle left **0.92 seconds of the cut
//! footage in the file**, invisible in every player that honours edit lists,
//! recoverable from any that does not. For an operation whose whole point is
//! "remove the bit I did not want seen", that is the wrong answer.
//!
//! Snapping the segment onto a sync sample does *not* fix it, which was worth
//! finding out the hard way: AVFoundation copies from the sync sample *before*
//! the one a segment starts on, even when the segment starts exactly on one.
//! Measured — a segment beginning at 8.120, itself a keyframe, had its media
//! copied from 7.085, the keyframe before it. The hidden run-up therefore
//! always ends exactly at the segment start, which is exactly the edge of what
//! was removed. Its position cannot be argued with; only the segment start can
//! be moved.
//!
//! So a cut resumes two sync samples past the first one at or after the mark.
//! That is the nearest point at which the run-up provably cannot reach back
//! past the mark — `resume` sets out the argument. It costs up to three
//! keyframe intervals, about three seconds for `screencapture -v`, which
//! writes one a second. The player draws the real extent, because a cut that
//! quietly took seconds more than the handle showed would be its own kind of
//! lie.
//!
//! Only **Cut** pays this. Trimming with **Keep** discards the ends, where the
//! hidden run-up is the dead air being trimmed off — nothing anybody is trying
//! to get rid of, and not worth two seconds of the part they wanted.
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

/// The instants a mark may sit on, in seconds — the recording's sync samples.
///
/// The page asks once, when the scissors are pressed, and snaps its handles to
/// these for as long as they are on screen. That is what keeps the mark you can
/// see and the mark that is used the same number; see the module docs for what
/// happens when they differ.
///
/// Costs about 17 ms on a seven-minute recording, and under a millisecond on a
/// short one — but `spawn_blocking` all the same, because it reads a file and
/// this is not the module to make that mistake in twice.
#[tauri::command]
pub async fn video_sync_points(path: String) -> Result<Vec<f64>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::compose::sync_points(Path::new(&path)))
        .await
        .map_err(|e| format!("could not read that recording's keyframes: {e}"))
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
    let keep = plan(mode, start, end, whole, &crate::compose::sync_points(&source))?;
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
fn plan(
    mode: Mode,
    start: f64,
    end: f64,
    whole: f64,
    sync: &[f64],
) -> Result<Vec<Segment>, String> {
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
            // No rounding here. What a Keep discards is the dead air at the
            // ends, so the run-up the export hides is dead air too — and
            // paying up to two seconds of the part someone wanted in order to
            // bury a second of what they did not is the wrong way round.
            vec![Segment { start, seconds: end - start }]
        }
        Mode::Cut => {
            if whole <= 0.0 {
                return Err("Shotly cannot measure that recording, so it cannot cut from the middle of it".into());
            }
            // The head begins at zero and so needs no run-up at all. The tail
            // is the one that does, and `resume` puts that run-up past the
            // mark. Nothing far enough along means there is no tail: the cut
            // runs to the end of the recording, and the empty second part is
            // dropped below.
            let resumes_at = resume(sync, end).unwrap_or(whole);
            vec![
                Segment { start: 0.0, seconds: start },
                Segment { start: resumes_at, seconds: whole - resumes_at },
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

/// Where a cut resumes, given the mark someone put the handle on.
///
/// **Two** sync samples past the first one at or after `mark`, and each step is
/// there for a reason worth keeping straight.
///
/// The export copies a hidden run-up before whatever keyframe the tail starts
/// on — measured at exactly one frame before it, on three cuts across two
/// recordings. So the run-up begins somewhere inside the keyframe interval
/// *before* the resume point. Call the first keyframe at or after the mark k0,
/// and the ones after it k1 and k2:
///
/// * Resuming at k1 puts the run-up inside `k0-1 .. k0` — before the mark.
///   Measured: marking 7.103 (itself a keyframe) left 15 ms of the marked
///   footage in the file.
/// * Resuming at k2 puts it inside `k0 .. k1`. A sample cannot begin before the
///   keyframe preceding it, so the run-up cannot begin before k0 — and k0 is at
///   or after the mark. Nothing marked survives, whatever the frame rate.
///
/// The second step is what makes that an argument rather than a measurement. A
/// guard of "one frame" would have worked on these recordings and quietly
/// failed on a slower one.
///
/// `None` when the recording has no sync sample far enough along — the mark is
/// near the end — which the caller reads as "there is no tail worth keeping".
///
/// `None` when the recording has no sync sample far enough along — the mark is
/// near the end — which the caller reads as "there is no tail worth keeping".
///
/// Kept as a function of the *mark* rather than of its own output, because it
/// is deliberately not idempotent: feeding it a resume point would step past it
/// again. The mark is the thing to hold on to, which is also why the player
/// leaves its handle where it was put and draws the resume point separately.
fn resume(points: &[f64], mark: f64) -> Option<f64> {
    /// The page hands back numbers that have been through JSON; a mark meant to
    /// sit on a sync sample can come back a hair either side of it.
    const EPSILON: f64 = 0.001;

    let k0 = points.iter().copied().find(|p| *p >= mark - EPSILON)?;
    let k1 = points.iter().copied().find(|p| *p > k0 + EPSILON)?;
    points.iter().copied().find(|p| *p > k1 + EPSILON)
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

    /// A keyframe every second, which is what `screencapture -v` writes.
    fn grid() -> Vec<f64> {
        (0..=40).map(|n| n as f64).collect()
    }
    /// No sync samples at all: a recording that would not give them up.
    const NONE: &[f64] = &[];

    fn keep(start: f64, end: f64, whole: f64) -> Result<Vec<Segment>, String> {
        plan(Mode::Keep, start, end, whole, &grid())
    }
    fn cut_out(start: f64, end: f64, whole: f64) -> Result<Vec<Segment>, String> {
        plan(Mode::Cut, start, end, whole, &grid())
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
    /// which `compose` joins into one movie with the gap closed. The tail
    /// resumes past the mark — see `a_cut_resumes_past_its_own_hidden_run_up`.
    #[test]
    fn cutting_the_middle_out_leaves_the_two_ends() {
        assert_eq!(cut_out(10.0, 20.0, 40.0), Ok(vec![seg(0.0, 10.0), seg(22.0, 18.0)]));
    }

    /// A cut against one end of the recording is a trim, and must come out as
    /// one part rather than one part and a sliver.
    #[test]
    fn a_cut_that_reaches_an_end_is_simply_a_trim() {
        // Nothing before the first mark: only the tail survives, resuming past
        // the mark as every cut does.
        assert_eq!(cut_out(0.0, 12.0, 40.0), Ok(vec![seg(14.0, 26.0)]));
        // Nothing after the second: only the head — which is never rounded,
        // because a segment starting at zero needs no run-up.
        assert_eq!(cut_out(28.0, 40.0, 40.0), Ok(vec![seg(0.0, 28.0)]));
        // A head too short to be worth a frame is dropped, not written.
        assert_eq!(cut_out(0.05, 12.0, 40.0), Ok(vec![seg(14.0, 26.0)]));
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
    /// A cut resumes one keyframe past the first one after the mark — and the
    /// second step is the entire point. The export's hidden run-up spans the
    /// keyframe before the resume point up to it, so one step would leave that
    /// run-up sitting *behind* the mark, holding the tail of the very footage
    /// someone pointed at and asked to lose.
    #[test]
    fn a_cut_resumes_past_its_own_hidden_run_up() {
        // Marked 20.2. k0 is 21, so the tail resumes at k2 = 23 and the run-up
        // lies inside 21..22 — every bit of it later than the mark.
        assert_eq!(cut_out(10.4, 20.2, 40.0), Ok(vec![seg(0.0, 10.4), seg(23.0, 17.0)]));
        // A mark sitting exactly on a keyframe is the case that caught this:
        // with one step the run-up reached 15 ms back past the mark on a real
        // recording. k0 is 20 itself, so the tail resumes at 22.
        assert_eq!(cut_out(10.0, 20.0, 40.0), Ok(vec![seg(0.0, 10.0), seg(22.0, 18.0)]));
    }

    /// Keep pays none of it. What a Keep throws away is the dead air at the
    /// ends, so the run-up the export hides is dead air — not worth up to two
    /// seconds of the part somebody actually wanted.
    #[test]
    fn keeping_never_rounds_a_mark() {
        assert_eq!(keep(3.4, 36.6, 40.0), Ok(vec![seg(3.4, 33.2)]));
        assert_eq!(keep(3.0, 36.0, 40.0), Ok(vec![seg(3.0, 33.0)]));
    }

    #[test]
    fn a_resume_point_is_two_keyframes_on_and_never_idempotent() {
        // k0 = 4, so k2 = 6.
        assert_eq!(resume(&grid(), 3.05), Some(6.0));
        // A mark on a keyframe: k0 is the mark itself, so k2 = 5.
        assert_eq!(resume(&grid(), 3.0), Some(5.0));
        // Deliberately not idempotent: fed its own answer it steps again, which
        // is why the mark is what gets stored and passed about, never this.
        assert_eq!(resume(&grid(), 5.0), Some(7.0));
        // Nothing far enough along: the caller reads that as "no tail left".
        // Nothing far enough along: two steps are needed, not one.
        assert_eq!(resume(&grid(), 39.5), None);
        assert_eq!(resume(&grid(), 38.5), None);
        assert_eq!(resume(NONE, 3.0), None);
    }

    /// A recording that will not give up its sync samples still trims, on the
    /// old terms. Refusing would be a worse answer than a run-up.
    #[test]
    fn a_recording_without_keyframe_information_is_still_trimmable() {
        assert_eq!(plan(Mode::Keep, 3.4, 36.6, 40.0, NONE), Ok(vec![seg(3.4, 33.2)]));
        // No keyframes means no resume point, so the cut runs to the end
        // rather than guessing at one — the safe way to be wrong.
        assert_eq!(plan(Mode::Cut, 10.4, 20.2, 40.0, NONE), Ok(vec![seg(0.0, 10.4)]));
    }

    /// A cut marked near the end has nowhere to resume, so there is no tail:
    /// the cut simply runs off the end of the recording.
    #[test]
    fn a_cut_with_no_room_to_resume_just_runs_to_the_end() {
        assert_eq!(cut_out(10.0, 39.5, 40.0), Ok(vec![seg(0.0, 10.0)]));
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



