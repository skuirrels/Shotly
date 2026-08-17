//! Cutting the dead air off a recording.
//!
//! A screen recording almost always has a few seconds at each end that nobody
//! wants: reaching for the hotkey at the start, reaching back for it at the
//! end. This takes two marks on the timeline and writes out what is between
//! them, which covers trimming the front, the back, or both at once.
//!
//! # Why `avconvert`
//!
//! It is already on every Mac — the same bargain `capture::cli` and
//! `video::poster` make with `screencapture` and `qlmanage`. The alternative
//! was AVFoundation through `objc2`, which means owning an export session, a
//! completion handler and every codec decision, for an operation Apple already
//! ships as one command.
//!
//! # Why passthrough
//!
//! `PresetPassthrough` copies the samples across instead of decoding and
//! re-encoding them, so a trim is lossless and costs roughly what a file copy
//! costs: measured at two seconds to take thirty seconds out of a 334 MB
//! recording. Every other preset would re-encode a Retina capture — minutes of
//! fan noise, and a worse-looking file at the end of it.
//!
//! The cut lands exactly where it was asked to. Passthrough can only begin the
//! copied data at a sync sample, so the output carries an edit list that starts
//! playback at the requested instant inside it; the duration is exact to the
//! millisecond, not to the nearest keyframe.
//!
//! # What this deliberately does not do
//!
//! Snagit's timeline also offers **Cut Out** — remove the middle and close the
//! gap. That is two exports and a join, and nothing on macOS will join two
//! movies from the command line; it needs an `AVMutableComposition`, which is
//! the objc2 route this module exists to avoid. Removing a middle section is
//! also much the rarer ask for a screen recording. If it is ever wanted, this
//! is the module to grow, and the composition is the way to do it.
//!
//! # Why a new file
//!
//! The original is never touched. A screenshot can be taken again; the thing
//! that happened on screen for those thirty seconds cannot, and an overwrite
//! that took the wrong two seconds off would be unrecoverable. The trim lands
//! beside it as `<name> trimmed`, and the player switches to it, so sharing or
//! copying next picks up the short one.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::AppHandle;

/// macOS's own media converter.
const AVCONVERT: &str = "/usr/bin/avconvert";

/// Copy the samples rather than re-encode them. See the module docs.
const PRESET: &str = "PresetPassthrough";

/// The shortest trim worth making.
///
/// Below this the two handles are on top of each other and the answer would be
/// an empty file — which `avconvert` reports as a bare failure, so the check
/// belongs here where it can say what actually went wrong.
const MIN_SECONDS: f64 = 0.2;

/// How long the converter may take before it is assumed stuck.
///
/// Generous, because this is somebody else's process working on a file that
/// can be gigabytes on a disk that can be slow. It is not a performance
/// budget — passthrough is I/O-bound and finishes in seconds — it is the
/// guarantee that a wedged child cannot hold a Tauri worker thread forever.
const TIMEOUT: Duration = Duration::from_secs(600);

/// The suffix a trimmed recording is filed under.
const SUFFIX: &str = " trimmed";

/// Where the trim landed, in the shape the player needs to switch to it.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Trimmed {
    pub path: String,
    pub name: String,
    /// Running time of the new file, which is the length of the selection.
    pub seconds: f64,
}

/// Write the part of `path` between `start` and `end` into the library.
///
/// Both are in seconds from the beginning of the recording. The original is
/// left alone; the answer is a new capture beside it.
#[tauri::command]
pub fn video_trim(app: AppHandle, path: String, start: f64, end: f64) -> Result<Trimmed, String> {
    let source = PathBuf::from(&path);
    if !crate::video::is_video(&source) {
        return Err("that file is not a recording".into());
    }
    if !source.is_file() {
        return Err("that recording is no longer where the library left it".into());
    }

    // The movie's own header rather than whatever the page believed: the page
    // learns the duration from WebKit, and a selection is about to be turned
    // into a byte range. A file that will not measure gives zero, which `plan`
    // reads as "no known end" and trusts the marks instead.
    let whole = crate::video::probe(&source).map(|info| info.seconds).unwrap_or(0.0);
    let span = plan(start, end, whole)?;

    let scratch = scratch_path(&source)?;
    let converted = convert(&source, &scratch, span);
    if converted.is_err() {
        let _ = std::fs::remove_file(&scratch);
    }
    converted?;

    let stem = trimmed_stem(source.file_stem().and_then(|s| s.to_str()).unwrap_or("Recording"));
    let landed = crate::commands::move_into_library(&app, &scratch, &stem, &container(&source))?;
    let name = Path::new(&landed)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| stem.clone());

    Ok(Trimmed { path: landed, name, seconds: span.1 })
}

/// Turn two marks on the timeline into the `--start` and `--duration` to ask for.
///
/// Split out from the command because this is where a trim goes wrong in ways
/// worth naming — handles the wrong way round, a selection of nothing, a
/// selection that is the whole movie — and none of those need a file on disk
/// to test.
fn plan(start: f64, end: f64, whole: f64) -> Result<(f64, f64), String> {
    if !start.is_finite() || !end.is_finite() {
        return Err("those trim marks are not numbers".into());
    }

    let start = start.max(0.0);
    // `whole` is zero for a movie whose header would not measure; then the
    // marks are all there is to go on.
    let end = if whole > 0.0 { end.min(whole) } else { end };

    let seconds = end - start;
    if seconds < MIN_SECONDS {
        return Err(format!(
            "that selection is too short to keep — move the handles at least {MIN_SECONDS} seconds apart"
        ));
    }

    // Selecting the whole thing is not an error, it is a no-op, and quietly
    // producing a second identical copy of a 300 MB recording would be a
    // surprising way to answer it.
    if whole > 0.0 && start <= 0.0 && end >= whole - MIN_SECONDS {
        return Err("that selection is the whole recording — move a handle to trim something off".into());
    }

    Ok((start, seconds))
}

/// The name a trim is filed under, given the original's.
///
/// Trimming a trim gives `X trimmed` again rather than `X trimmed trimmed`;
/// the collision is then resolved by `free_name_in` into `X trimmed (2)`, which
/// is what someone tightening a cut twice would expect to see.
fn trimmed_stem(stem: &str) -> String {
    let base = stem.strip_suffix(SUFFIX).unwrap_or(stem);
    format!("{base}{SUFFIX}")
}

/// The container to write, which is always the one that came in.
///
/// `avconvert` chooses the output container from the output file's name, so
/// this is what stops a trimmed `.mov` coming back as a `.mp4` — a re-wrap
/// nobody asked for, of a file only meant to get shorter. Lower-cased because
/// it becomes a name in the library, and `Recording.MOV` beside `Recording.mov`
/// is a distinction nothing else in Shotly draws.
fn container(source: &Path) -> String {
    source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_else(|| "mov".into())
}

/// Somewhere to write the trim before it earns a place in the library.
fn scratch_path(source: &Path) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("shotly");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok(dir.join(format!("trim-{stamp}.{}", container(source))))
}

/// Run the converter over one span, and wait for it.
fn convert(source: &Path, dest: &Path, (start, seconds): (f64, f64)) -> Result<(), String> {
    let mut child = Command::new(AVCONVERT)
        .arg("--source")
        .arg(source)
        .arg("--output")
        .arg(dest)
        .args(["--preset", PRESET])
        .args(["--start", &format!("{start:.3}")])
        .args(["--duration", &format!("{seconds:.3}")])
        // We chose this path and nothing else writes there, so the only way it
        // exists is a same-millisecond collision — better replaced than fatal.
        .arg("--replace")
        // No pipes. `avconvert` answers a bad argument with its entire usage
        // text, which is not something to put in front of anyone; whether it
        // worked is answered below by the exit status and the file, the same
        // way `video::poster` reads QuickLook.
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not run the media converter: {e}"))?;

    let deadline = Instant::now() + TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Err(e) => return Err(format!("lost track of the media converter: {e}")),
        }
    };

    match status {
        Some(status) if status.success() && dest.is_file() => Ok(()),
        Some(_) => Err("the media converter could not trim that recording".into()),
        None => Err("the media converter took too long over that trim".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole chain, against the real converter and a real movie.
    ///
    /// Worth the two seconds it costs, because it is the only thing that can
    /// answer the question everything else here assumes: is what `avconvert`
    /// writes a file *Shotly* can still read? A trim that came back a hundred
    /// megabytes and unmeasurable would sail past every other test in this
    /// module and land in the library as a recording with no duration and no
    /// thumbnail. So this asks `video::probe` — the same code the library and
    /// the player use — rather than trusting the exit status.
    ///
    /// The fixture is the harness's twelve-second test pattern, found through
    /// `CARGO_MANIFEST_DIR` so the test does not depend on where it was run
    /// from. `avconvert` needs no guard: this is a macOS-only app, and macOS
    /// has shipped it for as long as it has shipped AVFoundation.
    #[test]
    fn a_trim_comes_back_as_a_movie_shotly_can_measure() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../harness/sample.mov");
        let dest = std::env::temp_dir().join("shotly-trim-test.mov");
        let _ = std::fs::remove_file(&dest);

        convert(&source, &dest, plan(2.5, 7.5, 12.0).unwrap()).expect("the converter should trim");

        let info = crate::video::probe(&dest).expect("a trim must be measurable");
        // Exact, not "near a keyframe": the edit list is what buys this, and
        // losing it to a preset change would show up here first.
        assert!((info.seconds - 5.0).abs() < 0.05, "{} seconds", info.seconds);
        // Passthrough copies the samples, so the picture is the one that
        // went in. A re-encode would be visible here as a resize.
        assert_eq!((info.width, info.height), (1280, 720));

        let _ = std::fs::remove_file(&dest);
    }

    #[test]
    fn a_selection_becomes_a_start_and_a_length() {
        // The ordinary case: three seconds of fumbling off the front, four off
        // the back of a forty-second recording.
        assert_eq!(plan(3.0, 36.0, 40.0), Ok((3.0, 33.0)));
        // A handle dragged past the end is clamped rather than refused; the
        // page's idea of the duration comes from WebKit and need not agree
        // with the header to the millisecond.
        assert_eq!(plan(3.0, 99.0, 40.0), Ok((3.0, 37.0)));
        // A movie the header would not measure still trims.
        assert_eq!(plan(1.0, 5.0, 0.0), Ok((1.0, 4.0)));
    }

    #[test]
    fn a_selection_of_nothing_is_refused_before_the_converter_sees_it() {
        // Handles on top of each other, and handles the wrong way round, are
        // the same mistake and get the same answer.
        assert!(plan(10.0, 10.0, 40.0).is_err());
        assert!(plan(30.0, 10.0, 40.0).is_err());
        assert!(plan(f64::NAN, 10.0, 40.0).is_err());
        assert!(plan(0.0, f64::INFINITY, 0.0).is_err());
    }

    /// Trimming nothing off would write a second copy of a file that can be
    /// hundreds of megabytes, under a name suggesting it had been shortened.
    #[test]
    fn keeping_the_whole_recording_is_refused_rather_than_duplicated() {
        assert!(plan(0.0, 40.0, 40.0).is_err());
        // Dragged a hair short of the end, on purpose: still a trim.
        assert_eq!(plan(0.0, 39.0, 40.0), Ok((0.0, 39.0)));
    }

    #[test]
    fn trimming_a_trim_does_not_stack_the_word_up() {
        assert_eq!(trimmed_stem("Recording 2026-08-17 at 21.27.34"), "Recording 2026-08-17 at 21.27.34 trimmed");
        assert_eq!(trimmed_stem("Recording 2026-08-17 at 21.27.34 trimmed"), "Recording 2026-08-17 at 21.27.34 trimmed");
    }

    /// The container is the source's. Trimming a `.mov` must not quietly hand
    /// back a `.mp4`, because `avconvert` picks the container from the name.
    #[test]
    fn the_output_keeps_the_source_container() {
        assert_eq!(container(Path::new("/x/Recording.mov")), "mov");
        assert_eq!(container(Path::new("/x/Screen.MP4")), "mp4");
        // Nothing to go on: a recording is a .mov everywhere else in Shotly.
        assert_eq!(container(Path::new("/x/Recording")), "mov");

        assert_eq!(scratch_path(Path::new("/x/Recording.mov")).unwrap().extension().unwrap(), "mov");
    }
}
