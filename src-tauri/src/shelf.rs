//! Where a fresh capture lands when it isn't opening the editor.
//!
//! Nine screenshots out of ten are taken to be pasted somewhere, and for those
//! the editor is a whole window raised in front of what you were doing so that
//! you can press ⌘C and put it away again. The shelf is the alternative macOS
//! itself uses: the shot slides into the corner, sits there for a few seconds,
//! and goes. Click it to edit it, drag it into Slack, or ignore it — it is in
//! the library either way, exactly as it always was.
//!
//! # Why this files the capture itself
//!
//! Every other path hands the frame to the editor, which saves it into the
//! library on arrival. That cannot work here, because the whole point is that
//! the editor is never shown — and a webview in a hidden window runs no
//! JavaScript, so the editor would take the capture and quietly never file it.
//! So the frame is written into the library from here, with the same stamped
//! name every other capture gets.
//!
//! # Off by default
//!
//! It changes what pressing the capture key *does*, which is the one habit an
//! app like this must not rearrange under anyone. Settings → General has the
//! switch, and the shelf tells you where it is the first time it appears.

use std::sync::atomic::{AtomicU32, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::capture::Frame;
use crate::commands::CmdResult;

/// One shelf can be up at a time, but a new capture arriving while the last is
/// still fading needs a label the window server does not think is taken.
static NEXT: AtomicU32 = AtomicU32::new(1);

/// The largest a shelf gets, in points. A picture, not a preview of the file.
const MAX_WIDTH: f64 = 232.0;
const MAX_HEIGHT: f64 = 168.0;

/// How far the shelf sits from the corner of the screen.
///
/// Enough to read as floating over the desktop rather than stuck to it, and —
/// at the bottom — enough to clear a Dock that is set to its default size, on
/// the machines where the work area cannot be asked for.
const INSET: f64 = 24.0;
const DOCK_CLEARANCE: f64 = 96.0;

#[derive(Serialize, Deserialize, Default, Clone, Copy)]
struct Settings {
    enabled: bool,
}

fn store_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;
    Ok(dir.join("shelf.json"))
}

fn settings(app: &AppHandle) -> Settings {
    store_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Does a fresh capture go to the corner instead of to the editor?
#[tauri::command]
pub fn shelf_enabled(app: AppHandle) -> bool {
    settings(&app).enabled
}

#[tauri::command]
pub fn set_shelf_enabled(app: AppHandle, enabled: bool) -> CmdResult<()> {
    let path = store_path(&app)?;
    let raw = serde_json::to_string(&Settings { enabled }).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| format!("could not write {path:?}: {e}"))
}

/// Put a capture on the shelf, filing it into the library on the way.
///
/// Returns the library path. An error here means the caller should fall back to
/// opening the editor — a capture that cannot be shelved must not be a capture
/// that was lost.
pub fn place(app: &AppHandle, frame: &Frame) -> CmdResult<String> {
    let bytes = std::fs::read(&frame.path).map_err(|e| e.to_string())?;
    // Stamp the density, exactly as every other filing path does: without it a
    // Retina capture reopens as an image of mysteriously doubled dimensions.
    let bytes = crate::capture::cli::with_dpi(&bytes, frame.scale);
    let path = crate::commands::write_into_library(app, &bytes, &crate::commands::stamped_stem("Shotly"))?;

    show(app, &path)?;
    // The library grid is very likely on screen behind all this, and a capture
    // that does not appear in it until the next refresh looks like one that
    // was not saved.
    let _ = tauri::Emitter::emit_to(app, "editor", "library:changed", ());
    Ok(path)
}

/// Open the little window, sized to the picture and parked in the corner.
fn show(app: &AppHandle, path: &str) -> CmdResult<()> {
    // Only one at a time: a burst of captures should replace the thing in the
    // corner, not build a stack of them over the user's work.
    close_all(app);

    let (w, h) = image::image_dimensions(path).unwrap_or((1600, 1000));
    let (width, height) = fit(w as f64, h as f64);

    let label = format!("shelf-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let url = format!("shelf.html?src={}", crate::pin::urlencoding(path));

    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("Shotly")
        .inner_size(width, height)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(false)
        .shadow(false)
        .skip_taskbar(true)
        // The first click has to *do* something. A shelf that only comes
        // forward on the click meant to copy it would be worse than no shelf.
        .accept_first_mouse(true)
        // Deliberately never focused: this appears while the user is in
        // another app, and stealing their keyboard to show them a thumbnail
        // would be the rudest thing in the whole application.
        .focused(false)
        .build()
        .map_err(|e| format!("could not open the shelf: {e}"))?;

    if let Some((x, y)) = corner(app, width, height) {
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }
    // Over full-screen apps and on whatever Space the user is on — the same
    // treatment the recording panel gets, and for the same reason. See the
    // window-level table in docs/DEVELOPING.md.
    let _ = crate::platform::chrome::elevate_overlay_window(&window);
    Ok(())
}

/// The size to open at: the picture's own shape, inside the box above.
fn fit(width: f64, height: f64) -> (f64, f64) {
    if width <= 0.0 || height <= 0.0 {
        return (MAX_WIDTH, MAX_HEIGHT);
    }
    let scale = (MAX_WIDTH / width).min(MAX_HEIGHT / height);
    ((width * scale).max(64.0), (height * scale).max(48.0))
}

/// Bottom-right of the display the pointer is on, in logical points.
fn corner(app: &AppHandle, width: f64, height: f64) -> Option<(f64, f64)> {
    let monitor = app
        .monitor_from_point(
            crate::platform::pointer::cursor().map(|(x, _)| x).unwrap_or(0.0),
            crate::platform::pointer::cursor().map(|(_, y)| y).unwrap_or(0.0),
        )
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())?;

    let factor = monitor.scale_factor();
    let origin = monitor.position().to_logical::<f64>(factor);
    let size = monitor.size().to_logical::<f64>(factor);

    Some((
        origin.x + size.width - width - INSET,
        origin.y + size.height - height - DOCK_CLEARANCE,
    ))
}

/// Take the shelf down. Asked for by the page rather than done by it, so a
/// wedged webview can still be cleared from here.
#[tauri::command]
pub fn shelf_close(app: AppHandle, label: String) -> CmdResult<()> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("no shelf called {label}"))?;
    window.close().map_err(|e| e.to_string())
}

pub fn close_all(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with("shelf-") {
            let _ = window.close();
        }
    }
}

/// Open this capture in the editor, and take the shelf down.
///
/// The shelf's own click. It goes through here rather than through
/// `open_image` so that the window is gone before the editor comes up — two
/// things appearing at once, one of them on top of the other, reads as a
/// glitch.
#[tauri::command]
pub async fn shelf_edit(app: AppHandle, path: String) -> CmdResult<crate::commands::CaptureResult> {
    close_all(&app);
    crate::commands::open_image(app, path).await
}
