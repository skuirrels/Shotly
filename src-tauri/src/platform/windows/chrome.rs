//! What the five window-chrome escapes do on a platform that has no AppKit.
//!
//! Every one of them is a no-op, and that is the right answer rather than a
//! placeholder: `elevate_overlay_window` and friends exist to talk macOS out of
//! its own defaults — window levels, Spaces membership, the Dock icon — and
//! Windows has no equivalent default to argue with. Where it *does* have one,
//! it is named here so the port has somewhere to put it.
//!
//! See `docs/WINDOWS.md`.

pub fn elevate_overlay_window(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

pub fn show_on_every_space(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

/// The one that will not stay a no-op.
///
/// `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` is an exact
/// counterpart to `NSWindowSharingType::None` — the compositor shows the window
/// to the person at the machine and leaves it out of anything that reads the
/// screen. It is what will let the recording HUD go on sitting over the display
/// it is recording. Windows 10 2004 and later.

pub fn hide_from_capture(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

pub fn follow_active_space(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

pub fn set_accessory_mode(_app: &tauri::AppHandle, _accessory: bool) {}
