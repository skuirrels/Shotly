//! Starting and stopping the thing that writes the movie.
//!
//! `screencapture -v` does the recording, for the reasons `record.rs` gives:
//! it needs no permission Shotly does not already hold, and it costs none of
//! the frame-clock and codec decisions an owned pipeline would. What it costs
//! is control — there is no pause, and the only way to stop it is a signal.
//! Audio it does have: `-g` records the default input device alongside the
//! picture, which is the microphone and only the microphone. The sound the Mac
//! is *playing* is not on offer here at any price — that needs an owned
//! ScreenCaptureKit pipeline, which is the whole of what this module avoids.
//!
//! Everything about *what* to record, when to stop, and what to do with the
//! file afterwards is in `record.rs` and is the same on every platform. Only
//! the two calls below are not.

use std::process::{Child, Command};

/// Start recording `target` — a `screencapture` region, window or display
/// selector — into `path`.
///
/// `microphone` adds the default input device to the movie. It is passed as a
/// decision already made: whether the user asked for audio and whether macOS
/// will allow it are both settled before this is called, because the answer to
/// the second one is a dialog and this is no place to raise one.
pub fn start(
    target: &[String],
    path: &std::path::Path,
    microphone: bool,
) -> Result<Child, String> {
    Command::new("/usr/sbin/screencapture")
        .args(argv(target, path, microphone))
        .spawn()
        .map_err(|e| format!("could not start the recording: {e}"))
}

/// The command line, apart from the spawning, so it can be asserted on.
///
/// Worth separating for one flag: whether `-g` is there decides whether a
/// recording has sound, it is decided three layers up, and the only way to see
/// it on a running child is to read another process's argv.
fn argv(target: &[String], path: &std::path::Path, microphone: bool) -> Vec<String> {
    // `-x` is "no shutter sound", and says nothing about the recording's own
    // audio track — the two are unrelated, which is worth writing down because
    // the flags sit next to each other and read as though they fight.
    let mut args: Vec<String> = vec!["-v".into(), "-x".into()];
    if microphone {
        args.push("-g".into());
    }
    args.extend(target.iter().cloned());
    args.push(path.to_string_lossy().into_owned());
    args
}

#[cfg(test)]
mod tests {
    use super::argv;
    use std::path::Path;

    #[test]
    fn the_microphone_is_one_flag_and_only_when_asked() {
        let target = ["-R".to_string(), "0,0,320,200".to_string()];
        let path = Path::new("/tmp/take.mov");

        let silent = argv(&target, path, false);
        assert!(!silent.contains(&"-g".to_string()), "sound nobody asked for: {silent:?}");

        let heard = argv(&target, path, true);
        assert_eq!(heard.iter().filter(|a| *a == "-g").count(), 1, "{heard:?}");
        // The path stays last, and the target stays ahead of it: `screencapture`
        // reads the file to write as the trailing argument, so a flag inserted
        // in the wrong place would be read as the name of the movie.
        assert_eq!(heard.last().unwrap(), "/tmp/take.mov");
        assert!(heard.iter().position(|a| a == "-g") < heard.iter().position(|a| a == "-R"));
    }
}

/// Ask the recorder to stop, tidily.
///
/// `screencapture -v` writes the movie's index when it is interrupted, so
/// `SIGINT` is the **normal** way to end a recording rather than an abort.
/// `SIGKILL` leaves a file with frames in it and no way to play them, so
/// nothing may reach for it while the user still wants what was recorded.
pub fn interrupt(child: &Child) {
    // SAFETY: `kill(2)` with a pid this process owns and a signal number that
    // is always valid. The child is still owned by `Session`, so the pid cannot
    // have been reaped and reused underneath us.
    unsafe {
        libc::kill(child.id() as i32, libc::SIGINT);
    }
}
