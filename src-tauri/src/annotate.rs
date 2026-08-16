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

use crate::capture::{display, DisplayInfo};
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
    /// Which display the overlay is currently covering.
    pub display: Mutex<Option<u32>>,
    /// True while clicks are being handed to whatever is underneath.
    pub pass_through: Mutex<bool>,
    /// The toolbar, in window coordinates: the one region that stays clickable
    /// while the rest of the layer is letting clicks past.
    pub hot_rect: Mutex<Option<HotRect>>,
    /// Bumped to retire the running cursor watcher; see `set_pass_through`.
    pub watcher: Mutex<u64>,
}

/// A rectangle in the overlay page's own coordinates (CSS points from its
/// top-left), which is the only frame the page can measure itself in.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub struct HotRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
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
        *state.display.lock().unwrap() = None;
        *state.pass_through.lock().unwrap() = false;
        *state.hot_rect.lock().unwrap() = None;
        // Retire the cursor watcher: it holds a window handle and would
        // otherwise outlive the layer it was following.
        *state.watcher.lock().unwrap() += 1;
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
    start(app, None)
}

/// Where the pointer is, in global point space.
#[cfg(target_os = "macos")]
fn cursor_point() -> Option<(f64, f64)> {
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState).ok()?;
    let point = CGEvent::new(source).ok()?.location();
    Some((point.x, point.y))
}

#[cfg(not(target_os = "macos"))]
fn cursor_point() -> Option<(f64, f64)> {
    None
}

/// Choose the display to annotate.
///
/// An explicit request wins; otherwise it is whichever screen the pointer is
/// on. Following the cursor is the whole answer to "which monitor?" on a
/// multi-display desk: you are already looking at the screen you mean to draw
/// on, and your hand is already there. The primary display is only the
/// fallback for a pointer that is somewhere unaccounted for.
pub fn display_under_cursor(displays: &[DisplayInfo]) -> Option<&DisplayInfo> {
    pick_display(displays, None)
}

fn pick_display(displays: &[DisplayInfo], preferred: Option<u32>) -> Option<&DisplayInfo> {
    if let Some(id) = preferred {
        if let Some(found) = displays.iter().find(|d| d.id == id) {
            return Some(found);
        }
    }

    if let Some((x, y)) = cursor_point() {
        let under = displays.iter().find(|d| {
            let b = d.bounds;
            x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height
        });
        if under.is_some() {
            return under;
        }
    }

    displays.iter().find(|d| d.is_primary).or_else(|| displays.first())
}

fn start(app: &AppHandle, preferred: Option<u32>) -> Result<(), String> {
    let displays = display::displays().map_err(|e| e.to_string())?;

    // Cover one display, not the whole virtual desktop.
    //
    // Spanning every screen sounds more capable but is worse in practice: a
    // secondary monitor placed above or left of the primary gives the desktop
    // negative coordinates, and macOS clamps windows out of that region — which
    // silently shifts the whole surface and pushes the toolbar off-screen. You
    // also only ever share one screen at a time. One display keeps the geometry
    // trivially correct and the window smaller.
    let target = pick_display(&displays, preferred).ok_or("no displays")?;
    let bounds = target.bounds;
    let id = target.id;
    eprintln!("[annotate] start: covering display {id} {bounds:?}");

    *app.state::<AnnotateState>().display.lock().unwrap() = Some(id);

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

/// Hand the desktop back without packing up the drawings.
///
/// `set_ignore_cursor_events` is all-or-nothing for a window, so simply turning
/// it on would take the toolbar with it and leave no way back except a global
/// hotkey. Instead a watcher follows the cursor and lifts the pass-through for
/// exactly as long as the pointer is over the toolbar, which is the only part
/// of the layer that still wants clicks. The hotkey stays as the guarantee for
/// when this page is not in a position to ask for anything.
pub fn set_pass_through(app: &AppHandle, on: bool, rect: Option<HotRect>) -> Result<(), String> {
    let window = app.get_webview_window(LABEL).ok_or("annotation layer is not open")?;

    let generation = {
        let state = app.state::<AnnotateState>();
        *state.pass_through.lock().unwrap() = on;
        *state.hot_rect.lock().unwrap() = rect;
        let mut watcher = state.watcher.lock().unwrap();
        *watcher += 1;
        *watcher
    };

    if !on {
        return window.set_ignore_cursor_events(false).map_err(|e| e.to_string());
    }

    window.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
    follow_cursor(app, generation);
    Ok(())
}

/// Poll the pointer and open a hole in the pass-through over the toolbar.
///
/// Polling because a window that ignores the mouse is told nothing about it —
/// there is no enter or leave event to subscribe to. 30ms is under the
/// threshold where a button feels dead on arrival, and the loop does nothing
/// but read a point and compare it to a rectangle.
fn follow_cursor(app: &AppHandle, generation: u64) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut ignoring = true;

        loop {
            std::thread::sleep(Duration::from_millis(30));

            let Some(window) = handle.get_webview_window(LABEL) else { return };
            let state = handle.state::<AnnotateState>();

            // A newer call — or a return to drawing — has retired this watcher.
            if *state.watcher.lock().unwrap() != generation {
                return;
            }

            let rect = *state.hot_rect.lock().unwrap();
            let over = match (rect, cursor_point(), window.outer_position(), window.scale_factor()) {
                (Some(r), Some((cx, cy)), Ok(origin), Ok(scale)) => {
                    // The page measures itself from its own top-left; the
                    // cursor is in global points. Meet in the middle.
                    let left = origin.x as f64 / scale + r.x;
                    let top = origin.y as f64 / scale + r.y;
                    cx >= left && cx <= left + r.width && cy >= top && cy <= top + r.height
                }
                _ => false,
            };

            let want_ignore = !over;
            if want_ignore != ignoring {
                let _ = window.set_ignore_cursor_events(want_ignore);
                ignoring = want_ignore;
            }
        }
    });
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

/// The part of the overlay the menu bar and Dock are not sitting on top of,
/// in CSS pixels relative to the window's own top-left.
///
/// The window covers the whole display on purpose — you have to be able to draw
/// over every pixel of it — but the toolbar must not be under the menu bar or
/// behind the Dock, where it is unreachable. macOS already knows where those
/// are; this hands that answer to the page.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotateLayout {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

#[tauri::command]
pub fn annotate_layout(app: AppHandle) -> Result<AnnotateLayout, String> {
    let window = app.get_webview_window(LABEL).ok_or("annotation layer is not open")?;
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("the overlay is not on any display")?;

    // Everything here is physical; the page thinks in CSS pixels.
    let scale = monitor.scale_factor();
    let origin = monitor.position();
    let work = monitor.work_area();

    Ok(AnnotateLayout {
        left: (work.position.x - origin.x) as f64 / scale,
        top: (work.position.y - origin.y) as f64 / scale,
        width: work.size.width as f64 / scale,
        height: work.size.height as f64 / scale,
    })
}

/// One entry in the overlay's screen picker.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotateScreen {
    pub id: u32,
    /// 1-based position in the display list, for a label a human can act on.
    pub number: usize,
    pub is_primary: bool,
    /// Whether the overlay is on this one right now.
    pub is_current: bool,
    pub width: f64,
    pub height: f64,
}

/// The displays the overlay can move between, current one marked.
#[tauri::command]
pub fn annotate_screens(app: AppHandle) -> Result<Vec<AnnotateScreen>, String> {
    let displays = display::displays().map_err(|e| e.to_string())?;
    let current = *app.state::<AnnotateState>().display.lock().unwrap();

    Ok(displays
        .iter()
        .enumerate()
        .map(|(i, d)| AnnotateScreen {
            id: d.id,
            number: i + 1,
            is_primary: d.is_primary,
            is_current: Some(d.id) == current,
            width: d.bounds.width,
            height: d.bounds.height,
        })
        .collect())
}

/// Move the live overlay to another display.
///
/// Repositions rather than rebuilding: tearing the window down and putting a
/// new one up would lose whatever is drawn, and closing is asynchronous, so a
/// rebuild races the old window's label still being taken. Moving keeps the
/// strokes and the webview exactly as they are, which also means none of the
/// safety machinery — the heartbeat, the ready state — has to restart.
#[tauri::command]
pub fn annotate_move(app: AppHandle, display_id: u32) -> Result<(), String> {
    let window = app.get_webview_window(LABEL).ok_or("annotation layer is not open")?;
    let displays = display::displays().map_err(|e| e.to_string())?;
    let target = displays.iter().find(|d| d.id == display_id).ok_or("no such display")?;
    let b = target.bounds;

    // Size before position: moving first can leave the window straddling two
    // screens for a frame, and macOS may clamp the position to fit the old size.
    window
        .set_size(tauri::LogicalSize::new(b.width, b.height))
        .map_err(|e| e.to_string())?;
    window
        .set_position(tauri::LogicalPosition::new(b.x, b.y))
        .map_err(|e| e.to_string())?;

    *app.state::<AnnotateState>().display.lock().unwrap() = Some(display_id);
    eprintln!("[annotate] moved to display {display_id} {b:?}");
    Ok(())
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

#[tauri::command]
pub fn annotate_pass_through(
    app: AppHandle,
    enabled: bool,
    rect: Option<HotRect>,
) -> Result<(), String> {
    set_pass_through(&app, enabled, rect)
}

/// Photograph the annotated screen and file it in the library.
///
/// Deliberately a screenshot of the whole display rather than a rendering of
/// the strokes: what was drawn only means anything on top of what it was drawn
/// over, and the desktop underneath is not something this window has a copy of.
/// The layer is still up when this runs, so its drawings are in the shot — the
/// page hides its own toolbar first, which is the one part that shouldn't be.
///
/// Unlike every other capture this does not open the editor. It is the last
/// thing that happens on the way out of a screen share, and having a window
/// leap up in front of the audience is precisely what nobody wants.
#[tauri::command]
pub fn annotate_save(app: AppHandle, stem: String) -> Result<String, String> {
    use crate::capture::CaptureBackend;
    use crate::{commands, AppState};

    let state = app.state::<AppState>();
    let wanted = *app.state::<AnnotateState>().display.lock().unwrap();

    let frames = state.backend.capture_displays().map_err(|e| e.to_string())?;
    let displays = state.backend.displays().map_err(|e| e.to_string())?;

    let idx = wanted
        .and_then(|id| displays.iter().position(|d| d.id == id))
        .or_else(|| displays.iter().position(|d| d.is_primary))
        .unwrap_or(0);
    let frame = frames.get(idx).ok_or("display not found")?;

    let bytes = std::fs::read(&frame.path).map_err(|e| e.to_string())?;
    // Stamp the DPI so a Retina screen reopens as @2x rather than a capture of
    // mysteriously doubled dimensions.
    let bytes = crate::capture::cli::with_dpi(&bytes, frame.scale);

    commands::write_into_library(&app, &bytes, &stem)
}
