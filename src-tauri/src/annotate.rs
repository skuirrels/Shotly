//! Live screen annotation — draw over the desktop while screen-sharing.
//!
//! # Safety model
//!
//! This is a full-screen transparent window that deliberately *accepts* mouse
//! input, which is the most dangerous shape of window on macOS: get it wrong and
//! the desktop becomes unusable with force-quitting as the only escape. That
//! happened repeatedly with an earlier overlay, so every property here is a
//! deliberate guard rather than an accident:
//!
//! * **Floating window level, not screen-saver level.** It sits above ordinary
//!   app windows but *below* the menu bar and Dock, so those stay clickable.
//!   There is always a route to the tray icon that does not involve this
//!   window's own code.
//! * **Mouse-transparent until the page confirms it painted.** An unpainted
//!   annotation layer passes clicks straight through to whatever is beneath.
//! * **Heartbeat.** The page pings once a second; if it goes quiet the window is
//!   destroyed. This is what catches a hung or crashed renderer.
//! * **Destroyed on exit, never hidden.** A closed window cannot swallow a
//!   click, and rebuilding it fresh each time avoids the suspended-webview trap
//!   that a hidden WKWebView falls into.
//! * **A global hotkey owned by Rust** toggles it, so the escape route works
//!   even if the page is completely dead.

use crate::capture::display;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "annotate";

/// How long the page may go silent before we assume it has died.
const HEARTBEAT_GRACE: Duration = Duration::from_secs(3);
/// How long it may take to paint before we give up on it.
const READY_GRACE: Duration = Duration::from_secs(3);

#[derive(Default)]
pub struct AnnotateState {
    /// Last heartbeat from the page. `None` while it has yet to report ready.
    pub last_beat: Mutex<Option<Instant>>,
}

fn state_beat(app: &AppHandle) -> Option<Instant> {
    let state = app.state::<AnnotateState>();
    let beat = *state.last_beat.lock().unwrap();
    beat
}

/// Tear the annotation layer down. Safe to call at any time, from any thread.
pub fn stop(app: &AppHandle) {
    {
        let state = app.state::<AnnotateState>();
        *state.last_beat.lock().unwrap() = None;
    }

    if let Some(window) = app.get_webview_window(LABEL) {
        // Surrender the mouse first: if `close` somehow fails, the desktop is
        // still usable rather than covered by an invisible click target.
        let _ = window.set_ignore_cursor_events(true);
        let _ = window.close();
    }
}

pub fn is_active(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL).is_some()
}

/// Toggle the annotation layer.
pub fn toggle(app: &AppHandle) -> Result<(), String> {
    eprintln!("[annotate] toggle called; active={}", is_active(app));
    if is_active(app) {
        stop(app);
        return Ok(());
    }
    start(app)
}

fn start(app: &AppHandle) -> Result<(), String> {
    let displays = display::displays().map_err(|e| e.to_string())?;

    // Cover the primary display only, not the whole virtual desktop.
    //
    // Spanning every screen sounds more capable but is worse in practice: a
    // secondary monitor placed above or left of the primary gives the desktop
    // negative coordinates, and macOS clamps windows out of that region — which
    // silently shifts the whole surface and pushes the toolbar off-screen. You
    // also only ever share one screen at a time. One display keeps the geometry
    // trivially correct and the window smaller.
    let target = displays
        .iter()
        .find(|d| d.is_primary)
        .or_else(|| displays.first())
        .ok_or("no displays")?;
    let bounds = target.bounds;
    eprintln!("[annotate] start: covering primary display {bounds:?}");

    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("annotate.html".into()))
        .title("Shotly Annotation")
        .position(bounds.x, bounds.y)
        .inner_size(bounds.width, bounds.height)
        .decorations(false)
        .transparent(true)
        // Floating level — above app windows, below the menu bar and Dock. Do
        // not raise this; the reachable menu bar is a safety property.
        .always_on_top(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .accept_first_mouse(true)
        .visible(true)
        .build()
        .inspect_err(|e| eprintln!("[annotate] window build FAILED: {e}"))
        .map_err(|e| e.to_string())?;
    eprintln!("[annotate] window built; url={:?}", window.url().map(|u| u.to_string()));

    // Clicks pass through until the page says it has drawn something.
    window.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;

    eprintln!("[annotate] window is up and mouse-transparent; awaiting paint");
    watch(app);
    Ok(())
}

/// The page has painted: hand it the mouse and the keyboard.
pub fn mark_ready(app: &AppHandle) -> Result<(), String> {
    eprintln!("[annotate] page reported ready");
    let window = app.get_webview_window(LABEL).ok_or("annotation layer is not open")?;

    {
        let state = app.state::<AnnotateState>();
        *state.last_beat.lock().unwrap() = Some(Instant::now());
    }

    window.set_ignore_cursor_events(false).map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    Ok(())
}

pub fn beat(app: &AppHandle) {
    let state = app.state::<AnnotateState>();
    *state.last_beat.lock().unwrap() = Some(Instant::now());
}

/// Let clicks fall through to the app underneath without leaving annotation
/// mode — needed constantly in a real screen share.
pub fn set_click_through(app: &AppHandle, on: bool) -> Result<(), String> {
    let window = app.get_webview_window(LABEL).ok_or("annotation layer is not open")?;
    window.set_ignore_cursor_events(on).map_err(|e| e.to_string())
}

/// Dead-man's switch.
///
/// Polls rather than trusting the page to report failure — a renderer that has
/// hung cannot tell us it hung, and that is precisely the case that would
/// otherwise leave a click-swallowing sheet over the whole screen.
fn watch(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let opened = Instant::now();

        loop {
            std::thread::sleep(Duration::from_millis(500));

            // Someone closed it; nothing left to guard.
            if handle.get_webview_window(LABEL).is_none() {
                return;
            }

            match state_beat(&handle) {
                // Painted at least once: enforce the heartbeat.
                Some(last) if last.elapsed() > HEARTBEAT_GRACE => {
                    eprintln!("[shotly] annotation layer stopped responding; closing it");
                    stop(&handle);
                    return;
                }
                // Never reported ready in time.
                None if opened.elapsed() > READY_GRACE => {
                    eprintln!("[shotly] annotation layer never painted; closing it");
                    stop(&handle);
                    return;
                }
                _ => {}
            }
        }
    });
}

/// Where the primary display sits inside the annotation window.
///
/// The window spans the whole virtual desktop, so on a multi-monitor setup its
/// centre can land on a secondary screen — or in the gap between two. The
/// toolbar is positioned against this rect instead, so it always appears on the
/// primary display rather than wherever the desktops happen to average out.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotateLayout {
    pub primary_left: f64,
    pub primary_top: f64,
    pub primary_width: f64,
    pub primary_height: f64,
}

#[tauri::command]
pub fn annotate_layout() -> Result<AnnotateLayout, String> {
    let displays = display::displays().map_err(|e| e.to_string())?;
    let primary = displays
        .iter()
        .find(|d| d.is_primary)
        .or_else(|| displays.first())
        .ok_or("no displays")?;

    // The window now covers exactly this display, so it is the whole surface.
    Ok(AnnotateLayout {
        primary_left: 0.0,
        primary_top: 0.0,
        primary_width: primary.bounds.width,
        primary_height: primary.bounds.height,
    })
}

// ------------------------------------------------------------------ commands

#[tauri::command]
pub fn annotate_toggle(app: AppHandle) -> Result<(), String> {
    eprintln!("[annotate] annotate_toggle command invoked");
    toggle(&app)
}

#[tauri::command]
pub fn annotate_stop(app: AppHandle) {
    stop(&app);
}

#[tauri::command]
pub fn annotate_ready(app: AppHandle) -> Result<(), String> {
    mark_ready(&app)
}

#[tauri::command]
pub fn annotate_beat(app: AppHandle) {
    beat(&app);
}

#[tauri::command]
pub fn annotate_click_through(app: AppHandle, enabled: bool) -> Result<(), String> {
    set_click_through(&app, enabled)
}
