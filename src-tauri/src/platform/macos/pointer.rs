//! Where the pointer is, and what is underneath it.
//!
//! Both are asked from three or four places — the annotation layer wants to know which screen to open
//! on, the capture backend wants the scale of the display a selection was made
//! on, the window outline wants the window under the cursor. They used to be
//! answered by three identical copies of the same six lines; this is the copy
//! that survived.
//!
//! The hit test lives next door in [`ax`](super::ax), which has a long account
//! of why the accessibility API answers "what would a click here land on"
//! correctly where the window list does not.
//!
//! # Three questions, not two
//!
//! The third is who owns the click, and it is the largest thing here: the
//! `CGEventTap` a window-pick session takes the mouse with. See the banner
//! above it for why a tap rather than a window, and what keeps it safe.

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicU8, Ordering};
use std::time::{Duration, Instant};

/// Where the pointer is, in global point space with a top-left origin.
///
/// Read from the HID system state rather than from an event, so it is the
/// pointer's position now and not where some event happened to be.
pub fn cursor() -> Option<(f64, f64)> {
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState).ok()?;
    let point = CGEvent::new(source).ok()?.location();
    Some((point.x, point.y))
}

// ------------------------------------------------- what is under the pointer
//
// The long argument for why this uses the accessibility API rather than the
// window list is at the top of `crate::ax`, along with the geometry that
// interprets what comes back. Only the asking is here.

/// How long to wait for an application to answer before giving up on it.
///
/// A beachballing app must cost the outline a frame, not the session.
const MESSAGING_TIMEOUT: f32 = 0.2;

/// Never walk further than this up the ancestry.
///
/// Deep hierarchies are not merely common, they are the norm: measured inside a
/// web-based application, a point in the middle of the content was **24**
/// elements from its window, twenty-one of which had the identical frame. A cap
/// of 24 was not enough to reach the window at all — which is the other half of
/// why [`chain_at`] asks for the window directly rather than hoping to walk to
/// it. This bound only exists so that an application exposing a pathological
/// tree costs a frame instead of a session.
const MAX_WALK: usize = 48;

use crate::ax::Node;
use crate::capture::Rect;
use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
use core_foundation::string::{CFString, CFStringRef};
use std::ffi::c_void;

type AXUIElementRef = *const c_void;
type AXError = i32;

const SUCCESS: AXError = 0;
/// `kAXValueTypeCGPoint` / `kAXValueTypeCGSize`.
const VALUE_CGPOINT: u32 = 1;
const VALUE_CGSIZE: u32 = 2;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCopyElementAtPosition(
        application: AXUIElementRef,
        x: f32,
        y: f32,
        element: *mut AXUIElementRef,
    ) -> AXError;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> AXError;
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout: f32) -> AXError;
    fn AXValueGetValue(value: CFTypeRef, the_type: u32, value_ptr: *mut c_void) -> u8;
    fn AXIsProcessTrusted() -> u8;
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> u8;
    static kAXTrustedCheckOptionPrompt: CFStringRef;
}

/// An owned `AXUIElementRef`.
///
/// Every element that arrives here comes from a Copy-rule call, so each one
/// owns a reference that has to go back. Doing that by hand across a walk
/// with this many early exits is how leaks happen.
struct El(AXUIElementRef);

impl Drop for El {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: created under the copy rule and released exactly once.
            unsafe { CFRelease(self.0 as _) };
        }
    }
}

impl El {
    /// Read one attribute, as an owned CFType. `None` covers both "no such
    /// attribute" and "the application did not answer in time".
    fn attribute(&self, name: &str) -> Option<CFTypeRef> {
        let key = CFString::new(name);
        let mut value: CFTypeRef = std::ptr::null();
        // SAFETY: `self.0` is live, and `value` is only read on success.
        let err = unsafe {
            AXUIElementCopyAttributeValue(self.0, key.as_concrete_TypeRef(), &mut value)
        };
        if err != SUCCESS || value.is_null() {
            return None;
        }
        Some(value)
    }

    fn element_attribute(&self, name: &str) -> Option<El> {
        let value = self.attribute(name)?;
        let el = El(value as AXUIElementRef);
        // SAFETY: bounding every request to this element too — the timeout
        // is per-element, not inherited from the one it came from.
        unsafe { AXUIElementSetMessagingTimeout(el.0, MESSAGING_TIMEOUT) };
        Some(el)
    }

    fn string_attribute(&self, name: &str) -> Option<String> {
        let value = self.attribute(name)?;
        // SAFETY: the value is a CFStringRef we own; wrapping under the
        // create rule hands that ownership to the wrapper.
        let s = unsafe { CFString::wrap_under_create_rule(value as CFStringRef) };
        Some(s.to_string())
    }

    /// Position and size, as one rectangle in global point space.
    fn frame(&self) -> Option<Rect> {
        let position = self.attribute("AXPosition")?;
        let size = self.attribute("AXSize")?;

        let mut origin = [0f64; 2];
        let mut extent = [0f64; 2];

        // SAFETY: both values are AXValueRefs of the types asked for; the
        // destinations are CGPoint- and CGSize-shaped pairs of f64.
        let ok = unsafe {
            let a = AXValueGetValue(position, VALUE_CGPOINT, origin.as_mut_ptr() as *mut c_void);
            let b = AXValueGetValue(size, VALUE_CGSIZE, extent.as_mut_ptr() as *mut c_void);
            CFRelease(position as _);
            CFRelease(size as _);
            a != 0 && b != 0
        };

        if !ok {
            return None;
        }

        Some(Rect { x: origin[0], y: origin[1], width: extent[0], height: extent[1] })
    }

    fn pid(&self) -> i32 {
        let mut pid = 0;
        // SAFETY: `self.0` is live; `pid` is left at 0 on failure.
        unsafe { AXUIElementGetPid(self.0, &mut pid) };
        pid
    }

    fn node(&self, window: bool) -> Option<Node> {
        Some(Node {
            rect: self.frame()?,
            role: self.string_attribute("AXRole").unwrap_or_default(),
            title: self.string_attribute("AXTitle").unwrap_or_default(),
            pid: self.pid(),
            window,
        })
    }
}

fn system_wide() -> El {
    // SAFETY: returns a new system-wide element under the create rule.
    let el = El(unsafe { AXUIElementCreateSystemWide() });
    // SAFETY: the element is live; bounding how long a hit test may block.
    unsafe { AXUIElementSetMessagingTimeout(el.0, MESSAGING_TIMEOUT) };
    el
}

/// The deepest element at a point, in global top-left coordinates.
fn hit(x: f64, y: f64) -> Option<El> {
    let sys = system_wide();
    let mut element: AXUIElementRef = std::ptr::null();
    // SAFETY: `element` is only wrapped when the call reports success.
    let err = unsafe {
        AXUIElementCopyElementAtPosition(sys.0, x as f32, y as f32, &mut element)
    };
    if err != SUCCESS || element.is_null() {
        return None;
    }
    let el = El(element);
    // SAFETY: as above — a per-element bound on every later request.
    unsafe { AXUIElementSetMessagingTimeout(el.0, MESSAGING_TIMEOUT) };
    Some(el)
}

pub fn trusted() -> bool {
    // SAFETY: no arguments, no ownership.
    unsafe { AXIsProcessTrusted() != 0 }
}

/// Ask for accessibility access, showing the system's own prompt.
///
/// Two things happen, and the second matters more than the first. macOS
/// shows its dialog — but only the first time it is ever asked; after that
/// this is a silent no. What it also does, every time, is put Shotly into
/// the Accessibility list in System Settings, which is what turns "find the
/// app with the + button" into "tick the box next to it".
///
/// Returns the answer rather than whether anything was shown, because
/// there is no way to ask which of the two happened.
pub fn request_trust() -> bool {
    // SAFETY: `kAXTrustedCheckOptionPrompt` is a framework constant, live
    // for the process lifetime.
    let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
    let options = core_foundation::dictionary::CFDictionary::from_CFType_pairs(&[(
        key.as_CFType(),
        core_foundation::boolean::CFBoolean::true_value().as_CFType(),
    )]);
    // SAFETY: the dictionary outlives the call.
    unsafe { AXIsProcessTrustedWithOptions(options.as_CFTypeRef() as *const c_void) != 0 }
}

/// Every level between the window and the deepest element at a point.
///
/// Built from the inside out — the API only walks upwards — and reversed,
/// so the caller gets widest first.
///
/// The window is asked for directly rather than walked to, and put at the
/// front. Walking is not reliable enough to reach it: measured inside a
/// web-based application, the window was more than twenty-four elements
/// above the point under the pointer. Getting the window wrong would cost
/// more than a level — it is what decides whether the capture can be taken
/// from the window's own backing store instead of off the screen.
pub fn chain_at(x: f64, y: f64) -> Vec<Node> {
    let Some(element) = hit(x, y) else {
        return Vec::new();
    };

    let window = element.element_attribute("AXWindow").and_then(|w| w.node(true));

    let mut inward = Vec::new();
    let mut current = element;

    for _ in 0..MAX_WALK {
        let role = current.string_attribute("AXRole").unwrap_or_default();
        // The application element sits above the window and has no frame
        // worth capturing; the window is the top of the chain.
        if role == "AXApplication" {
            break;
        }
        let is_window = role == "AXWindow";
        if let Some(node) = current.node(is_window) {
            inward.push(node);
        }
        if is_window {
            break;
        }
        match current.element_attribute("AXParent") {
            Some(parent) => current = parent,
            None => break,
        }
    }

    inward.reverse();

    // Whatever the walk did or did not reach, level 0 is the window. A
    // duplicate here is harmless: `refine` keeps the outermost of any two
    // levels sharing a frame, and that is this one.
    match window {
        Some(window) => std::iter::once(window).chain(inward).collect(),
        None => inward,
    }
}

// ------------------------------------------------------------ owning the click
//
// During a window-pick session Shotly takes the mouse with a `CGEventTap`
// rather than a click-catching window, and that is not the obvious choice. The
// reason is the measurement above: a window that accepts mouse events is
// invisible to accessibility hit-testing, so an overlay that caught the click
// would be the only thing the outline could ever find. Something has to take
// the click without being a window, which leaves the tap.
//
// It is also the safer of the two. The failure mode of a full-screen click
// target is a desktop nobody can use until Shotly is force-quit; the failure
// mode of a tap is that macOS notices the callback is slow and switches it off,
// which is to say the operating system already implements the recovery.
//
// Everything here is arranged so that recovery is never needed:
//
//   * **The callback does no work.** It stores integers and returns. Nothing is
//     locked, nothing is allocated, no IPC happens — the hit-testing and the
//     drawing belong to the caller's own thread.
//   * **It outlives nothing.** Created when the session starts, dropped when it
//     ends, with a hard deadline of `MAX_SESSION` enforced by its own loop
//     rather than by whoever was supposed to stop it.
//   * **Only the mouse buttons, the wheel and Escape are swallowed.** Everything
//     else passes through, so ⌘Tab and ⌘Q still work while a session is up.
//
// The session logic that reads all this lives in `snap.rs`, which owns what the
// verdicts *mean*. This module owns only how they are obtained.

/// How long a session may own the mouse before it gives it back regardless.
const MAX_SESSION: Duration = Duration::from_secs(45);

/// How many times a tap switched off for slowness may be switched back on.
const MAX_REARMS: u32 = 5;

/// Escape's virtual keycode.
const KEY_ESCAPE: i64 = 53;

/// What the tap decided a session should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Nothing yet.
    None,
    /// A click: take whatever is under the pointer.
    Take,
    /// A drag: take the rectangle instead.
    Region,
    /// Escape, a right-click, or something that took the input away.
    Cancel,
}

const VERDICT_NONE: u8 = 0;
const VERDICT_TAKE: u8 = 1;
const VERDICT_CANCEL: u8 = 2;
const VERDICT_REGION: u8 = 3;

static VERDICT: AtomicU8 = AtomicU8::new(VERDICT_NONE);
/// Wheel movement the caller has yet to turn into levels.
static SCROLL: AtomicI64 = AtomicI64::new(0);
/// Set by the callback when macOS switches the tap off, cleared by the loop
/// that switches it back on.
static REARM: AtomicBool = AtomicBool::new(false);

/// Where the button went down, and where the pointer is now — global points as
/// `f64` bits, because the callback may not allocate or lock and this is the
/// cheapest thing that can carry a coordinate out of it.
static PRESS_X: AtomicU64 = AtomicU64::new(0);
static PRESS_Y: AtomicU64 = AtomicU64::new(0);
static POINT_X: AtomicU64 = AtomicU64::new(0);
static POINT_Y: AtomicU64 = AtomicU64::new(0);
/// Whether the button is currently held.
static PRESSED: AtomicBool = AtomicBool::new(false);
/// Whether the tap has seen a drag event since the press.
///
/// Which of two answers to believe about where a drag has got to, and getting
/// it wrong is visible: the band is drawn from the *event* when there are
/// events, because a `LeftMouseDragged` this tap drops never reaches the window
/// server, and the pointer can therefore sit perfectly still on screen while a
/// drag is happening. Polling it then gives the press point over and over —
/// crosshairs that do not move, which is exactly how this was reported.
///
/// The polled pointer is still the answer when no drag events arrive at all:
/// anything driving the mouse programmatically moves it with plain moved events
/// while the button is down, and those the tap never sees.
static TAPPED_DRAG: AtomicBool = AtomicBool::new(false);

fn put(cell: &AtomicU64, value: f64) {
    cell.store(value.to_bits(), Ordering::Relaxed);
}

fn got(cell: &AtomicU64) -> f64 {
    f64::from_bits(cell.load(Ordering::Relaxed))
}

/// Clear everything, at the start of a session.
pub fn reset() {
    SCROLL.store(0, Ordering::SeqCst);
    VERDICT.store(VERDICT_NONE, Ordering::SeqCst);
    PRESSED.store(false, Ordering::SeqCst);
    TAPPED_DRAG.store(false, Ordering::SeqCst);
    REARM.store(false, Ordering::SeqCst);
}

/// Take the verdict, leaving nothing behind.
pub fn take_verdict() -> Verdict {
    match VERDICT.swap(VERDICT_NONE, Ordering::SeqCst) {
        VERDICT_TAKE => Verdict::Take,
        VERDICT_REGION => Verdict::Region,
        VERDICT_CANCEL => Verdict::Cancel,
        _ => Verdict::None,
    }
}

/// End the session from outside — the watchdog, or a second press of the key.
pub fn cancel() {
    VERDICT.store(VERDICT_CANCEL, Ordering::SeqCst);
}

/// Wheel movement since this was last asked, cleared by the asking.
pub fn take_scroll() -> i64 {
    SCROLL.swap(0, Ordering::Relaxed)
}

/// Where the button went down.
pub fn press() -> (f64, f64) {
    (got(&PRESS_X), got(&PRESS_Y))
}

/// Where the last mouse event the tap saw was.
pub fn point() -> (f64, f64) {
    (got(&POINT_X), got(&POINT_Y))
}

/// Is the button held?
pub fn pressed() -> bool {
    PRESSED.load(Ordering::SeqCst)
}

/// Has the tap seen a drag event since the press? See [`TAPPED_DRAG`].
pub fn tapped_drag() -> bool {
    TAPPED_DRAG.load(Ordering::SeqCst)
}

/// Take the mouse for one session.
///
/// Returns immediately; the tap runs on a thread of its own until
/// `is_current` says the session has been superseded, or [`MAX_SESSION`]
/// expires, whichever comes first.
pub fn watch(generation: u64, is_current: fn(u64) -> bool, is_drag: fn((f64, f64), (f64, f64)) -> bool) {
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
                        // Whether a gesture counts as a drag is the
                        // caller's rule, not the tap's — but it is decided
                        // *here*, on the two points the events actually
                        // carried, rather than later from whatever the
                        // pointer has drifted to.
                        decide(if is_drag((got(&PRESS_X), got(&PRESS_Y)), (at.x, at.y)) {
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
