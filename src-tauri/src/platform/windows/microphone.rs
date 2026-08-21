//! Whether Shotly may listen — on Windows.
//!
//! Windows has the same idea under a different name: Settings → Privacy →
//! Microphone, backed by `AppCapability`/`MediaCapture`. The check is
//! `AppCapability::Create("microphone")->CheckAccess()`, and the ask is
//! `MediaCapture::InitializeAsync` with an audio-only settings object, which
//! raises the consent dialog the first time.
//!
//! Neither is worth writing before the recorder is: `recorder::start` on this
//! platform still returns "not implemented yet", and a permission this app
//! cannot yet use is a dialog with nothing behind it. Until then the honest
//! answer is that the app has not been given access, which keeps the switch in
//! the UI off and the recording silent rather than pretending otherwise.
//!
//! See `docs/WINDOWS.md`.

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Undecided,
    Granted,
    Denied,
}

pub fn access() -> Access {
    Access::Denied
}

pub fn request() {}
