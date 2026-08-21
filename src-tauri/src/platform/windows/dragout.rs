//! Dragging a capture out of the window, on a platform that is not macOS.
//!
//! A no-op today, and unlike most of this directory it is a placeholder rather
//! than the right answer: Windows has the same gesture and the same
//! expectation. `DoDragDrop` with an `IDataObject` carrying `CF_HDROP` is the
//! counterpart, started from the drag-detect that the web view would otherwise
//! swallow.
//!
//! Reporting failure rather than success on purpose. A silent `Ok` here would
//! mean a thumbnail that reports "dragged" and does nothing, which is worse
//! than a caller that can tell the user the gesture is not available yet.
//!
//! See `docs/WINDOWS.md`.

pub fn begin_file_drag(_window: &tauri::WebviewWindow, _paths: &[String]) -> Result<(), String> {
    Err("dragging files out is not implemented on this platform yet".into())
}
