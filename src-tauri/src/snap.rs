//! Point at what you want; Shotly outlines it and takes it.
//!
//! Snagit's all-in-one capture is the thing being answered here: one session
//! that gives you three captures, and never asks which you meant beforehand.
//! Click a window and it takes that window; click the desktop and it takes the
//! screen; press and drag and it takes the rectangle you drew instead. The
//! choice is made by pointing, which is the whole advantage — picking a mode
//! first means finding out afterwards that it was the wrong one.
//!
//! Shotly had a version of the outline once, drawn from
//! `CGWindowListCopyWindowInfo`, and it was removed because that list contains
//! windows which are not on screen and cannot be told apart from ones that
//! are. See `ax.rs` for what replaced it and why the accessibility API can be
//! trusted where the window list could not.
//!
//! # Who owns the click
//!
//! Shotly does, through a `CGEventTap`. That is not the obvious choice — a
//! full-screen window that accepts clicks would be the usual way — and it is
//! deliberate, because of a measurement in `ax.rs`: a window that ignores mouse
//! events is invisible to accessibility hit-testing, and one that accepts them
//! is not. A click-catching overlay would therefore be the only thing the
//! outline could ever find. Something has to take the click without being a
//! window, which leaves the event tap.
//!
//! It is also the safer of the two. The failure mode of a full-screen click
//! target is a desktop nobody can use until Shotly is force-quit — this
//! codebase has been there. The failure mode of an event tap is that macOS
//! notices the callback is slow and switches the tap off itself, which is to
//! say: the operating system already implements the recovery. Everything below
//! is arranged so that recovery is never needed.
//!
//! # Guards
//!
//! * **The tap callback does no work.** It stores an integer and returns.
//!   Nothing is locked, nothing is allocated, no IPC happens there — the AX
//!   calls and the drawing all belong to the tracker thread.
//! * **The tap outlives nothing.** It is created when the session starts,
//!   dropped when it ends, and has a hard deadline of [`MAX_SESSION`] enforced
//!   by its own loop rather than by whoever was supposed to stop it.
//! * **The tap does not exist until the outline is on screen.** It is started by
//!   `snap_ready` and nowhere else, so a page that fails to paint costs nobody
//!   a click — which is the difference between a feature that did not work and
//!   a Mac that appears to have stopped working.
//! * **Only the mouse buttons, the scroll wheel and Escape are swallowed.**
//!   Everything else passes through untouched, so ⌘Tab and ⌘Q still work while
//!   a session is up.
//! * **The overlay never accepts a click**, at any point in its life, which is
//!   what makes it safe to put a full-screen window over the desktop at all.
//! * **The overlay is watched.** If it fails to paint, or stops answering, the
//!   session ends — an outline nobody can see means clicking blind into a tap
//!   that is swallowing the clicks.

use crate::ax;
use crate::capture::{display, CaptureBackend, Frame, Rect};
use crate::commands::{self, AppState};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Overlay windows are labelled `snap-0`, `snap-1`, one per display.
///
/// One window spanning the whole desktop was the obvious shape and the wrong
/// one: macOS confines a window to a single display's Space, so it painted on
/// whichever screen was active and left the others bare — the outline simply
/// did not exist on the second monitor. The capability file matches `snap-*`.
const LABEL_PREFIX: &str = "snap-";

/// How often the outline reconsiders where it should be.
///
/// 25Hz rather than the 40Hz the old outline used, because each tick can cost
/// two round trips to another application. Ticks where the pointer has not
/// moved cost nothing at all.
const POLL: Duration = Duration::from_millis(40);

/// The longest a session may last, however it was left.
///
/// Short on purpose. For as long as this runs, clicks are going nowhere; a
/// session that has been forgotten about — walked away from, or left behind a
/// full-screen app — has to give the mouse back on its own, and two minutes of
/// a Mac that ignores clicks is not a recovery, it is the fault.
const MAX_SESSION: Duration = Duration::from_secs(45);

/// How long the overlay may go silent before it is assumed dead.
const HEARTBEAT_GRACE: Duration = Duration::from_secs(3);
/// How long it may take to paint anything at all.
const READY_GRACE: Duration = Duration::from_secs(3);

/// Let the compositor drop the overlay before photographing the screen.
///
/// The same figure `conceal_editor` uses for hiding the editor, and for the
/// same reason: closing a window and the window being gone are not the same
/// event, and the capture will happily race the difference.
const SETTLE: Duration = Duration::from_millis(140);

/// How many times a session will switch its tap back on before giving up.
///
/// A cold start costs one. Anything beyond a handful is a callback that is
/// actually too slow, which is a different problem and not one to paper over.
const MAX_REARMS: u32 = 5;

/// The only key the tap answers for.
const KEY_ESCAPE: i64 = 53;

/// How far the pointer must travel with the button down before the gesture is
/// a drag rather than a click.
///
/// A click is nobody's steady hand: pressing hard enough to mean it moves the
/// pointer a point or two, and treating that as a two-pixel selection instead
/// of taking the window would be maddening. Generous on purpose — a drag
/// anyone intends is far larger than this.
const DRAG_SLOP: f64 = 6.0;

/// The smallest area a drag can end on and still be worth capturing.
const MIN_REGION: f64 = 8.0;

/// How long the button has to be held before the overlay says, on its own,
/// that an area is being started.
///
/// Without this there is nothing to see until the pointer has travelled past
/// `DRAG_SLOP`: press and hold, and the window outline just sits there, which
/// is indistinguishable from a feature that does not have the gesture at all.
/// A click is over long before this.
const HOLD_HINT: Duration = Duration::from_millis(150);

/// How often the rubber band is redrawn while an area is being dragged.
///
/// Faster than [`POLL`] because it can afford to be: a drag asks the
/// accessibility API nothing at all, it is two subtractions and an emit, and a
/// selection rectangle that lags the pointer by 40ms feels broken in a way a
/// snapping outline does not.
const DRAG_POLL: Duration = Duration::from_millis(16);

/// How closely a window's bounds must match an accessibility frame to be
/// considered the same window. They agree exactly in practice; this is slack
/// for a float that has been converted twice.
const BOUNDS_SLACK: f64 = 2.0;

// The session is a singleton — one outline, one tap — so its state is static
// rather than threaded through the app handle. `GENERATION` retires a run: a
// thread from a superseded session finds its number stale and drops whatever it
// was about to do, rather than tearing down the session that replaced it.
static ACTIVE: AtomicBool = AtomicBool::new(false);
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// How far into the ancestry the outline is: 0 is the window.
static LEVEL: AtomicI32 = AtomicI32::new(0);
/// Wheel movement the tracker has yet to turn into levels.
static SCROLL: AtomicI64 = AtomicI64::new(0);
static VERDICT: AtomicU8 = AtomicU8::new(VERDICT_NONE);
/// Set by the tap callback when macOS switches the tap off, and cleared by the
/// tap's own loop when it switches it back on. See `spawn_tap`.
static REARM: AtomicBool = AtomicBool::new(false);
/// Set when the wheel was turned during a session that had no accessibility
/// access to answer it with. See `ask_for_accessibility`.
static WANTED_AX: AtomicBool = AtomicBool::new(false);

/// Where the button went down, and where the pointer is now — global points,
/// as `f64` bits, because the tap callback may not allocate or lock and this
/// is the cheapest thing that can carry a coordinate out of it.
static PRESS_X: AtomicU64 = AtomicU64::new(0);
static PRESS_Y: AtomicU64 = AtomicU64::new(0);
static POINT_X: AtomicU64 = AtomicU64::new(0);
static POINT_Y: AtomicU64 = AtomicU64::new(0);
/// Whether the button is currently held.
static PRESSED: AtomicBool = AtomicBool::new(false);
/// Whether the tap has seen a drag event since the press.
///
/// Which of the two answers to believe about where the drag has got to, and
/// getting it wrong is visible: the band is drawn from the *event* when there
/// are events, because a `LeftMouseDragged` this tap drops never reaches the
/// window server, and the pointer can therefore sit perfectly still on screen
/// while a drag is happening. Polling it then gives the press point over and
/// over — crosshairs that do not move, which is exactly how this was reported.
///
/// The polled pointer is still the answer when no drag events arrive at all:
/// anything driving the mouse programmatically — scripted input, assistive
/// software, some tablet drivers — moves it with plain moved events while the
/// button is down, and those the tap never sees.
static TAPPED_DRAG: AtomicBool = AtomicBool::new(false);

const VERDICT_NONE: u8 = 0;
const VERDICT_TAKE: u8 = 1;
const VERDICT_CANCEL: u8 = 2;
/// The button was released after a drag: take the rectangle, not the window.
const VERDICT_REGION: u8 = 3;

#[derive(Default)]
pub struct SnapState {
    pub last_beat: Mutex<Option<Instant>>,
    pub ready: Mutex<bool>,
    /// The outline as last worked out — in global points, not any one page's
    /// coordinates — kept so it can be handed to a page the moment that page
    /// exists to receive it.
    last: Mutex<Option<Highlight>>,
    /// Every open overlay and the origin of the display it covers, which is
    /// what turns a global rectangle into that page's own coordinates.
    overlays: Mutex<Vec<(String, (f64, f64))>>,
}

/// Where the outline should be, in the overlay page's own coordinates.
#[derive(Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Highlight {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    /// What is being pointed at, for the caption.
    label: String,
    /// Size in points, already formatted — the page has no business rounding
    /// geometry it did not measure.
    size: String,
    /// Which level of the ancestry, and how many there are. `depth` is 0 while
    /// the outline is on the window and has not been asked to look inside.
    level: i32,
    depth: i32,
    window: bool,
    /// This is a rectangle being dragged rather than something being pointed
    /// at. The page draws it without the snapping animation: a band that eases
    /// towards the pointer reads as lag, not as polish.
    drag: bool,
}

/// What a click would take.
///
/// Three answers from one session, which is the whole point of it: the window
/// under the pointer, the screen when the pointer is on nothing else, and the
/// area if the button was dragged instead of clicked. Snagit calls this
/// all-in-one, and the reason it wins is that the choice is made by pointing
/// rather than by picking a mode beforehand and finding out afterwards that it
/// was the wrong one.
#[derive(Clone)]
enum Aim {
    Window(ax::Node),
    Screen(Rect),
    Region(Rect),
}

/// The window a level is counted from. When this changes, the level resets:
/// having drilled three deep into one window, moving to another should not
/// land three deep into that one too.
#[derive(Clone, Copy)]
struct Anchor {
    pid: i32,
    rect: Rect,
}

impl Anchor {
    /// Compared loosely on purpose: a window frame drifts by fractions of a
    /// point during a resize or a Space animation, and an exact comparison
    /// would read that as "you are now pointing at a different window" and
    /// throw away the level the user had chosen.
    fn same_window_as(self, other: Anchor) -> bool {
        self.pid == other.pid && near(self.rect, other.rect)
    }
}

fn is_current(generation: u64) -> bool {
    ACTIVE.load(Ordering::SeqCst) && GENERATION.load(Ordering::SeqCst) == generation
}

/// End a session and put the editor back, however it was reached.
pub fn cancel(app: &AppHandle, reason: &str) {
    stop(app, reason);
    commands::reveal_after_capture(app);
}

/// Ask for accessibility, if this session found a use for it.
///
/// Deliberately after the overlay has gone rather than the moment the wheel
/// turns. The prompt is a system dialog, and putting one on screen mid-session
/// — over a dimmed desktop, while an event tap holds the mouse — is how a
/// permission request turns into a Mac that appears to have seized up.
///
/// Asking also registers Shotly in the Accessibility list whether or not the
/// dialog appears, which is the difference between "find the app with the +
/// button" and "tick the box". macOS shows the dialog only once ever, so the
/// tray keeps a way in for anyone who has already dismissed it.
fn ask_for_accessibility() {
    if WANTED_AX.swap(false, Ordering::SeqCst) && !ax::trusted() {
        ax::request_trust();
    }
}

/// Where the pointer is, in global point space with a top-left origin.
#[cfg(target_os = "macos")]
fn cursor() -> Option<(f64, f64)> {
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState).ok()?;
    let point = CGEvent::new(source).ok()?.location();
    Some((point.x, point.y))
}

#[cfg(not(target_os = "macos"))]
fn cursor() -> Option<(f64, f64)> {
    None
}

fn put(cell: &AtomicU64, value: f64) {
    cell.store(value.to_bits(), Ordering::Relaxed);
}

fn got(cell: &AtomicU64) -> f64 {
    f64::from_bits(cell.load(Ordering::Relaxed))
}

/// The rectangle between where the button went down and some later point,
/// whichever way round it was dragged.
fn dragged_to(x1: f64, y1: f64) -> Rect {
    let (x0, y0) = (got(&PRESS_X), got(&PRESS_Y));
    Rect {
        x: x0.min(x1),
        y: y0.min(y1),
        width: (x1 - x0).abs(),
        height: (y1 - y0).abs(),
    }
}

/// The rectangle as it stood when the button came up — the exact one, taken
/// from the event itself rather than from wherever the pointer has drifted to
/// by the time the tracker next looks.
fn dragged() -> Rect {
    dragged_to(got(&POINT_X), got(&POINT_Y))
}

/// Where the drag has got to: the last drag event if the tap has seen any,
/// and the polled pointer if it has not. See `TAPPED_DRAG`.
fn drag_point(polled: (f64, f64)) -> (f64, f64) {
    if TAPPED_DRAG.load(Ordering::SeqCst) {
        (got(&POINT_X), got(&POINT_Y))
    } else {
        polled
    }
}

/// Is a rectangle this size a drag, or a click with a shaky hand?
fn is_drag(rect: Rect) -> bool {
    rect.width > DRAG_SLOP || rect.height > DRAG_SLOP
}

/// Start pointing. Idempotent: a second call while a session is up does nothing.
///
/// Screen recording is the only permission this needs. It used to demand
/// Accessibility as well, and refuse to run without it, which was wrong on the
/// facts: finding the window under the pointer is a hit test against a filtered
/// window list, and nothing about that requires being trusted. Accessibility
/// only buys the levels *below* the window, so it is asked for and then carried
/// on without — see `Stack::chain_at`.
pub fn begin(app: &AppHandle) -> Result<(), String> {
    if !crate::capture::cli::has_permission() {
        crate::capture::cli::request_permission();
        return Err("permission-denied".into());
    }

    // Pressing the capture key again is the second way out, and the one that
    // still works if the outline is not on screen to be seen. The tap passes
    // every key but Escape and L straight through, so the hotkey reaches us
    // even mid-session.
    if ACTIVE.swap(true, Ordering::SeqCst) {
        cancel(app, "the capture key was pressed again");
        return Ok(());
    }

    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    LEVEL.store(0, Ordering::SeqCst);
    SCROLL.store(0, Ordering::SeqCst);
    VERDICT.store(VERDICT_NONE, Ordering::SeqCst);
    PRESSED.store(false, Ordering::SeqCst);
    TAPPED_DRAG.store(false, Ordering::SeqCst);
    REARM.store(false, Ordering::SeqCst);
    WANTED_AX.store(false, Ordering::SeqCst);

    {
        let state = app.state::<SnapState>();
        *state.last_beat.lock().unwrap() = None;
        *state.ready.lock().unwrap() = false;
    }

    if let Err(err) = open_overlays(app) {
        ACTIVE.store(false, Ordering::SeqCst);
        return Err(err);
    }

    commands::conceal_for_capture(app);

    // No tap yet: `snap_ready` starts it, once there is an outline to see.
    spawn_tracker(app.clone(), generation);
    spawn_watchdog(app.clone(), generation);

    eprintln!("[snap] session {generation} open");
    Ok(())
}

/// One transparent, permanently mouse-transparent overlay per display.
///
/// Returns nothing: where each one sits is recorded in `SnapState`, because
/// every later emit needs it to turn a global rectangle into that page's own
/// coordinates.
fn open_overlays(app: &AppHandle) -> Result<(), String> {
    let displays = display::displays().map_err(|e| e.to_string())?;
    if displays.is_empty() {
        return Err("no displays".into());
    }

    let mut opened: Vec<(String, (f64, f64))> = Vec::with_capacity(displays.len());

    for (index, display) in displays.iter().enumerate() {
        let label = format!("{LABEL_PREFIX}{index}");
        let bounds = display.bounds;

        let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("snap.html".into()))
            .title("Shotly Window Capture")
            .position(bounds.x, bounds.y)
            .inner_size(bounds.width, bounds.height)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .shadow(false)
            .resizable(false)
            .skip_taskbar(true)
            .focused(false)
            .build()
            .map_err(|e| e.to_string())?;

        // The one property this whole design rests on, set before the window is
        // ever composited and never turned off again: an overlay that accepts
        // clicks is an overlay the outline would snap to instead of the target,
        // and a desktop nobody can use if the page dies.
        window.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;

        crate::platform::elevate_overlay_window(&window)?;

        opened.push((label, (bounds.x, bounds.y)));
    }

    // Deliberately *not* marked unsharable, though it would keep the outline out
    // of the crop path's screenshot. They don't need to be: the overlays are
    // closed before anything is photographed, and [`SETTLE`] is what makes that
    // true. Marking them would also make the outline invisible to every other
    // recorder — no demo, no screen-share, no bug report could ever show it.
    *app.state::<SnapState>().overlays.lock().unwrap() = opened;
    Ok(())
}

/// Draw this outline, or clear it, on every display.
///
/// The rectangle arrives in global points and each page is handed it in its
/// own, so a window straddling two screens is drawn by both rather than clipped
/// to one. The pages are unchanged by any of this: they still receive
/// coordinates they can use directly, and still decide nothing.
fn show(app: &AppHandle, target: Option<&Highlight>) {
    let overlays = app.state::<SnapState>().overlays.lock().unwrap().clone();
    for (label, (ox, oy)) in overlays {
        let local = target.map(|h| {
            let (x, y) = to_page(Rect { x: h.x, y: h.y, width: h.width, height: h.height }, (ox, oy));
            Highlight { x, y, ..h.clone() }
        });
        let _ = app.emit_to(label.as_str(), "snap:target", local);
    }
}

/// Say something to every overlay at once.
fn tell_overlays(app: &AppHandle, event: &str) {
    let overlays = app.state::<SnapState>().overlays.lock().unwrap().clone();
    for (label, _) in overlays {
        let _ = app.emit_to(label.as_str(), event, ());
    }
}

/// Is any overlay still on screen?
fn overlays_alive(app: &AppHandle) -> bool {
    let overlays = app.state::<SnapState>().overlays.lock().unwrap().clone();
    overlays.iter().any(|(label, _)| app.get_webview_window(label).is_some())
}

/// The page has painted, which is the moment the session becomes real.
///
/// The event tap is started here and nowhere else. Swallowing clicks is only
/// defensible while the user can see what a click would take, so the dangerous
/// half of this feature is made to depend on the visible half: an outline that
/// never paints never costs anybody a click, and the watchdog takes the window
/// down a moment later.
///
/// The outline is also (re)sent from here. The tracker starts working
/// immediately and this page takes a few hundred milliseconds to load, so the
/// first target is routinely worked out before there is anybody listening for
/// it — and if the pointer then does not move, nothing would ever be sent
/// again. That is not a cosmetic failure: it is a dimmed screen, a hint bar,
/// and no outline, which reads as a machine that has stopped working.
#[tauri::command]
pub fn snap_ready(app: AppHandle) {
    let (already, current) = {
        let state = app.state::<SnapState>();
        *state.last_beat.lock().unwrap() = Some(Instant::now());
        let already = std::mem::replace(&mut *state.ready.lock().unwrap(), true);
        let current = state.last.lock().unwrap().clone();
        (already, current)
    };

    show(&app, current.as_ref());

    // Guard against a page that reports ready twice — a reload would otherwise
    // leave two taps fighting over the same click.
    if !already && ACTIVE.load(Ordering::SeqCst) {
        spawn_tap(GENERATION.load(Ordering::SeqCst));
    }
}

#[tauri::command]
pub fn snap_beat(app: AppHandle) {
    *app.state::<SnapState>().last_beat.lock().unwrap() = Some(Instant::now());
}

/// Stop the session and take the overlay down. Safe from any thread, and when
/// nothing is running.
///
/// Every caller says why. A session that ends without saying so is one nobody
/// can diagnose from a log — which is exactly how a tap being switched off by
/// the system came to look like a capture key that did nothing.
pub fn stop(app: &AppHandle, reason: &str) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst);
    if ACTIVE.swap(false, Ordering::SeqCst) {
        eprintln!("[snap] session {generation} closed: {reason}");
    }

    {
        let state = app.state::<SnapState>();
        *state.last_beat.lock().unwrap() = None;
        *state.ready.lock().unwrap() = false;
        *state.last.lock().unwrap() = None;
    }

    let overlays = std::mem::take(&mut *app.state::<SnapState>().overlays.lock().unwrap());
    for (label, _) in overlays {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.close();
        }
    }
}

// -------------------------------------------------------------------- the tap

/// Watch for the click, the wheel and the two keys, and let everything else by.
///
/// The whole callback is a handful of atomic stores. That is the point: a tap
/// whose callback is slow gets switched off by the system mid-session, and the
/// cheapest way to never be slow is to never do anything.
#[cfg(target_os = "macos")]
fn spawn_tap(generation: u64) {
    use core_foundation::runloop::{kCFRunLoopCommonModes, kCFRunLoopDefaultMode, CFRunLoop};
    use core_graphics::event::{
        CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
        CallbackResult, EventField,
    };

    std::thread::spawn(move || {
        fn decide(verdict: u8) {
            // First verdict wins: a click and an Escape in the same tick should
            // not be able to overwrite one another.
            let _ = VERDICT.compare_exchange(
                VERDICT_NONE,
                verdict,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
        }

        let tap = CGEventTap::new(
            CGEventTapLocation::Session,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::Default,
            vec![
                CGEventType::LeftMouseDown,
                CGEventType::LeftMouseUp,
                CGEventType::LeftMouseDragged,
                CGEventType::RightMouseDown,
                CGEventType::RightMouseUp,
                CGEventType::KeyDown,
                CGEventType::KeyUp,
                CGEventType::ScrollWheel,
            ],
            move |_proxy, etype, event| {
                match etype {
                    // The verdict waits for the button to come back up,
                    // because until then a press is not yet a click: the same
                    // gesture becomes a dragged area if the pointer travels.
                    // Reading the location is a struct copy out of the event
                    // that is already in hand — still nothing this callback has
                    // to think about.
                    CGEventType::LeftMouseDown => {
                        let at = event.location();
                        put(&PRESS_X, at.x);
                        put(&PRESS_Y, at.y);
                        put(&POINT_X, at.x);
                        put(&POINT_Y, at.y);
                        TAPPED_DRAG.store(false, Ordering::SeqCst);
                        PRESSED.store(true, Ordering::SeqCst);
                        CallbackResult::Drop
                    }
                    CGEventType::LeftMouseDragged => {
                        let at = event.location();
                        put(&POINT_X, at.x);
                        put(&POINT_Y, at.y);
                        TAPPED_DRAG.store(true, Ordering::SeqCst);
                        CallbackResult::Drop
                    }
                    // The end of the gesture, and where it is decided — on the
                    // two points, not on whether the tracker noticed in time.
                    // A flick drawn and released inside one poll tick is still
                    // a drag, and it is the release that says so.
                    //
                    // Dropped either way: passing it on would leave whatever is
                    // underneath handling a mouse-up it never saw pressed.
                    CGEventType::LeftMouseUp => {
                        let at = event.location();
                        put(&POINT_X, at.x);
                        put(&POINT_Y, at.y);
                        PRESSED.store(false, Ordering::SeqCst);
                        decide(if is_drag(dragged_to(at.x, at.y)) {
                            VERDICT_REGION
                        } else {
                            VERDICT_TAKE
                        });
                        CallbackResult::Drop
                    }
                    CGEventType::RightMouseDown | CGEventType::RightMouseUp => {
                        decide(VERDICT_CANCEL);
                        CallbackResult::Drop
                    }
                    CGEventType::KeyDown | CGEventType::KeyUp => {
                        // Escape and nothing else. A bare letter was tried here
                        // as a shortcut to the window list and taken out again:
                        // a key that silently disappears system-wide is
                        // indistinguishable from a broken keyboard, and the
                        // tray menu reaches the list without that risk. Escape
                        // is safe because it already means "get me out".
                        let code = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                        if code == KEY_ESCAPE {
                            decide(VERDICT_CANCEL);
                            CallbackResult::Drop
                        } else {
                            CallbackResult::Keep
                        }
                    }
                    CGEventType::ScrollWheel => {
                        // A wheel reports whole lines. A trackpad reports pixels
                        // and leaves the line delta at zero, so reading only the
                        // first meant the gesture most Macs actually have did
                        // nothing at all — the wheel appeared to be ignored on
                        // every laptop. Only the sign is used downstream, which
                        // is why no scaling is needed between the two units.
                        let lines = event
                            .get_integer_value_field(EventField::SCROLL_WHEEL_EVENT_DELTA_AXIS_1);
                        let delta = if lines != 0 {
                            lines
                        } else {
                            event.get_integer_value_field(
                                EventField::SCROLL_WHEEL_EVENT_POINT_DELTA_AXIS_1,
                            )
                        };
                        SCROLL.fetch_add(delta, Ordering::Relaxed);
                        CallbackResult::Drop
                    }
                    // The system has switched the tap off — either the callback
                    // was too slow or the user did something that invalidates
                    // it. Rather than re-enable and hope, end the session:
                    // clicks are reaching applications again from this moment,
                    // and an outline that no longer owns the click is a lie.
                    // Not a failure, and not the end of the session. macOS
                    // switches a tap off when it decides the callback was slow,
                    // and the moment it is most likely to decide that is the
                    // first session after launch, when the main thread is busy
                    // bringing up a webview. Ending the session there is what
                    // made the first press of the capture key do nothing.
                    //
                    // Re-enabling is the documented answer, and it is safe here
                    // because the tap is still valid — only switched off. The
                    // loop below does it, so this stays a single store.
                    CGEventType::TapDisabledByTimeout => {
                        REARM.store(true, Ordering::SeqCst);
                        CallbackResult::Keep
                    }
                    // This one is not ours to argue with: it means something
                    // took the input away — secure input, a password field —
                    // and clicks are reaching applications again from this
                    // moment. An outline that no longer owns the click is a lie.
                    CGEventType::TapDisabledByUserInput => {
                        eprintln!("[snap] the tap was disabled by the system; ending the session");
                        decide(VERDICT_CANCEL);
                        CallbackResult::Keep
                    }
                    // Everything else passes through untouched, which is what
                    // keeps ⌘Tab and ⌘Q working while a session is up.
                    _ => CallbackResult::Keep,
                }
            },
        );

        let Ok(tap) = tap else {
            eprintln!("[snap] the system refused an event tap");
            VERDICT.store(VERDICT_CANCEL, Ordering::SeqCst);
            return;
        };

        // SAFETY: the run loop source belongs to this thread's run loop, and
        // both are dropped together when this function returns.
        unsafe {
            let Ok(source) = tap.mach_port().create_runloop_source(0) else {
                eprintln!("[snap] the event tap has no run loop source");
                VERDICT.store(VERDICT_CANCEL, Ordering::SeqCst);
                return;
            };
            CFRunLoop::get_current().add_source(&source, kCFRunLoopCommonModes);
            tap.enable();

            let deadline = Instant::now() + MAX_SESSION;
            let mut rearms = 0;
            // Pumped in slices rather than run outright, so this thread notices
            // the session ending without needing anyone to reach in and stop
            // its run loop — and so the deadline is its own to enforce. The
            // slices are also what give the tap somewhere to be switched back
            // on from, without the callback doing more than a store.
            while is_current(generation) && Instant::now() < deadline {
                CFRunLoop::run_in_mode(kCFRunLoopDefaultMode, Duration::from_millis(100), false);

                if REARM.swap(false, Ordering::SeqCst) {
                    rearms += 1;
                    // Bounded, because a callback that is genuinely too slow
                    // would otherwise be switched off and on for the whole
                    // session while every click vanished into it.
                    if rearms > MAX_REARMS {
                        eprintln!("[snap] the tap keeps being disabled; ending the session");
                        VERDICT.store(VERDICT_CANCEL, Ordering::SeqCst);
                        break;
                    }
                    eprintln!("[snap] the tap was disabled on a slow tick; switching it back on");
                    tap.enable();
                }
            }

            if is_current(generation) {
                eprintln!("[snap] session hit its deadline; releasing the mouse");
                VERDICT.store(VERDICT_CANCEL, Ordering::SeqCst);
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn spawn_tap(_generation: u64) {}

// ---------------------------------------------------------------- the tracker

/// Follow the pointer, and act on whatever the tap decided.
fn spawn_tracker(app: AppHandle, generation: u64) {
    std::thread::spawn(move || {
        let stack = Stack::take();
        // Read once, like the window list and for the same reason: nothing can
        // be moved or rearranged while the tap holds the mouse.
        let screens = display::displays().unwrap_or_default();
        let mut shown: Option<Highlight> = None;
        let mut aim: Option<Aim> = None;
        // When the button went down, for the hold that starts an area.
        let mut held: Option<Instant> = None;
        let mut anchor: Option<Anchor> = None;
        // Where the pointer was, and at what level, the last time the outline
        // was worked out.
        let mut last: Option<(f64, f64, i32)> = None;

        while is_current(generation) {
            match VERDICT.swap(VERDICT_NONE, Ordering::SeqCst) {
                VERDICT_TAKE => {
                    // What the outline was on at the instant of the click, not
                    // what is under the pointer now — those differ by a frame
                    // and the user chose the one they could see.
                    let chosen = aim.clone();
                    stop(&app, "a target was taken");
                    ask_for_accessibility();
                    match chosen {
                        Some(chosen) => finish(&app, chosen),
                        None => commands::reveal_after_capture(&app),
                    }
                    return;
                }
                VERDICT_REGION => {
                    let rect = dragged();
                    stop(&app, "an area was dragged");
                    ask_for_accessibility();
                    // A drag that ended almost where it started is somebody
                    // changing their mind, not a two-point capture.
                    if rect.width >= MIN_REGION && rect.height >= MIN_REGION {
                        finish(&app, Aim::Region(rect));
                    } else {
                        commands::reveal_after_capture(&app);
                    }
                    return;
                }
                VERDICT_CANCEL => {
                    stop(&app, "cancelled");
                    ask_for_accessibility();
                    commands::reveal_after_capture(&app);
                    return;
                }
                _ => {}
            }

            // One level per tick at most, so a trackpad flick walks the
            // ancestry rather than jumping to the bottom of it.
            let wheel = SCROLL.swap(0, Ordering::Relaxed);
            let mut level = LEVEL.load(Ordering::SeqCst);
            if wheel != 0 {
                level = (level + if wheel > 0 { -1 } else { 1 }).max(0);
                LEVEL.store(level, Ordering::SeqCst);

                // Tightening onto what is inside a window is the one thing here
                // that needs accessibility. Without it the wheel does nothing at
                // all, which reads as a broken feature rather than a locked one,
                // so say so on the overlay and ask once the session is over.
                if !ax::trusted() && !WANTED_AX.swap(true, Ordering::SeqCst) {
                    tell_overlays(&app, "snap:needs-accessibility");
                }
            }

            let Some((x, y)) = cursor() else {
                std::thread::sleep(POLL);
                continue;
            };

            // The button is down. Once it has travelled — or simply been held
            // — this is an area being dragged out, not something being pointed
            // at, so the whole resolve, which is the expensive half of this
            // loop, is skipped. Drawn from the pointer this loop already polls,
            // so it follows a drag however the drag reaches the machine.
            let pressed = PRESSED.load(Ordering::SeqCst);
            if !pressed {
                held = None;
            } else if held.is_none() {
                held = Some(Instant::now());
            }

            let (dx, dy) = drag_point((x, y));
            let rect = dragged_to(dx, dy);
            let holding = held.is_some_and(|since| since.elapsed() >= HOLD_HINT);
            if pressed && (is_drag(rect) || holding) {
                // Before the pointer has gone anywhere there is no rectangle to
                // show, so the overlay is told where the corner is instead and
                // draws crosshairs on it. Saying "an area starts here" is the
                // whole job: an outline that does not change when the button
                // goes down is why this looked like nothing was happening.
                let started = is_drag(rect);
                let band = Highlight {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                    label: if started { "Selection".into() } else { "Drag out an area".into() },
                    size: if started {
                        format!("{} × {}", rect.width.round(), rect.height.round())
                    } else {
                        String::new()
                    },
                    level: 0,
                    depth: 0,
                    window: false,
                    drag: true,
                };
                if shown.as_ref() != Some(&band) {
                    shown = Some(band.clone());
                    *app.state::<SnapState>().last.lock().unwrap() = Some(band.clone());
                    show(&app, Some(&band));
                }
                // The pointer has moved a long way by the time a band is let
                // go, and the cached answer belongs to where it started.
                last = None;
                std::thread::sleep(DRAG_POLL);
                continue;
            }

            // A tick where nothing has moved does no work. Level 0 is now only
            // a hit test against a list already in hand and would be cheap to
            // repeat, but the levels below it are still IPC to another
            // application — as many as fifty round trips once the chain is
            // being walked — and the pointer is still for most of a session.
            //
            // Only ever skipped while something is being shown. Caching a
            // *failure* is what made this feature look broken once before: the
            // first resolve could fail, and a pointer which then never moved
            // left a dimmed screen with no outline on it for the whole session.
            if shown.is_some() && last == Some((x, y, level)) {
                std::thread::sleep(POLL);
                continue;
            }
            last = Some((x, y, level));

            // A window if the pointer is on one, and the screen it is on if it
            // is not. Pointing at the desktop used to mean pointing at nothing:
            // no outline, and a click that ended the session having taken
            // nothing at all.
            let found = match resolve(&stack, x, y, level, &mut anchor) {
                Some((node, highlight)) => Some((Aim::Window(node), highlight)),
                None => whole_screen(&screens, x, y),
            };
            let (found, next) = match found {
                Some((found, highlight)) => (Some(found), Some(highlight)),
                None => (None, None),
            };

            if next != shown {
                shown = next.clone();
                aim = found;
                // Recorded before it is sent, so that a page which is not
                // listening yet can be given it on `snap_ready`.
                *app.state::<SnapState>().last.lock().unwrap() = next.clone();
                show(&app, next.as_ref());
            }

            std::thread::sleep(POLL);
        }
    });
}

/// The windows on screen when the session began, front to back.
///
/// Taken once rather than polled. Nothing can move while a session is up — the
/// tap swallows every click and every scroll — so re-reading the list forty
/// times a second would spend the whole session confirming that the desktop is
/// exactly as it was.
struct Stack(Vec<crate::capture::WindowInfo>);

/// Everything on screen that the pointer could land on, front to back.
///
/// Shared with the scrolling capture's own selection overlay, which offers the
/// same snap-to-a-window that this one does. One definition of "what can be
/// pointed at" rather than two, because two would drift — and the last time a
/// capture path drifted from its twin, one of them spent months photographing
/// every open window while the other drew an outline.
pub fn pointable_windows() -> Vec<crate::capture::WindowInfo> {
    let mine = std::process::id() as i32;
    crate::capture::display::windows()
        .unwrap_or_default()
        .into_iter()
        .filter(|w| is_pointable(w, mine))
        .collect()
}

/// Can the pointer land on this window?
///
/// Ordinary application windows only — layer 0, not full screen, not ours. See
/// `Stack::take` for why full screen in particular has to go.
fn is_pointable(w: &crate::capture::WindowInfo, mine: i32) -> bool {
    w.layer == 0 && !w.full_screen && w.pid != mine
}

impl Stack {
    /// What is on screen and can actually be pointed at.
    ///
    /// Stricter than the list the thumbnail picker shows, and the difference is
    /// the whole reason this outline works. `display::windows` already drops
    /// the desktop, the fully transparent, the system chrome and the slivers,
    /// but it deliberately keeps full-screen windows so the picker can list a
    /// full-screen app and say why it cannot be captured by id. A hit test must
    /// not: a full-screen window sits at layer 1000, above everything, covering
    /// the whole display — and macOS reports it as on screen even when it is on
    /// another Space entirely. Keep it and the answer is that same window
    /// wherever you point, which is exactly the phantom that killed the first
    /// version of this feature. Ordinary windows only.
    ///
    /// Shotly's own go too, by process as well as by name: the outline overlay
    /// is on screen, under the pointer, for the whole session.
    fn take() -> Self {
        Stack(pointable_windows())
    }

    /// The window a click here would land on.
    ///
    /// The list arrives ordered front to back, so the first one whose frame
    /// holds the point is the answer — the same question `hitTestWindowInfo:`
    /// answers in Snagit, and answered the same way. What made an earlier
    /// version of this outline pick phantom windows was not the window list; it
    /// was asking the window list without filtering it first.
    fn hit(&self, x: f64, y: f64) -> Option<ax::Node> {
        self.0
            .iter()
            .find(|w| {
                x >= w.bounds.x
                    && y >= w.bounds.y
                    && x < w.bounds.x + w.bounds.width
                    && y < w.bounds.y + w.bounds.height
            })
            .map(|w| ax::Node {
                rect: w.bounds,
                role: "AXWindow".into(),
                title: if w.title.is_empty() { w.app_name.clone() } else { w.title.clone() },
                pid: w.pid,
                window: true,
            })
    }

    /// The window under the pointer, and — where accessibility is granted —
    /// what is inside it.
    ///
    /// The window itself never comes from accessibility now. It does not need
    /// to: finding the window is a hit test against a filtered list, which is
    /// free and works on every Mac. Accessibility buys exactly one thing here,
    /// which is the ability to tighten onto a toolbar or a single row once you
    /// are already on the right window, and it is skipped silently when it has
    /// not been granted rather than gating the feature behind it.
    fn chain_at(&self, x: f64, y: f64) -> Vec<ax::Node> {
        let Some(window) = self.hit(x, y) else { return Vec::new() };
        let mut chain = vec![window];
        if ax::trusted() {
            let inner = ax::refine(ax::chain_at(x, y), x, y);
            chain.extend(inner.into_iter().filter(|n| !n.window));
        }
        chain
    }
}

/// What to draw at a point, or `None` where nothing can be captured.
///
/// Level 0 is deliberately not the same code path as the rest: it only needs
/// the window, which is a hit test against a list already in hand, and it is
/// where the pointer spends almost all of its time.
fn resolve(
    stack: &Stack,
    x: f64,
    y: f64,
    level: i32,
    anchor: &mut Option<Anchor>,
) -> Option<(ax::Node, Highlight)> {
    let (window, mut node, mut level, depth) = if level == 0 {
        let window = stack.hit(x, y)?;
        (window.clone(), window, 0, 0)
    } else {
        let chain = stack.chain_at(x, y);
        let depth = chain.len() as i32;
        let window = chain.first()?.clone();
        let node = ax::at_level(&chain, level)?.clone();
        // Clamped rather than refused, so the caption agrees with the outline
        // once the ancestry runs out.
        (window, node, level.min((depth - 1).max(0)), depth)
    };

    // Having drilled three levels into one window, moving to another should
    // not land three levels into that one too.
    let here = Anchor { pid: window.pid, rect: window.rect };
    if anchor.is_some_and(|previous| !previous.same_window_as(here)) {
        LEVEL.store(0, Ordering::SeqCst);
        node = window.clone();
        level = 0;
    }
    *anchor = Some(here);

    if node.rect.is_empty() {
        return None;
    }

    // Global points. Each overlay is handed these in its own coordinates when
    // they are drawn — see `show`.
    let highlight = Highlight {
        x: node.rect.x,
        y: node.rect.y,
        width: node.rect.width,
        height: node.rect.height,
        label: caption(&node),
        size: format!("{} × {}", node.rect.width.round(), node.rect.height.round()),
        level,
        depth,
        window: node.window,
        drag: false,
    };

    Some((node, highlight))
}

/// The display the pointer is on, offered whole.
///
/// What makes the all-in-one all-in-one: with no window under the pointer
/// there is still something worth taking, and it is the thing the desktop is
/// showing. Nothing here needs accessibility or a window list — a point in a
/// rectangle is the entire question.
fn whole_screen(screens: &[crate::capture::DisplayInfo], x: f64, y: f64) -> Option<(Aim, Highlight)> {
    let bounds = screens
        .iter()
        .find(|d| {
            let b = d.bounds;
            x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height
        })?
        .bounds;

    let highlight = Highlight {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        label: "Whole screen".into(),
        size: format!("{} × {}", bounds.width.round(), bounds.height.round()),
        level: 0,
        depth: 0,
        window: false,
        drag: false,
    };

    Some((Aim::Screen(bounds), highlight))
}

/// Global point space to the overlay page's own coordinates.
///
/// They differ by the origin of the display that page covers, which is zero
/// only for a primary display at the top left — a screen placed above or to the
/// left of it has a negative origin, and every overlay has its own.
fn to_page(rect: Rect, origin: (f64, f64)) -> (f64, f64) {
    (rect.x - origin.0, rect.y - origin.1)
}

fn near(a: Rect, b: Rect) -> bool {
    (a.x - b.x).abs() <= BOUNDS_SLACK
        && (a.y - b.y).abs() <= BOUNDS_SLACK
        && (a.width - b.width).abs() <= BOUNDS_SLACK
        && (a.height - b.height).abs() <= BOUNDS_SLACK
}

/// What to call the thing under the pointer.
///
/// A window says what it is; an element inside one rarely has a title, so it
/// falls back to its role with the `AX` filed off — "Button" reads better than
/// "AXButton" and carries the same information.
fn caption(node: &ax::Node) -> String {
    if !node.title.is_empty() {
        return node.title.clone();
    }
    let role = node.role.strip_prefix("AX").unwrap_or(&node.role);
    if role.is_empty() {
        "Window".into()
    } else {
        role.to_string()
    }
}

// ---------------------------------------------------------------- the capture

/// Take what was pointed at — or dragged out — and open it in the editor.
fn finish(app: &AppHandle, aim: Aim) {
    // The overlay is closed by now, but closing is not the same as gone: the
    // crop path photographs the screen, and a window the compositor has yet to
    // drop would still be in the picture.
    std::thread::sleep(SETTLE);

    match capture(app, &aim) {
        Ok(frame) => {
            if let Err(err) = commands::deliver(app, frame) {
                eprintln!("[snap] could not open the capture: {err}");
                commands::reveal_after_capture(app);
            }
        }
        Err(err) => {
            commands::reveal_after_capture(app);
            let _ = app.emit("capture:error", err);
        }
    }
}

fn capture(app: &AppHandle, aim: &Aim) -> Result<Frame, String> {
    let state = app.state::<AppState>();

    let rect = match aim {
        // A whole window is better taken by id: that reads the window's own
        // backing store, so anything overlapping it is simply not in the
        // picture. Falling back to the screen matters more than it sounds — a
        // full-screen window cannot be captured by id at all, and it is exactly
        // the size of a display, so cropping the screen to it gives the same
        // pixels.
        Aim::Window(node) => {
            if node.window {
                if let Some(id) = window_id_for(&state, node) {
                    match state.backend.capture_window(id) {
                        Ok(frame) => return Ok(frame),
                        Err(err) => {
                            eprintln!("[snap] window {id} could not be captured by id: {err}")
                        }
                    }
                }
            }
            node.rect
        }
        // A screen and an area are the same operation: photograph the display
        // and cut a rectangle out of it. For a screen the rectangle happens to
        // be the whole thing.
        Aim::Screen(rect) | Aim::Region(rect) => *rect,
    };

    crop_screen(&state, rect)
}

/// The CGWindowID behind an accessibility window.
///
/// There is no public call for this, so the two lists are matched on the two
/// things they agree about: the owning process, and the frame — which were
/// measured to be identical, not merely close. Process identity is what makes
/// it safe; two windows of *different* apps can easily share a frame, two
/// windows of the same app rarely do, and the list is ordered front to back so
/// the first match is the one that was in front.
fn window_id_for(state: &AppState, node: &ax::Node) -> Option<u32> {
    let windows = state.backend.list_windows().ok()?;
    windows
        .iter()
        .find(|w| w.pid == node.pid && !w.full_screen && near(w.bounds, node.rect))
        .map(|w| w.id)
}

fn crop_screen(state: &AppState, rect: Rect) -> Result<Frame, String> {
    let frames = state.backend.capture_displays().map_err(|e| e.to_string())?;

    // Whichever display holds most of the target. A window straddling two
    // screens is captured from the one it is mostly on, which is the only
    // answer a single crop can give.
    let frame = frames
        .iter()
        .max_by(|a, b| overlap(a.bounds, rect).total_cmp(&overlap(b.bounds, rect)))
        .filter(|f| overlap(f.bounds, rect) > 0.0)
        .ok_or("that is not on any display")?;

    state.backend.crop(frame, rect).map_err(|e| e.to_string())
}

fn overlap(a: Rect, b: Rect) -> f64 {
    a.intersect(&b).map(|r| r.width * r.height).unwrap_or(0.0)
}

// --------------------------------------------------------------- the watchdog

/// End the session if the outline never appears, or stops moving.
///
/// The tap is swallowing clicks for as long as this runs. An overlay that has
/// died is one the user cannot see, which makes every click they try a click
/// into nothing — so silence has to end the session, not merely be logged.
fn spawn_watchdog(app: AppHandle, generation: u64) {
    std::thread::spawn(move || {
        let opened = Instant::now();

        while is_current(generation) {
            std::thread::sleep(Duration::from_millis(500));

            if !is_current(generation) {
                return;
            }

            // Gone the ordinary way, with the tracker still tidying up.
            if !overlays_alive(&app) {
                return;
            }

            let (ready, beat) = {
                let state = app.state::<SnapState>();
                let ready = *state.ready.lock().unwrap();
                let beat = *state.last_beat.lock().unwrap();
                (ready, beat)
            };

            let dead = if ready {
                beat.is_none_or(|last| last.elapsed() > HEARTBEAT_GRACE)
            } else {
                opened.elapsed() > READY_GRACE
            };

            if dead {
                eprintln!("[snap] the outline stopped answering; ending the session");
                VERDICT.store(VERDICT_CANCEL, Ordering::SeqCst);
                return;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect { x, y, width, height }
    }

    /// The press and pointer cells are one set of globals for one session, and
    /// the tests run in parallel threads. Whoever is using them takes this.
    static PROBE: Mutex<()> = Mutex::new(());

    fn win(id: u32, pid: i32, title: &str, bounds: Rect) -> crate::capture::WindowInfo {
        crate::capture::WindowInfo {
            id,
            title: title.into(),
            app_name: "App".into(),
            bounds,
            layer: 0,
            pid,
            full_screen: false,
        }
    }

    fn screen(x: f64, y: f64, width: f64, height: f64) -> crate::capture::DisplayInfo {
        crate::capture::DisplayInfo {
            id: 1,
            bounds: rect(x, y, width, height),
            scale: 2.0,
            is_primary: true,
        }
    }

    /// A rectangle is whatever two corners were involved, in whichever order
    /// they were named: people drag up and to the left as readily as down and
    /// to the right, and a negative width is not a selection anyone can crop.
    #[test]
    fn an_area_is_the_same_whichever_way_it_was_dragged() {
        let _probe = PROBE.lock().unwrap();
        put(&PRESS_X, 400.0);
        put(&PRESS_Y, 300.0);
        put(&POINT_X, 100.0);
        put(&POINT_Y, 120.0);
        assert_eq!(dragged(), rect(100.0, 120.0, 300.0, 180.0));

        put(&PRESS_X, 100.0);
        put(&PRESS_Y, 120.0);
        put(&POINT_X, 400.0);
        put(&POINT_Y, 300.0);
        assert_eq!(dragged(), rect(100.0, 120.0, 300.0, 180.0));
    }

    /// A dragged event this tap drops never reaches the window server, so the
    /// pointer can sit still on screen for the whole gesture. Believing it
    /// there is what left the crosshairs pinned to the press point while the
    /// user dragged — so the events win whenever there are events.
    #[test]
    fn the_drag_is_followed_by_its_events_not_by_the_frozen_pointer() {
        let _probe = PROBE.lock().unwrap();
        put(&PRESS_X, 100.0);
        put(&PRESS_Y, 100.0);
        put(&POINT_X, 400.0);
        put(&POINT_Y, 300.0);

        // The pointer has not moved off the press point; the events say it has.
        TAPPED_DRAG.store(true, Ordering::SeqCst);
        assert_eq!(drag_point((100.0, 100.0)), (400.0, 300.0));
        assert_eq!(dragged_to_point((100.0, 100.0)), rect(100.0, 100.0, 300.0, 200.0));

        // And with no drag events at all, the pointer is all there is.
        TAPPED_DRAG.store(false, Ordering::SeqCst);
        assert_eq!(drag_point((250.0, 260.0)), (250.0, 260.0));
        assert_eq!(dragged_to_point((250.0, 260.0)), rect(100.0, 100.0, 150.0, 160.0));
    }

    fn dragged_to_point(polled: (f64, f64)) -> Rect {
        let (x, y) = drag_point(polled);
        dragged_to(x, y)
    }

    /// Pressing hard enough to mean it moves the pointer a point or two, and
    /// that has to stay a click on the window rather than become a selection
    /// three pixels across.
    #[test]
    fn a_click_with_a_shaky_hand_is_still_a_click() {
        let _probe = PROBE.lock().unwrap();
        put(&PRESS_X, 500.0);
        put(&PRESS_Y, 500.0);
        assert!(!is_drag(dragged_to(502.0, 497.0)));
        assert!(!is_drag(dragged_to(506.0, 506.0)));
        // And a gesture anyone meant is far past it.
        assert!(is_drag(dragged_to(520.0, 501.0)));
        assert!(is_drag(dragged_to(500.0, 460.0)));
    }

    /// Pointing at the desktop used to mean pointing at nothing: no outline,
    /// and a click that ended the session having taken nothing at all.
    #[test]
    fn the_desktop_offers_the_screen_it_belongs_to() {
        // Two displays side by side, the second one to the left of the first.
        let screens = [screen(0.0, 0.0, 1512.0, 982.0), screen(-2560.0, -200.0, 2560.0, 1440.0)];

        let (aim, highlight) = whole_screen(&screens, 700.0, 500.0).expect("the pointer is on one");
        assert!(matches!(aim, Aim::Screen(r) if r == rect(0.0, 0.0, 1512.0, 982.0)));
        assert_eq!(highlight.width, 1512.0);
        assert!(!highlight.drag);

        // The one with a negative origin is found by the same arithmetic, and
        // it is the reason the test has two: a display placed above or to the
        // left of the primary is where an off-by-origin bug shows up.
        let (aim, _) = whole_screen(&screens, -1000.0, 100.0).expect("the pointer is on the other");
        assert!(matches!(aim, Aim::Screen(r) if r == rect(-2560.0, -200.0, 2560.0, 1440.0)));

        // And a point on neither is nothing to offer, not the nearest guess.
        assert!(whole_screen(&screens, 5000.0, 5000.0).is_none());
    }

    #[test]
    fn a_full_screen_window_cannot_be_pointed_at() {
        // The phantom this outline died of once. A full-screen window is
        // reported on screen even when it is on another Space, sits at layer
        // 1000 above everything, and covers the display — so keeping it means
        // every hit test answers with it, wherever the pointer is.
        let full = crate::capture::WindowInfo {
            full_screen: true,
            layer: 1000,
            ..win(1, 10, "Full", rect(0.0, 0.0, 1512.0, 982.0))
        };
        assert!(!is_pointable(&full, 999));
        assert!(is_pointable(&win(2, 11, "Ordinary", rect(0.0, 0.0, 900.0, 600.0)), 999));
    }

    #[test]
    fn our_own_windows_cannot_be_pointed_at() {
        // The outline overlay is on screen, under the pointer, all session.
        let ours = win(3, 42, "Outline", rect(0.0, 0.0, 1512.0, 982.0));
        assert!(!is_pointable(&ours, 42));
        assert!(is_pointable(&ours, 43));
    }

    #[test]
    fn the_hit_test_takes_the_frontmost_window_over_the_point() {
        // Front to back, as the window list arrives, and overlapping.
        let stack = Stack(vec![
            win(1, 10, "Front", rect(0.0, 0.0, 100.0, 100.0)),
            win(2, 11, "Behind", rect(50.0, 50.0, 100.0, 100.0)),
        ]);

        // Inside both: the one in front wins.
        assert_eq!(stack.hit(60.0, 60.0).unwrap().title, "Front");
        // Inside only the one behind.
        assert_eq!(stack.hit(120.0, 120.0).unwrap().title, "Behind");
        // Outside both.
        assert!(stack.hit(400.0, 400.0).is_none());
    }

    #[test]
    fn the_hit_test_excludes_the_far_edges() {
        let stack = Stack(vec![win(1, 10, "One", rect(0.0, 0.0, 100.0, 100.0))]);

        // The near edges belong to the window; the far ones are the next pixel
        // along, so two windows sharing an edge cannot both claim it.
        assert!(stack.hit(0.0, 0.0).is_some());
        assert!(stack.hit(99.9, 99.9).is_some());
        assert!(stack.hit(100.0, 50.0).is_none());
        assert!(stack.hit(50.0, 100.0).is_none());
    }

    #[test]
    fn a_hit_window_carries_its_own_process_and_frame() {
        // What `window_id_for` matches back on, so it has to survive the trip.
        let stack = Stack(vec![win(7, 42, "Notes", rect(10.0, 20.0, 300.0, 400.0))]);
        let node = stack.hit(50.0, 50.0).unwrap();

        assert_eq!(node.pid, 42);
        assert_eq!(node.rect, rect(10.0, 20.0, 300.0, 400.0));
        assert!(node.window);
    }

    #[test]
    fn an_untitled_window_is_named_after_its_app() {
        let stack = Stack(vec![win(1, 10, "", rect(0.0, 0.0, 100.0, 100.0))]);
        assert_eq!(stack.hit(10.0, 10.0).unwrap().title, "App");
    }

    #[test]
    fn a_rectangle_is_near_itself_and_nothing_far() {
        assert!(near(rect(10.0, 10.0, 100.0, 50.0), rect(11.0, 9.0, 100.5, 50.0)));
        assert!(!near(rect(10.0, 10.0, 100.0, 50.0), rect(10.0, 10.0, 110.0, 50.0)));
    }

    #[test]
    fn overlap_prefers_the_display_holding_most_of_the_target() {
        let left = rect(0.0, 0.0, 1000.0, 800.0);
        let right = rect(1000.0, 0.0, 1000.0, 800.0);
        // Mostly on the right-hand display.
        let window = rect(900.0, 100.0, 400.0, 200.0);
        assert!(overlap(right, window) > overlap(left, window));
        assert_eq!(overlap(left, rect(2000.0, 0.0, 10.0, 10.0)), 0.0);
    }

    #[test]
    fn a_caption_falls_back_from_title_to_role() {
        let node = |title: &str, role: &str| ax::Node {
            rect: rect(0.0, 0.0, 10.0, 10.0),
            role: role.into(),
            title: title.into(),
            pid: 1,
            window: false,
        };
        assert_eq!(caption(&node("Downloads", "AXWindow")), "Downloads");
        assert_eq!(caption(&node("", "AXButton")), "Button");
        assert_eq!(caption(&node("", "")), "Window");
    }

    #[test]
    fn each_overlay_is_handed_the_outline_in_its_own_coordinates() {
        // One overlay per display, each offset by the display it covers. The
        // same global rectangle therefore has a different position in each
        // page, which is what lets a window straddling two screens be drawn by
        // both instead of clipped to one.
        let window = rect(-1000.0, -100.0, 900.0, 600.0);
        // On a second display placed above and to the left of the primary.
        assert_eq!(to_page(window, (-2048.0, -253.0)), (1048.0, 153.0));
        // The primary display's own overlay sees it off to the left, negative.
        assert_eq!(to_page(window, (0.0, 0.0)), (-1000.0, -100.0));
        // The ordinary single-screen case changes nothing.
        assert_eq!(to_page(rect(13.0, 51.0, 1484.0, 838.0), (0.0, 0.0)), (13.0, 51.0));
    }

    #[test]
    fn an_anchor_tolerates_drift_but_not_a_different_window() {
        let a = Anchor { pid: 42, rect: rect(13.0, 51.0, 1484.0, 838.0) };
        // The same window, measured mid-animation.
        assert!(a.same_window_as(Anchor { pid: 42, rect: rect(13.5, 51.0, 1484.0, 837.5) }));
        // Another application's window that happens to be the same size.
        assert!(!a.same_window_as(Anchor { pid: 99, rect: rect(13.0, 51.0, 1484.0, 838.0) }));
        // The same application, a different window.
        assert!(!a.same_window_as(Anchor { pid: 42, rect: rect(200.0, 51.0, 1484.0, 838.0) }));
    }
}
