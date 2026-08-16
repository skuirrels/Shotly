//! Captures stuck to the front of the screen.
//!
//! A pin is a small always-on-top window holding one image and nothing else.
//! It is for the times a screenshot is a *reference* rather than a document —
//! a design to copy, a number to retype, an error to work through — where the
//! alternative is switching windows every few seconds and losing your place.

use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Pins are never reused, so every one needs a label of its own.
static NEXT: AtomicU32 = AtomicU32::new(1);

/// How much of the screen a new pin may take up before it is scaled down.
///
/// A full-screen capture pinned at its own size would cover the thing it is
/// meant to be helping with, which rather defeats the point.
const MAX_SCREEN_FRACTION: f64 = 0.45;

/// Small enough to be fiddly to grab. Nothing may open below this.
const MIN_EDGE: f64 = 120.0;

/// Put an image on screen, above everything.
#[tauri::command]
pub fn pin_open(app: AppHandle, path: String) -> Result<String, String> {
    let label = format!("pin-{}", NEXT.fetch_add(1, Ordering::Relaxed));

    // Measured here rather than asked of the page: reading a PNG header costs
    // nothing, where the page would have to load the whole image through the
    // asset protocol first — and be allowed to, which is a scope away from
    // being true for a path outside the library.
    let (w, h) = image::image_dimensions(&path)
        .map_err(|e| format!("could not read {path}: {e}"))?;
    let (width, height) = fit(&app, w as f64, h as f64);

    let url = format!("pin.html?src={}", urlencoding(&path));
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("Shotly Pin")
        .inner_size(width, height)
        .min_inner_size(MIN_EDGE, MIN_EDGE)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(true)
        // Its own window in the switcher would be noise: a pin is a thing on
        // the screen, not a document you tab to.
        .skip_taskbar(true)
        // So the first click on a pin that isn't focused does something,
        // rather than only bringing it forward.
        .accept_first_mouse(true)
        .build()
        .map_err(|e| format!("could not open the pin: {e}"))?;

    let _ = window.set_focus();
    Ok(label)
}

/// The size to open at: the image's own, unless that is too much screen.
fn fit(app: &AppHandle, width: f64, height: f64) -> (f64, f64) {
    let logical = |w: f64, h: f64| (w.max(MIN_EDGE), h.max(MIN_EDGE));
    if width <= 0.0 || height <= 0.0 {
        return (480.0, 320.0);
    }

    // Captures are retina, so their pixel size is twice what belongs on
    // screen. Halving first means a pin opens at the size the thing was
    // when it was photographed.
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(2.0);
    let (mut w, mut h) = (width / scale, height / scale);

    if let Ok(Some(monitor)) = app.primary_monitor() {
        let size = monitor.size().to_logical::<f64>(monitor.scale_factor());
        let limit = MAX_SCREEN_FRACTION;
        let shrink = (size.width * limit / w).min(size.height * limit / h).min(1.0);
        w *= shrink;
        h *= shrink;
    }

    logical(w, h)
}

/// Percent-encode a filesystem path for use in a query string.
///
/// Hand-rolled rather than pulling in a crate for it: the set of characters
/// that matter in a macOS path is small, and spaces are the only one that
/// turns up in practice — every capture Shotly files has three of them.
fn urlencoding(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// Pin pixels that are not on disk yet — the editor's view, annotations and
/// all.
///
/// Written to the scratch directory rather than the library: a pin is a thing
/// on the screen for the next few minutes, and filing a copy of every one of
/// them beside real captures would turn the library into a junk drawer. The
/// file outlives the pin, and goes when the machine clears its temp folder.
#[tauri::command]
pub fn pin_png(app: AppHandle, bytes: Vec<u8>) -> Result<String, String> {
    let dir = std::env::temp_dir().join("shotly");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("pin-{stamp}.png"));
    std::fs::write(&path, bytes).map_err(|e| format!("could not write {path:?}: {e}"))?;

    pin_open(app, path.to_string_lossy().into_owned())
}

/// Close one pin.
///
/// The page asks for this rather than closing itself, so that a pin whose
/// webview has wedged can still be shut from the tray.
#[tauri::command]
pub fn pin_close(app: AppHandle, label: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("no pin called {label}"))?;
    window.close().map_err(|e| e.to_string())
}

/// Close every pin at once — the tray's way out of a screen full of them.
pub fn close_all(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with("pin-") {
            let _ = window.close();
        }
    }
}

#[tauri::command]
pub fn pin_close_all(app: AppHandle) {
    close_all(&app);
}
