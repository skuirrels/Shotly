//! Starting and stopping the thing that writes the movie.
//!
//! `screencapture -v` does the recording, for the reasons `record.rs` gives:
//! it needs no permission Shotly does not already hold, and it costs none of
//! the frame-clock and codec decisions an owned pipeline would. What it costs
//! is control — there is no pause, no audio worth having, and the only way to
//! stop it is a signal.
//!
//! Everything about *what* to record, when to stop, and what to do with the
//! file afterwards is in `record.rs` and is the same on every platform. Only
//! the two calls below are not.

use std::process::{Child, Command};

/// Start recording `target` — a `screencapture` region, window or display
/// selector — into `path`.
pub fn start(target: &[String], path: &std::path::Path) -> Result<Child, String> {
    let mut args: Vec<String> = vec!["-v".into(), "-x".into()];
    args.extend(target.iter().cloned());
    args.push(path.to_string_lossy().into_owned());

    Command::new("/usr/sbin/screencapture")
        .args(&args)
        .spawn()
        .map_err(|e| format!("could not start the recording: {e}"))
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
