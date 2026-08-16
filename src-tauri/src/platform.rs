//! Small AppKit escapes for things Tauri's cross-platform API can't express.

#[cfg(target_os = "macos")]
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

#[cfg(not(target_os = "macos"))]
pub fn elevate_overlay_window(_window: &tauri::WebviewWindow) -> Result<(), String> {
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
#[cfg(target_os = "macos")]
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

#[cfg(not(target_os = "macos"))]
pub fn follow_active_space(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

/// Hide the Dock icon so Shotly lives in the menu bar, the way capture tools
/// are expected to. Called when the editor window closes.
#[cfg(target_os = "macos")]
pub fn set_accessory_mode(app: &tauri::AppHandle, accessory: bool) {
    use tauri::ActivationPolicy;
    let _ = app.set_activation_policy(if accessory {
        ActivationPolicy::Accessory
    } else {
        ActivationPolicy::Regular
    });
}

#[cfg(not(target_os = "macos"))]
pub fn set_accessory_mode(_app: &tauri::AppHandle, _accessory: bool) {}
