//! Small AppKit escapes for things Tauri's cross-platform API can't express.
//!
//! The macOS half of `platform::chrome`. Its opposite number is
//! `platform/windows/chrome.rs`, and `platform/mod.rs` picks between them —
//! which is why nothing in here carries a `cfg` of its own any more.

pub fn elevate_overlay_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};

    let ptr = window.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
    if ptr.is_null() {
        return Err("window has no backing NSWindow".into());
    }

    // SAFETY: Tauri hands us a live NSWindow for this webview, and we only touch
    // it from the main thread — Tauri's setup hook and command handlers for
    // window operations both run there.
    unsafe {
        let ns = &*ptr;

        // `alwaysOnTop` maps to NSFloatingWindowLevel (3), which still sits
        // below the menu bar (24) and Dock (20). Screen-saver level puts the
        // selection overlay above everything, which is the whole point.
        ns.setLevel(objc2_app_kit::NSScreenSaverWindowLevel);

        // Stay put when the user switches Spaces, and show over other apps'
        // fullscreen windows instead of triggering a Space switch.
        ns.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );

        // A transparent overlay must not paint a background or cast a shadow,
        // or the dimmed backdrop picks up a visible rectangular edge.
        ns.setOpaque(false);
        ns.setHasShadow(false);
    }

    Ok(())
}

/// Show a window on whatever Space the user is on, without moving it up the
/// window order.
///
/// The quieter half of `elevate_overlay_window`, and the right amount for a
/// window that covers a display and takes the mouse. Such a window created
/// while a full-screen app is in front lands on the desktop Space instead:
/// invisible, unreachable, and — because macOS suspends the WebView of a
/// window that is never composited — unable to report that it painted, which
/// its own watchdog then reads as a hung renderer.
///
/// What this deliberately does *not* do is raise the level. A full-screen
/// click target above the menu bar is a full-screen click target with the tray
/// behind it, and the tray is one of the ways out of an overlay that has
/// stopped answering. Small always-on-top panels are the ones that earn
/// `elevate_overlay_window`.
pub fn show_on_every_space(window: &tauri::WebviewWindow) -> Result<(), String> {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};

    let ptr = window.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
    if ptr.is_null() {
        return Err("window has no backing NSWindow".into());
    }

    // SAFETY: as `elevate_overlay_window` — a live NSWindow from Tauri, touched
    // only from the main thread.
    unsafe {
        (*ptr).setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
    }

    Ok(())
}

/// Keep a window out of screen recordings and screen sharing.
///
/// `NSWindowSharingNone` is the flag the window server itself honours: the
/// window is composited for the person sitting there and left out of anything
/// that reads the screen, `screencapture` included. It is what lets the
/// recording panel sit over the display it is recording — a panel you have to
/// hide before pressing stop is a panel that has to be somewhere else the
/// moment you want it, and a stop button nobody can find is worse than a
/// visible one.
pub fn hide_from_capture(window: &tauri::WebviewWindow) -> Result<(), String> {
    use objc2_app_kit::{NSWindow, NSWindowSharingType};

    let ptr = window.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
    if ptr.is_null() {
        return Err("window has no backing NSWindow".into());
    }

    // SAFETY: as `elevate_overlay_window` — a live NSWindow from Tauri, touched
    // only from the main thread.
    unsafe {
        (*ptr).setSharingType(NSWindowSharingType::None);
    }

    Ok(())
}

/// Let a window follow the user between Spaces.
///
/// Shotly lives in the menu bar, which means it spends most of its life as an
/// *accessory* application — and an accessory does not take part in the Space
/// switching that ordinary apps get for free. Its window stays on whichever
/// Space it was last used on, and asking macOS to activate the app there does
/// not bring you to it: the app comes to the front, takes the keyboard, and
/// shows you nothing at all.
///
/// Measured, because it looked for all the world like a launch that hung.
/// Opening Shotly from Spotlight while on another Space spawned the process,
/// checked it in, gave it keyboard focus — and its window reported
/// `onscreen=false` throughout. Nothing was wrong with the launch; the window
/// was simply somewhere else.
///
/// `MoveToActiveSpace` is the answer a menu-bar utility wants: there is one
/// window and it belongs wherever you are, rather than to the desk you happened
/// to open it on.
pub fn follow_active_space(window: &tauri::WebviewWindow) -> Result<(), String> {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};

    let ptr = window.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
    if ptr.is_null() {
        return Err("window has no backing NSWindow".into());
    }

    // SAFETY: as `elevate_overlay_window` — a live NSWindow from Tauri, touched
    // only from the main thread.
    unsafe {
        (*ptr).setCollectionBehavior(NSWindowCollectionBehavior::MoveToActiveSpace);
    }

    Ok(())
}

/// Hide the Dock icon so Shotly lives in the menu bar, the way capture tools
/// are expected to. Called when the editor window closes.
pub fn set_accessory_mode(app: &tauri::AppHandle, accessory: bool) {
    use tauri::ActivationPolicy;
    let _ = app.set_activation_policy(if accessory {
        ActivationPolicy::Accessory
    } else {
        ActivationPolicy::Regular
    });
}
