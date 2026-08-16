//! What is under the pointer, according to the accessibility API.
//!
//! # Why this rather than the window list
//!
//! Shotly used to draw its capture outline from `CGWindowListCopyWindowInfo`:
//! topmost window whose bounds hold the cursor. That list is not a list of what
//! is on screen. It contains windows that report themselves frontmost, opaque
//! and `kCGWindowIsOnscreen` while not being composited at all, and nothing in
//! their metadata gives them away — so the outline could frame a window nobody
//! could see. It was removed for that reason; see `docs/DEVELOPING.md`.
//!
//! `AXUIElementCopyElementAtPosition` answers a different question: not "which
//! window claims this point" but "what would a click here land on". Measured on
//! the same desktop that defeated the old outline, it returns the window you can
//! actually see and never the phantom.
//!
//! It also resolves *inside* a window. A probe at one point came back as a
//! 393×29 sidebar row rather than the whole 1484×838 window, and the enclosing
//! window frame it reports matches `CGWindowListCopyWindowInfo` exactly. That is
//! where the scroll-to-tighten behaviour comes from: the ancestry between the
//! deepest element and its window is a ready-made list of things worth framing.
//!
//! # The one property everything else rests on
//!
//! **A window that ignores mouse events is invisible to this API.** Measured: a
//! floating, `ignoresMouseEvents` overlay placed over another app's window, then
//! probed at its own centre, returned the window *underneath*. Turning mouse
//! events back on for the same overlay changed the answer to error −25208.
//!
//! So Shotly may draw whatever it likes over the target — the outline cannot
//! poison the hit test that positions it — provided the overlay never accepts a
//! click. Which is also why the click has to come from an event tap instead; see
//! `snap.rs`.
//!
//! # Cost
//!
//! Every call here is IPC to the application being asked, and an application
//! that is busy will simply not answer. [`MESSAGING_TIMEOUT`] bounds that, and
//! the fast path deliberately asks for two things (the element, then its
//! window) rather than walking the whole ancestry on every tick.

use crate::capture::Rect;

/// How long to wait for an application to answer before giving up on it.
///
/// A beachballing app must cost the outline a frame, not the session.
#[cfg(target_os = "macos")]
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

/// The most levels the wheel will ever step through.
///
/// The refined chain in that same measurement was 6 long. Anything approaching
/// this number is an application with something strange to say.
const MAX_LEVELS: usize = 16;

/// The smallest thing worth framing, in points. Below this the outline is
/// thicker than its target.
const MIN_EDGE: f64 = 12.0;

/// One thing that could be captured: a rectangle, and what the system calls it.
#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub rect: Rect,
    /// The AX role, e.g. `AXWindow`, `AXButton`, `AXGroup`.
    pub role: String,
    /// The window's title, or the element's own if it has one.
    pub title: String,
    pub pid: i32,
    /// True for the entry that is the whole window.
    pub window: bool,
}

/// Rectangles within a point of each other are the same rectangle here.
///
/// AX frames arrive as floats that have been through at least one coordinate
/// conversion, so exact equality would leave near-duplicate ancestors in the
/// chain and make scrolling feel like it does nothing.
fn same(a: Rect, b: Rect) -> bool {
    (a.x - b.x).abs() <= 1.0
        && (a.y - b.y).abs() <= 1.0
        && (a.width - b.width).abs() <= 1.0
        && (a.height - b.height).abs() <= 1.0
}

fn holds(r: Rect, x: f64, y: f64) -> bool {
    x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height
}

/// Reduce a raw ancestry to the levels a person would want to step through.
///
/// Ordered widest first, so level 0 is the window and each step tightens. Three
/// kinds of entry are dropped: anything too small to aim at, anything not
/// actually under the pointer — some applications report frames for elements
/// they have since moved — and anything the same size as the level outside it,
/// which would otherwise be a scroll step that appears to do nothing.
pub fn refine(chain: Vec<Node>, x: f64, y: f64) -> Vec<Node> {
    let mut out: Vec<Node> = Vec::with_capacity(chain.len());

    for node in chain {
        if node.rect.width < MIN_EDGE || node.rect.height < MIN_EDGE {
            continue;
        }
        if !holds(node.rect, x, y) {
            continue;
        }
        if out.last().is_some_and(|prev| same(prev.rect, node.rect)) {
            continue;
        }
        out.push(node);
        if out.len() >= MAX_LEVELS {
            break;
        }
    }

    out
}

/// The entry a given level names, clamping rather than failing.
///
/// Scrolling past the end of the chain is not an error — it is someone spinning
/// the wheel — and it should land on the deepest thing there is.
pub fn at_level(chain: &[Node], level: i32) -> Option<&Node> {
    if chain.is_empty() {
        return None;
    }
    let last = chain.len() - 1;
    chain.get((level.max(0) as usize).min(last))
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{Node, Rect, MAX_WALK, MESSAGING_TIMEOUT};
    use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
    use core_foundation::dictionary::CFDictionary;
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
    /// macOS only surfaces the dialog the first time; afterwards this is a
    /// silent no. That is the whole reason it returns the answer rather than
    /// assuming the prompt did something.
    pub fn request_trust() -> bool {
        // SAFETY: `kAXTrustedCheckOptionPrompt` is a framework constant, live
        // for the process lifetime.
        let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
        let options = CFDictionary::from_CFType_pairs(&[(
            key.as_CFType(),
            core_foundation::boolean::CFBoolean::true_value().as_CFType(),
        )]);
        // SAFETY: the dictionary outlives the call.
        unsafe { AXIsProcessTrustedWithOptions(options.as_CFTypeRef() as *const c_void) != 0 }
    }

    /// The window under the pointer — the fast path, and the default target.
    ///
    /// Two round trips rather than the whole ancestry, because this runs on
    /// every tick of the tracker and the answer is what level 0 shows.
    pub fn window_at(x: f64, y: f64) -> Option<Node> {
        let element = hit(x, y)?;
        // An element *is* sometimes the window: hitting the desktop background
        // or a window's own frame comes back that way.
        let window = match element.element_attribute("AXWindow") {
            Some(w) => w,
            None => element,
        };
        window.node(true)
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
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::Node;

    pub fn trusted() -> bool {
        false
    }
    pub fn request_trust() -> bool {
        false
    }
    pub fn window_at(_x: f64, _y: f64) -> Option<Node> {
        None
    }
    pub fn chain_at(_x: f64, _y: f64) -> Vec<Node> {
        Vec::new()
    }
}

pub use imp::{chain_at, request_trust, trusted, window_at};

#[cfg(test)]
mod tests {
    use super::*;

    fn node(x: f64, y: f64, width: f64, height: f64) -> Node {
        Node {
            rect: Rect { x, y, width, height },
            role: "AXGroup".into(),
            title: String::new(),
            pid: 1,
            window: false,
        }
    }

    #[test]
    fn collapses_ancestors_that_share_a_frame() {
        // A window, three wrappers all exactly filling it, then a button.
        let chain = vec![
            node(0.0, 0.0, 800.0, 600.0),
            node(0.0, 0.0, 800.0, 600.0),
            node(0.0, 0.5, 800.0, 600.0),
            node(100.0, 100.0, 200.0, 40.0),
        ];
        let out = refine(chain, 150.0, 110.0);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].rect.width, 800.0);
        assert_eq!(out[1].rect.width, 200.0);
    }

    #[test]
    fn the_window_survives_a_wrapper_that_fills_it() {
        // What `chain_at` builds: the real window, then the application's own
        // outermost group, which has exactly the same frame. Collapsing has to
        // keep the window — it is what decides how the capture is taken.
        let mut window = node(13.0, 51.0, 1484.0, 838.0);
        window.window = true;
        window.role = "AXWindow".into();

        let out = refine(vec![window, node(13.0, 51.0, 1484.0, 838.0), node(20.0, 60.0, 400.0, 300.0)], 100.0, 100.0);
        assert_eq!(out.len(), 2);
        assert!(out[0].window, "level 0 must still be the window");
        assert_eq!(out[0].role, "AXWindow");
    }

    #[test]
    fn drops_levels_the_pointer_is_not_actually_over() {
        // The middle entry is a stale frame from elsewhere on screen.
        let chain =
            vec![node(0.0, 0.0, 800.0, 600.0), node(600.0, 400.0, 100.0, 100.0), node(10.0, 10.0, 90.0, 90.0)];
        let out = refine(chain, 50.0, 50.0);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1].rect.width, 90.0);
    }

    #[test]
    fn drops_levels_too_small_to_aim_at() {
        let chain = vec![node(0.0, 0.0, 800.0, 600.0), node(40.0, 40.0, 4.0, 4.0)];
        assert_eq!(refine(chain, 41.0, 41.0).len(), 1);
    }

    #[test]
    fn level_clamps_instead_of_failing() {
        let chain = refine(
            vec![node(0.0, 0.0, 800.0, 600.0), node(10.0, 10.0, 100.0, 100.0)],
            20.0,
            20.0,
        );
        assert_eq!(at_level(&chain, -5).unwrap().rect.width, 800.0);
        assert_eq!(at_level(&chain, 0).unwrap().rect.width, 800.0);
        assert_eq!(at_level(&chain, 1).unwrap().rect.width, 100.0);
        // Spun the wheel: still the deepest thing there is.
        assert_eq!(at_level(&chain, 99).unwrap().rect.width, 100.0);
        assert!(at_level(&[], 0).is_none());
    }
}
