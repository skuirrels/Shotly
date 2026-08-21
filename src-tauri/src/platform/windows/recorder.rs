//! Starting and stopping the thing that writes the movie — on Windows.
//!
//! **The largest single item in the port**, and the one with no shortcut. See
//! `docs/WINDOWS.md`: there is no `screencapture -v`, so the replacement is
//! Windows Graphics Capture feeding a Media Foundation `SinkWriter` — a frame
//! clock, an H.264 encoder configuration and a mux, which is precisely the
//! work `record.rs` was written to avoid owning.
//!
//! Two things change for the design above this module, and both are
//! improvements that have to be *claimed* rather than inherited:
//!
//! * **Stopping is a call, not a signal.** `SinkWriter::Finalize` writes the
//!   index, and it either succeeds or reports why. No signal, no deadline, no
//!   "did it get the chance to write the moov atom".
//! * **The frame clock is ours.** Which means dropped frames and variable
//!   frame rate become Shotly's problem for the first time — and also that the
//!   keyframe interval is a choice, which is what makes an exact cut cheap.
//!
//! Audio is a third thing this platform has to choose rather than inherit.
//! `screencapture -g` gives macOS the default input device for free; here the
//! microphone is a `MediaCapture` audio source feeding a second `SinkWriter`
//! stream, which at least means the sound the machine is *playing* — WASAPI
//! loopback — is no harder to add than the microphone was. On macOS that one
//! is out of reach without owning the pipeline.
//!
//! Because there is no child process, `Child` is the wrong shape here and the
//! signature will have to change when this is implemented — a `Recording`
//! handle owning the capture session and the writer. `record.rs` holds its
//! `Session` behind a mutex already, so that is a contained change.

use std::process::Child;

pub fn start(
    _target: &[String],
    _path: &std::path::Path,
    _microphone: bool,
) -> Result<Child, String> {
    Err("screen recording is not implemented on this platform yet".into())
}

pub fn interrupt(_child: &Child) {}
