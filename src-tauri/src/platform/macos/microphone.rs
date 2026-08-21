//! Whether Shotly may listen, and asking if it may not.
//!
//! Only the *permission* is here. Nothing in this file records anything: the
//! microphone is opened by `screencapture -g`, which is a child process, and
//! macOS attributes its access to whoever is responsible for it — us. So the
//! prompt is Shotly's to raise, the switch in the app is Shotly's to explain,
//! and `Info.plist` carries the sentence the system shows.
//!
//! Asked at the switch rather than at the shutter. A permission dialog that
//! appears the instant a recording starts is a dialog on top of the thing
//! being recorded, and one that has to be answered while the clock runs.

use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaType, AVMediaTypeAudio};

/// What the system says about listening.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// Never asked. Asking is what `request` is for.
    Undecided,
    Granted,
    /// Refused, or forbidden by policy. Only System Settings can undo it.
    Denied,
}

/// The constant AVFoundation uses to mean "sound".
///
/// Optional in the bindings because a framework constant can in principle be
/// missing at runtime. If it ever were there is no media type to ask about and
/// no honest answer but "not allowed" — which every caller here already
/// handles, because it is what a refusal looks like.
fn audio() -> Option<&'static AVMediaType> {
    // SAFETY: a constant string AVFoundation owns for the life of the process.
    unsafe { AVMediaTypeAudio }
}

pub fn access() -> Access {
    let Some(audio) = audio() else { return Access::Denied };
    // SAFETY: a class method taking one of the two media types it documents.
    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) };
    match status {
        AVAuthorizationStatus::Authorized => Access::Granted,
        AVAuthorizationStatus::NotDetermined => Access::Undecided,
        // Restricted is a Denied that the user cannot lift themselves. There
        // is nothing Shotly can offer either way, so it says the same thing.
        _ => Access::Denied,
    }
}

/// Ask, if there is anything to ask.
///
/// Returns immediately: AVFoundation puts the dialog up and answers on a queue
/// of its own. Nothing here waits for it, because the caller is a command on
/// the main thread and the answer can take as long as a person takes. Whoever
/// needs to know reads `access` again afterwards.
pub fn request() {
    if access() != Access::Undecided {
        return;
    }
    let Some(audio) = audio() else { return };
    let handler = block2::RcBlock::new(|_granted: objc2::runtime::Bool| {});
    // SAFETY: the media type is one of the two documented constants, and the
    // block is retained by AVFoundation for as long as it needs it.
    unsafe {
        AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &handler);
    }
}
