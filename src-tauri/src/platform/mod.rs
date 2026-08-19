//! The line between what Shotly does and what an operating system does.
//!
//! Everything above this module is shared: the editor, the capture pipeline's
//! geometry, the session loops, the stitcher, the naming, the library. What
//! lives below it is whatever each platform needs to be asked in its own
//! language — AppKit and CoreGraphics on one side, Win32 and WinRT on the
//! other — and the two are never mixed in one file.
//!
//! # The rule
//!
//! **A `cfg(target_os)` above this module wants to be a function in it.** The
//! point of collecting them here is that portability becomes a property of one
//! directory rather than a habit everybody has to keep up, and a reviewer can
//! see the whole platform surface by listing one folder.
//!
//! Two sites outside this directory still carry one, and neither is an
//! abstraction waiting to be written:
//!
//! * **`capture/`** is its own seam already — `CaptureBackend` is a trait with
//!   a swappable implementation, which is the same idea arrived at earlier.
//!   Folding it in here is worth doing and is not urgent.
//! * **`share::gauth`'s keychain migration**, which is not an abstraction with
//!   two implementations — it is a one-time rescue of sign-ins from a store
//!   only macOS ever had. There is nothing for another platform to implement.
//!
//! Anything else that finds itself wanting a `cfg` wants a function in here.
//!
//! # What is in it
//!
//! One submodule per concern, each with the same shape: the macOS
//! implementation, the Windows implementation, and nothing else. The names
//! are deliberately about the job rather than the API doing it —
//! `chrome::hide_from_capture` says what the caller wants, and whether that is
//! `NSWindowSharingType` or `SetWindowDisplayAffinity` is this module's
//! business alone.
//!
//! See `docs/WINDOWS.md` for what each one costs to implement.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(not(target_os = "macos"))]
mod windows;
#[cfg(not(target_os = "macos"))]
pub use windows::*;
