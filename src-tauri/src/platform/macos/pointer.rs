//! Where the pointer is, and what is underneath it.
//!
//! Two questions with one answer each on macOS, and both are asked from three
//! or four places — the annotation layer wants to know which screen to open
//! on, the capture backend wants the scale of the display a selection was made
//! on, the window outline wants the window under the cursor. They used to be
//! answered by three identical copies of the same six lines; this is the copy
//! that survived.
//!
//! The hit test lives next door in [`ax`](super::ax), which has a long account
//! of why the accessibility API answers "what would a click here land on"
//! correctly where the window list does not.
//!
//! # What is deliberately *not* here yet
//!
//! The `CGEventTap` that owns the click during a window-pick session is still
//! in `snap.rs`. It is the one piece of Phase 0 left where it was, on purpose:
//! it is ~200 lines of documented safety machinery whose failure mode is a
//! desktop nobody can use, no test can drive it (a tap needs a real event
//! stream, and scripted input warps the cursor rather than reproducing one),
//! and a mechanical move would therefore be an unverifiable change to the most
//! dangerous code in the app. Its Windows counterpart is described in
//! `platform/windows/pointer.rs`; moving it deserves its own change, with a
//! human at the keyboard confirming the outline still behaves.

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
