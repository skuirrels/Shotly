//! Screen recording: an area, a window, or a whole display, straight to a file.
//!
//! `screencapture -v` does the recording. That is the same binary the stills
//! go through, and the reasons are the same ones `capture::cli` gives — correct
//! colour, Retina backing stores and multi-display geometry, none of which we
//! have to get right ourselves — plus one that matters more here: it needs no
//! permission Shotly does not already hold, where a ScreenCaptureKit pipeline
//! would mean owning an `AVAssetWriter`, a frame clock and every codec
//! decision. What it costs is control. There is no pause, no audio worth
//! having, and the only way to stop it is a signal.
//!
//! Stopping is worth spelling out. `screencapture -v` writes the movie's index
//! when it is interrupted, so `SIGINT` is the *normal* way to end a recording —
//! not an abort. `SIGKILL`, by contrast, leaves a file with frames in it and no
//! way to play them, so nothing here may ever reach for it while the user still
//! wants what was recorded.
//!
//! # Safety model
//!
//! The selection phase is a full-screen, always-on-top window that accepts the
//! mouse — the shape of window that has wedged this machine before. It carries
//! the same guards `scroll` documents at length, for the same reasons: mouse
//! transparency until the page says it painted, a heartbeat whose silence is
//! taken as death, and a way out that runs none of the page's code.
//!
//! One guard is this module's own. A recording outlives its window: if the HUD
//! dies, the child process is still writing a movie that nobody can stop, and
//! there is no shutter sound or red menu-bar dot from us to say so. So a lost
//! HUD does not cancel the recording — it *saves* it. Losing the panel should
//! cost you the last second of a recording, not the recording.

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::capture::{cli, display, Rect};

pub const LABEL: &str = "record";

/// The floating panel's size, in points.
const HUD_WIDTH: f64 = 232.0;
const HUD_HEIGHT: f64 = 92.0;

/// How long the page may go silent before we assume it has died.
const HEARTBEAT_GRACE: Duration = Duration::from_secs(3);
/// How long it may take to paint before we give up on it.
const READY_GRACE: Duration = Duration::from_secs(3);

/// How long to wait for `screencapture` to write out the movie after `SIGINT`.
///
/// Generous on purpose: this is the moment the file's index is written, and a
/// long recording of a busy screen takes a beat. The alternative to waiting is
/// an unplayable file.
const FINALISE_GRACE: Duration = Duration::from_secs(20);

#[derive(Default)]
pub struct RecordState {
    /// The display the overlay covers, for mapping page coords to the screen.
    bounds: Mutex<Option<(Rect, u32)>>,
    /// The running recording, if there is one.
    session: Mutex<Option<Session>>,
    /// Last heartbeat from the page.
    last_beat: Mutex<Option<Instant>>,
    /// Whether the page has said it painted. Kept apart from the heartbeat for
    /// the reason `scroll::ScrollState` gives: a page can beat happily while
    /// never getting a frame onto the screen.
    ready: Mutex<bool>,
    /// Which of its two lives the page should be showing: `"select"` or `"hud"`.
    ///
    /// Held here, and not merely announced, because an event emitted while the
    /// window is still loading is an event nobody hears. Recording the whole
    /// screen opens a window that is a panel from birth and says so
    /// immediately — milliseconds before the page exists to be told — and the
    /// page then came up as a full-screen selection overlay squeezed into 232
    /// points: a prompt clipped by the bottom of the window, no way to start
    /// anything, and no way to tell it had already started. The page asks for
    /// this on mount and listens for changes afterwards.
    phase: Mutex<Phase>,
}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Select,
    Hud,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Phase::Select => "select",
            Phase::Hud => "hud",
        }
    }
}

impl Default for Phase {
    fn default() -> Self {
        Phase::Select
    }
}

impl RecordState {
    /// What the page should be showing, whether or not it has loaded yet.
    fn phase(&self) -> Phase {
        *self.phase.lock().unwrap()
    }

    /// Remember the display a session is on, and which life it opens into.
    ///
    /// Set before the window is built, deliberately: the page asks for the
    /// phase when it mounts, which is long after the window is created and
    /// after any event announcing it has already come and gone.
    fn begin(&self, display: Rect, index: u32, phase: Phase) {
        *self.bounds.lock().unwrap() = Some((display, index));
        // Cleared before the window exists, so a stale beat from a previous
        // session can never vouch for this one.
        *self.last_beat.lock().unwrap() = None;
        *self.ready.lock().unwrap() = false;
        *self.phase.lock().unwrap() = phase;
    }

    /// Forget the session. The display and the phase describe a window that no
    /// longer exists, and a later caller reading either would be answered with
    /// something that was true once — which is how the second whole-screen
    /// recording of a session came to open no panel and then fail looking for
    /// one.
    fn forget(&self) {
        *self.bounds.lock().unwrap() = None;
        *self.phase.lock().unwrap() = Phase::Select;
    }
}

struct Session {
    child: Child,
    /// Where `screencapture` is writing, in the scratch directory.
    path: PathBuf,
    started: Instant,
    what: String,
}

/// What the page shows while a recording runs.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Running {
    /// What is being recorded, in words, for the panel.
    what: String,
    /// Seconds elapsed. The page counts its own seconds between polls; this is
    /// what it starts from, so a slow start cannot leave the clock behind.
    seconds: u64,
}

/// One window the selection can snap to, in the overlay page's coordinates.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pickable {
    id: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

// ------------------------------------------------------------------ selection

/// Open the selection overlay on the display under the cursor.
///
/// While a recording is running this stops it instead — one key, one menu item,
/// both ways round. A recording you cannot stop from the same place you started
/// it is a recording you stop by force-quitting.
#[tauri::command]
pub fn record_begin(app: AppHandle) -> Result<(), String> {
    if is_recording(&app) {
        return record_stop(app);
    }

    if !cli::has_permission() {
        cli::request_permission();
        return Err("permission-denied".into());
    }

    // The same key that opened it is the way out, exactly as in `scroll`: if
    // the page wedges before painting, a toggle from the hotkey or the tray is
    // what stands between the user and force-quitting Shotly.
    if app.get_webview_window(LABEL).is_some() {
        record_cancel(app.clone());
        return Ok(());
    }

    // Keep Shotly's own windows out of the recording.
    crate::commands::conceal_for_capture(&app);

    let displays = display::displays().map_err(|e| e.to_string())?;
    let target = crate::annotate::display_under_cursor(&displays).ok_or("no displays")?;
    // `screencapture -D` is a 1-based index into this same list.
    let index = displays
        .iter()
        .position(|d| d.id == target.id)
        .map(|i| i as u32 + 1)
        .unwrap_or(1);

    app.state::<RecordState>().begin(target.bounds, index, Phase::Select);

    let bounds = target.bounds;
    let window = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("record.html".into()))
        .title("Shotly Recording")
        .position(bounds.x, bounds.y)
        .inner_size(bounds.width, bounds.height)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .accept_first_mouse(true)
        .build()
        .map_err(|e| e.to_string())?;

    // Clicks fall through until the page confirms it has drawn something.
    window.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;

    // Space membership only, while this is still a full-screen sheet. It is
    // raised above everything else when — and only when — it shrinks into the
    // panel. See `platform::show_on_every_space`.
    if let Err(err) = crate::platform::show_on_every_space(&window) {
        eprintln!("[shotly] the recording overlay may open on another Space: {err}");
    }
    if let Err(err) = crate::platform::hide_from_capture(&window) {
        eprintln!("[shotly] the recording panel may appear in the recording: {err}");
    }

    let _ = window.set_focus();
    watch(&app);
    Ok(())
}

/// The page has painted: hand it the mouse, and start expecting heartbeats.
#[tauri::command]
pub fn record_ready(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window(LABEL).ok_or("the overlay is not open")?;
    {
        let state = app.state::<RecordState>();
        *state.last_beat.lock().unwrap() = Some(Instant::now());
        *state.ready.lock().unwrap() = true;
    }
    window.set_ignore_cursor_events(false).map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
pub fn record_beat(app: AppHandle) {
    *app.state::<RecordState>().last_beat.lock().unwrap() = Some(Instant::now());
}

/// Which of its two lives the page is opening into. See `RecordState::phase`.
#[tauri::command]
pub fn record_phase(app: AppHandle) -> String {
    app.state::<RecordState>().phase().as_str().to_string()
}

/// Move the page to a phase, and remember it for a page that has yet to load.
fn set_phase(app: &AppHandle, phase: Phase) {
    *app.state::<RecordState>().phase.lock().unwrap() = phase;
    let _ = app.emit_to(LABEL, "record:phase", phase.as_str());
}



/// The overlay's place on screen, so the page can map a drag to global points.
#[tauri::command]
pub fn record_layout(app: AppHandle) -> Result<Rect, String> {
    let state = app.state::<RecordState>();
    let bounds = state.bounds.lock().unwrap();
    bounds.map(|(rect, _)| rect).ok_or_else(|| "no recording session".into())
}

/// The windows the selection can snap to, in the overlay page's coordinates.
///
/// Carries the window id as well as the rectangle, which is the difference
/// between recording a window and recording the patch of desk it happens to be
/// sitting on: `screencapture -l` follows the window if it moves, and keeps
/// whatever is dropped in front of it out of the picture.
#[tauri::command]
pub fn record_windows(app: AppHandle) -> Result<Vec<Pickable>, String> {
    let state = app.state::<RecordState>();
    let (display, _) = (*state.bounds.lock().unwrap()).ok_or("no recording session")?;

    Ok(crate::snap::pointable_windows()
        .into_iter()
        .map(|w| Pickable {
            id: w.id,
            x: w.bounds.x - display.x,
            y: w.bounds.y - display.y,
            width: w.bounds.width,
            height: w.bounds.height,
        })
        .collect())
}

// ------------------------------------------------------------------ recording

/// Record an area of the screen, in global points.
#[tauri::command]
pub fn record_region(app: AppHandle, region: Rect) -> Result<(), String> {
    let (display, _) = current_display(&app)?;
    // Squared off before anything is recorded with it, for the reasons
    // `scroll::scroll_start` sets out: `-R` rounds fractions outward and clips
    // an overhanging rectangle silently.
    let region = clamp_to_display(region, display);
    if region.width < 60.0 || region.height < 60.0 {
        return Err("drag out a larger area".into());
    }

    let rect = format!(
        "{},{},{},{}",
        region.x as i64, region.y as i64, region.width as i64, region.height as i64
    );
    start(
        &app,
        &["-R", &rect],
        format!("{} × {}", region.width as i64, region.height as i64),
    )
}

/// Record one window, following it if it moves.
#[tauri::command]
pub fn record_window(app: AppHandle, window_id: u32) -> Result<(), String> {
    let title = crate::snap::pointable_windows()
        .into_iter()
        .find(|w| w.id == window_id)
        .map(|w| w.app_name)
        .unwrap_or_else(|| "Window".into());

    start(&app, &["-l", &window_id.to_string()], title)
}

/// Record a whole display — the one the overlay is on, or the one under the
/// cursor when there is no overlay (the tray's way in).
#[tauri::command]
pub fn record_screen(app: AppHandle) -> Result<(), String> {
    // Whether a panel has to be opened is a question about the *window*, not
    // about the state beside it. Asking `current_display` — which answers from
    // a field that outlives the window it describes — meant that the second
    // whole-screen recording of a session opened no panel at all and then
    // failed looking for one.
    let index = if app.get_webview_window(LABEL).is_some() {
        current_display(&app)?.1
    } else {
        if !cli::has_permission() {
            cli::request_permission();
            return Err("permission-denied".into());
        }
        let displays = display::displays().map_err(|e| e.to_string())?;
        let target = crate::annotate::display_under_cursor(&displays).ok_or("no displays")?;
        let index = displays
            .iter()
            .position(|d| d.id == target.id)
            .map(|i| i as u32 + 1)
            .unwrap_or(1);
        // The panel needs somewhere to be. Opening the selection overlay first
        // would put a dimmed sheet over the display for a frame or two, so the
        // panel is opened where it belongs and nothing else is.
        crate::commands::conceal_for_capture(&app);
        open_hud(&app, target.bounds)?;
        index
    };

    start(&app, &["-D", &index.to_string()], "Whole screen".into())
}

/// Spawn `screencapture` and turn the overlay into the panel.
fn start(app: &AppHandle, target: &[&str], what: String) -> Result<(), String> {
    {
        let state = app.state::<RecordState>();
        if state.session.lock().unwrap().is_some() {
            return Err("a recording is already running".into());
        }
    }

    let path = scratch_path()?;
    let mut args: Vec<String> = vec!["-v".into(), "-x".into()];
    args.extend(target.iter().map(|s| (*s).to_string()));
    args.push(path.to_string_lossy().into_owned());

    // The panel moves out of the way before the shutter opens. It is invisible
    // to the recording (see `hide_from_capture`), but a window still being
    // dragged across the screen is a window the compositor is busy with, and
    // the first second of a recording is the one people watch.
    shrink_to_hud(app)?;

    let child = Command::new("/usr/sbin/screencapture")
        .args(&args)
        .spawn()
        .map_err(|e| format!("could not start the recording: {e}"))?;

    let started = Instant::now();
    {
        let state = app.state::<RecordState>();
        *state.session.lock().unwrap() =
            Some(Session { child, path, started, what: what.clone() });
    }

    let _ = app.emit_to(LABEL, "record:running", Running { what, seconds: 0 });
    crate::refresh_tray(app);
    Ok(())
}

/// Stop the recording and file it in the library.
#[tauri::command]
pub fn record_stop(app: AppHandle) -> Result<(), String> {
    if !is_recording(&app) {
        // Stopped before anything was chosen: take the overlay down and put
        // the editor back where it was.
        wind_down(&app);
        return Err("nothing was being recorded".into());
    }
    end(&app, true);
    Ok(())
}

/// Stop the recording and throw it away.
#[tauri::command]
pub fn record_cancel(app: AppHandle) {
    if !is_recording(&app) {
        wind_down(&app);
        return;
    }
    end(&app, false);
}

/// Do the waiting somewhere the app is not.
///
/// Commands run on the main thread, and this one waits for `screencapture` to
/// write out the movie — a second on an ordinary recording and, in the worst
/// case this allows for, twenty. Blocking the event loop for that long freezes
/// the tray and every window with it, so the panel says "Saving…" and the wait
/// happens on a thread of its own.
fn end(app: &AppHandle, keep: bool) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let saved = finish(&handle, keep);
        wind_down(&handle);

        match saved {
            Ok(Some(path)) => {
                // Say so somewhere the user can see. The editor is hidden for
                // the whole recording — it would otherwise be *in* it — so the
                // toast it carries has been landing in a window nobody was
                // looking at, which is most of why a working recorder read as
                // a broken one. Activation policy is AppKit, hence the hop.
                let h = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    if let Err(err) = crate::commands::present_editor(&h) {
                        eprintln!("[shotly] could not show the editor: {err}");
                    }
                });
                let _ = handle.emit("record:saved", &path);
            }
            Ok(None) => {}
            Err(err) => {
                eprintln!("[shotly] the recording could not be saved: {err}");
                let _ = handle.emit("capture:error", &err);
            }
        }
    });
}

/// Put everything back: panel gone, editor as it was, tray honest again.
fn wind_down(app: &AppHandle) {
    close(app);
    app.state::<RecordState>().forget();
    crate::commands::reveal_after_capture(app);

    // The tray menu is AppKit, and AppKit menus are built on the main thread.
    // This is reached from the waiting thread above as well as from commands.
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || crate::refresh_tray(&handle));
}

/// What the panel needs to know when it opens, or `None` when idle.
#[tauri::command]
pub fn record_running(app: AppHandle) -> Option<Running> {
    let state = app.state::<RecordState>();
    let session = state.session.lock().unwrap();
    session.as_ref().map(|s| Running {
        what: s.what.clone(),
        seconds: s.started.elapsed().as_secs(),
    })
}

pub fn is_recording(app: &AppHandle) -> bool {
    app.state::<RecordState>().session.lock().unwrap().is_some()
}

/// Save a recording that is still running as Shotly quits.
///
/// Without this, quitting mid-recording orphans the child: `screencapture`
/// keeps writing to a scratch file that nothing will ever interrupt, name, or
/// move — a recording that goes on for as long as the machine is up and ends
/// as an unplayable temp file. Delaying the quit by the second or two it takes
/// to write the index is the cheaper of the two.
pub fn wrap_up(app: &AppHandle) {
    if !is_recording(app) {
        return;
    }
    match finish(app, true) {
        Ok(Some(path)) => eprintln!("[shotly] saved the recording in progress to {path}"),
        Ok(None) => {}
        Err(err) => eprintln!("[shotly] could not save the recording in progress: {err}"),
    }
}

/// End the child process and, if it is wanted, move the movie into the library.
///
/// `Ok(None)` means there was nothing to stop.
fn finish(app: &AppHandle, keep: bool) -> Result<Option<String>, String> {
    let Some(mut session) = app.state::<RecordState>().session.lock().unwrap().take() else {
        return Ok(None);
    };

    // SIGINT is how a recording ends: `screencapture` catches it and writes the
    // movie's index. Killing it outright would leave an unplayable file.
    interrupt(&session.child);

    let deadline = Instant::now() + FINALISE_GRACE;
    loop {
        match session.child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => {
                // It has had its chance. Killing it now costs the file, which
                // is why this waits twenty seconds first and says so out loud.
                let _ = session.child.kill();
                let _ = session.child.wait();
                let _ = std::fs::remove_file(&session.path);
                return Err("the recorder did not finish writing the movie".into());
            }
            Err(e) => return Err(format!("could not wait for the recorder: {e}")),
        }
    }

    if !keep {
        let _ = std::fs::remove_file(&session.path);
        return Ok(None);
    }

    if !session.path.exists() {
        return Err("the recording did not produce a file".into());
    }

    let stem = crate::commands::stamped_stem("Recording");
    let path = crate::commands::move_into_library(app, &session.path, &stem, "mov")?;

    // Ask for the poster frame now, while nobody is waiting for it. The library
    // would otherwise generate it the first time the grid is opened — which is
    // usually the next thing that happens, and QuickLook takes its time.
    let warm = path.clone();
    std::thread::spawn(move || {
        if let Err(err) = crate::commands::warm_thumbnail(&warm) {
            eprintln!("[shotly] no poster frame for the recording yet: {err}");
        }
    });

    Ok(Some(path))
}

#[cfg(unix)]
fn interrupt(child: &Child) {
    // SAFETY: `kill(2)` with a pid this process owns and a signal number that
    // is always valid. The child is still owned by `Session`, so the pid cannot
    // have been reaped and reused underneath us.
    unsafe {
        libc::kill(child.id() as i32, libc::SIGINT);
    }
}

#[cfg(not(unix))]
fn interrupt(_child: &Child) {}

fn scratch_path() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("shotly");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok(dir.join(format!("recording-{stamp}.mov")))
}

// --------------------------------------------------------------------- window

fn current_display(app: &AppHandle) -> Result<(Rect, u32), String> {
    let state = app.state::<RecordState>();
    let bounds = *state.bounds.lock().unwrap();
    bounds.ok_or_else(|| "no recording session".into())
}

/// Whole points, and inside the display. See `scroll::clamp_to_display`.
fn clamp_to_display(region: Rect, display: Rect) -> Rect {
    let x0 = region.x.round().max(display.x);
    let y0 = region.y.round().max(display.y);
    let x1 = (region.x + region.width).round().min(display.x + display.width);
    let y1 = (region.y + region.height).round().min(display.y + display.height);

    Rect { x: x0, y: y0, width: (x1 - x0).max(0.0), height: (y1 - y0).max(0.0) }
}

/// Bottom-centre of the display, where a recording panel is expected to be.
///
/// Unlike the scrolling-capture HUD this does not have to dodge the region:
/// the panel is invisible to the recording, so the only thing it can get in
/// the way of is the user's own view.
fn hud_spot(display: &Rect) -> (f64, f64) {
    // Enough to clear a Dock at its usual size. The panel floats above
    // everything now, so a smaller gap would not hide it behind the Dock — it
    // would sit on top of it, which is its own kind of in the way.
    const GAP: f64 = 96.0;
    (
        display.x + (display.width - HUD_WIDTH) / 2.0,
        display.y + display.height - HUD_HEIGHT - GAP,
    )
}

fn shrink_to_hud(app: &AppHandle) -> Result<(), String> {
    let (display, _) = current_display(app)?;
    let window = app.get_webview_window(LABEL).ok_or("the overlay is gone")?;
    let (x, y) = hud_spot(&display);

    window
        .set_position(tauri::LogicalPosition::new(x, y))
        .and_then(|_| window.set_size(tauri::LogicalSize::new(HUD_WIDTH, HUD_HEIGHT)))
        .map_err(|e| e.to_string())?;

    // It is a panel now, so it can be raised above everything.
    raise_panel(app);
    set_phase(app, Phase::Hud);
    Ok(())
}

/// Open the panel on its own, for a recording that needed no selection.
fn open_hud(app: &AppHandle, display: Rect) -> Result<(), String> {
    // A panel from birth. Set before the window is built, so the page finds it
    // already true whenever it gets round to asking.
    app.state::<RecordState>().begin(display, 1, Phase::Hud);

    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }

    let (x, y) = hud_spot(&display);
    WebviewWindowBuilder::new(&app.clone(), LABEL, WebviewUrl::App("record.html".into()))
        .title("Shotly Recording")
        .position(x, y)
        .inner_size(HUD_WIDTH, HUD_HEIGHT)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .accept_first_mouse(true)
        .build()
        .map_err(|e| e.to_string())?;

    // Born a panel: nothing to select, so it is raised straight away.
    raise_panel(app);
    watch(app);
    Ok(())
}

/// Put the panel where it can actually be seen and used.
///
/// Three things, and none of them optional. It floats above every other window
/// and shows on every Space, because `alwaysOnTop` alone is a floating-level
/// window that belongs to the Space it was born on — which is how the first
/// version of this handed anyone recording from a full-screen app a stop
/// button behind their windows. And it stays out of the recording itself
/// (`NSWindowSharingNone`), which is what lets it sit over the display it is
/// recording rather than dodging it.
///
/// Safe to raise this one where it would not be safe to raise the selection
/// overlay: this is a 232-point panel with two buttons on it, not a sheet over
/// the whole display.
fn raise_panel(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else { return };
    if let Err(err) = crate::platform::elevate_overlay_window(&window) {
        eprintln!("[shotly] the recording panel may sit behind other windows: {err}");
    }
    if let Err(err) = crate::platform::hide_from_capture(&window) {
        eprintln!("[shotly] the recording panel may appear in the recording: {err}");
    }
}

fn close(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.close();
    }
}

/// Tear the session down if the page stops answering.
///
/// The two phases want opposite things from a dead page, which is the one place
/// this differs from `scroll::watch`. Before the shutter opens, a page that
/// never painted is a full-screen click target and the answer is to remove it.
/// Once recording, the page is only a panel — the movie is being written by a
/// process that does not care whether anyone is watching — so silence means
/// *save what you have*, not throw it away.
fn watch(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let opened = Instant::now();

        loop {
            std::thread::sleep(Duration::from_millis(500));

            if handle.get_webview_window(LABEL).is_none() {
                return;
            }

            let (ready, beat) = {
                let state = handle.state::<RecordState>();
                let ready = *state.ready.lock().unwrap();
                let beat = *state.last_beat.lock().unwrap();
                (ready, beat)
            };

            let dead = if ready {
                beat.is_none_or(|last| last.elapsed() > HEARTBEAT_GRACE)
            } else {
                opened.elapsed() > READY_GRACE
            };

            if !dead {
                continue;
            }

            if is_recording(&handle) {
                eprintln!("[shotly] the recording panel stopped answering; saving the recording");
                let _ = record_stop(handle.clone());
            } else {
                eprintln!("[shotly] the recording overlay stopped responding; closing it");
                record_cancel(handle.clone());
            }
            return;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_region_is_clamped_to_whole_points_inside_the_display() {
        let display = Rect { x: 0.0, y: 0.0, width: 1440.0, height: 900.0 };
        let region = Rect { x: -20.0, y: 10.4, width: 2000.0, height: 100.9 };
        let clamped = clamp_to_display(region, display);

        assert_eq!(clamped.x, 0.0);
        assert_eq!(clamped.y, 10.0);
        assert_eq!(clamped.width, 1440.0);
        assert_eq!(clamped.height, 101.0);
    }

    /// The one thing that cannot be reasoned about from the source: that
    /// `SIGINT` ends a recording *tidily*, leaving a movie that plays.
    ///
    /// Ignored by default — it records a small corner of the screen for two
    /// seconds, so it needs a real display and the Screen Recording permission,
    /// and it has no business running in a batch. Run it after touching
    /// anything about how the recorder is started or stopped:
    ///
    /// ```text
    /// cargo test -- --ignored interrupting
    /// ```
    #[test]
    #[ignore = "records the screen; run it by hand"]
    fn interrupting_the_recorder_leaves_a_playable_movie() {
        let path = scratch_path().expect("scratch directory");
        let mut child = Command::new("/usr/sbin/screencapture")
            .args(["-v", "-x", "-R", "0,0,320,200"])
            .arg(&path)
            .spawn()
            .expect("screencapture should start");

        std::thread::sleep(Duration::from_secs(2));
        interrupt(&child);
        let status = child.wait().expect("screencapture should exit");

        let movie = std::fs::read(&path).expect("a movie should have been written");
        // Read before the file goes: this is the same reader the library uses
        // to put a running time and a size on the card, so the recorder and
        // the parser are checked against each other rather than separately.
        let measured = crate::video::probe(&path);
        let _ = std::fs::remove_file(&path);

        assert!(status.success(), "interrupting it should not be an error");
        // `ftyp` first, and a `moov` atom somewhere: the index that only gets
        // written on a clean exit, and without which nothing will play it.
        assert_eq!(&movie[4..8], b"ftyp", "not a QuickTime file");
        assert!(
            movie.windows(4).any(|w| w == b"moov"),
            "no moov atom: the movie was never finalised",
        );

        let measured = measured.expect("the library could not measure the recording");
        assert!(
            (measured.seconds - 2.0).abs() < 1.0,
            "two seconds of recording measured as {}",
            measured.seconds,
        );
        // 320×200 points, at whatever backing scale this display has.
        let ratio = measured.width as f64 / measured.height as f64;
        assert!((ratio - 1.6).abs() < 0.05, "recorded {}×{}", measured.width, measured.height);
    }

    #[test]
    fn the_panel_sits_inside_the_display_it_belongs_to() {
        let display = Rect { x: 1440.0, y: -200.0, width: 1440.0, height: 900.0 };
        let (x, y) = hud_spot(&display);

        assert!(x >= display.x);
        assert!(x + HUD_WIDTH <= display.x + display.width);
        assert!(y + HUD_HEIGHT <= display.y + display.height);
    }

    /// A display whose origin is negative — a second screen placed above and to
    /// the left of the built-in one, which is where the panel was reported
    /// "out of sight and off screen".
    #[test]
    fn the_panel_clears_the_dock_on_a_display_with_a_negative_origin() {
        let display = Rect { x: -2048.0, y: -253.0, width: 2048.0, height: 1152.0 };
        let (x, y) = hud_spot(&display);

        // Centred across, and far enough up that a Dock at its usual height is
        // not underneath it.
        assert!((x - (display.x + (display.width - HUD_WIDTH) / 2.0)).abs() < 0.5);
        let below = display.y + display.height - (y + HUD_HEIGHT);
        assert!(below >= 90.0, "only {below} points above the bottom");
    }

    /// The bug that shipped in 0.7.7: recording the whole screen opens a window
    /// that is a panel before any page exists to be told so. Whoever asks later
    /// has to be told the same thing, or the page renders a full-screen
    /// selection overlay inside a 232-point window.
    #[test]
    fn a_session_that_opens_as_a_panel_says_so_to_whoever_asks_later() {
        let state = RecordState::default();
        let display = Rect { x: 0.0, y: 0.0, width: 1440.0, height: 900.0 };

        assert_eq!(state.phase().as_str(), "select", "nothing open yet");

        state.begin(display, 1, Phase::Hud);
        assert_eq!(state.phase().as_str(), "hud");
    }

    /// The other half of the same bug: the display outlives the window unless
    /// something forgets it, and the second whole-screen recording of a session
    /// then found a display remembered, skipped opening a panel, and failed
    /// looking for the one it had not opened.
    #[test]
    fn winding_down_forgets_the_session_it_described() {
        let state = RecordState::default();
        let display = Rect { x: 0.0, y: 0.0, width: 1440.0, height: 900.0 };

        state.begin(display, 2, Phase::Hud);
        assert!(state.bounds.lock().unwrap().is_some());

        state.forget();
        assert!(state.bounds.lock().unwrap().is_none(), "the display outlived its window");
        assert_eq!(state.phase().as_str(), "select", "the next window opens fresh");
    }

    /// Starting a session must not inherit the previous one's vital signs: a
    /// beat or a paint from the window that has just closed would vouch for a
    /// window that has not drawn anything yet.
    #[test]
    fn a_new_session_starts_with_no_pulse_of_its_own() {
        let state = RecordState::default();
        *state.last_beat.lock().unwrap() = Some(Instant::now());
        *state.ready.lock().unwrap() = true;

        state.begin(Rect { x: 0.0, y: 0.0, width: 800.0, height: 600.0 }, 1, Phase::Select);

        assert!(state.last_beat.lock().unwrap().is_none());
        assert!(!*state.ready.lock().unwrap());
    }
}
