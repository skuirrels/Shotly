//! The red outline drawn around the window `screencapture -i -w` is about to
//! capture.
//!
//! # Why this is decoration and nothing else
//!
//! macOS's own window picker cannot be restyled, and it turns out it will
//! target *any* window under the cursor — a floating, mouse-transparent panel
//! of ours included. That was measured, not assumed: a borderless overlay at
//! `NSFloatingWindowLevel` with `ignoresMouseEvents` set was picked in
//! preference to the ordinary window beneath it, and marking it unsharable only
//! changed the outcome to "capture nothing at all".
//!
//! So the outline never covers the target. Each bar sits just *outside* the
//! window's bounds, and the pointer has to be inside a window for the picker to
//! choose it — which means it is never over one of our bars at the instant of
//! the click. [`EDGE_GUARD`] closes the remaining sliver by hiding the ring
//! whenever the pointer approaches an edge.
//!
//! # Safety
//!
//! An earlier full-screen overlay repeatedly left this machine needing a force
//! quit, so the properties below are guarantees rather than defaults:
//!
//! * **Permanently `ignoresMouseEvents`.** There is no state — not startup, not
//!   failure, not teardown — in which these windows accept a click. They cannot
//!   wedge the desktop, because they are never in the input path at all.
//! * **No webview.** Plain AppKit windows with a background colour and no
//!   content, so there is no renderer to hang and nothing that must run
//!   JavaScript before the window becomes safe.
//! * **`NSWindowSharingType::None`.** The bars are invisible to every capture
//!   path, so they can never contaminate the screenshot being taken.
//! * **Floating level**, below the menu bar and Dock, which stay clickable.
//! * **A tracker thread with a hard deadline** that tears the bars down even if
//!   the capture it belongs to never reports back.

use crate::capture::{display, Rect};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::AppHandle;

/// Outline width, in points.
const THICKNESS: f64 = 3.0;

/// Hide the ring when the pointer is within this many points of the target's
/// edge. Must exceed [`THICKNESS`], so that the pointer is clear of the bars
/// before they appear — otherwise the picker could take a bar as its target.
const EDGE_GUARD: f64 = 8.0;

/// Pointer sampling interval. Fast enough to feel attached to the cursor,
/// cheap enough that the main thread is only touched when the target changes.
const POLL: Duration = Duration::from_millis(24);

/// Belt and braces: even if `stop` is never called, the outline dies.
const MAX_LIFETIME: Duration = Duration::from_secs(180);

static ACTIVE: AtomicBool = AtomicBool::new(false);

/// Which run of the outline owns the bars.
///
/// Without this, a capture that starts within one poll interval of the previous
/// one ending gets its outline destroyed by the *old* tracker: that thread wakes
/// after `stop`, tears the bars down, and clears `ACTIVE` — all of which now
/// belong to the new run. Every main-thread hop re-checks the generation, so
/// work queued by a superseded run is dropped instead of applied.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// The four bars framing `b`, laid out just outside it.
fn ring(b: Rect) -> [Rect; 4] {
    let t = THICKNESS;
    [
        Rect { x: b.x - t, y: b.y - t, width: b.width + 2.0 * t, height: t },
        Rect { x: b.x - t, y: b.y + b.height, width: b.width + 2.0 * t, height: t },
        Rect { x: b.x - t, y: b.y, width: t, height: b.height },
        Rect { x: b.x + b.width, y: b.y, width: t, height: b.height },
    ]
}

/// Where the ring should be right now, or `None` to show nothing.
fn wanted() -> Option<[Rect; 4]> {
    let (x, y) = imp::cursor()?;
    let target = display::window_at(x, y).ok().flatten()?;
    let b = target.bounds;

    if b.width < 1.0 || b.height < 1.0 {
        return None;
    }

    // Near an edge the pointer is about to cross one of our bars, and the
    // picker would capture the bar instead of the window. Show nothing rather
    // than risk it.
    let near_edge = x - b.x < EDGE_GUARD
        || b.x + b.width - x < EDGE_GUARD
        || y - b.y < EDGE_GUARD
        || b.y + b.height - y < EDGE_GUARD;

    if near_edge {
        return None;
    }

    Some(ring(b))
}

/// Start following the pointer with a red outline. Idempotent.
pub fn start(app: &AppHandle) {
    if ACTIVE.swap(true, Ordering::SeqCst) {
        return;
    }

    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = app.clone();

    std::thread::spawn(move || {
        let began = Instant::now();
        let mut showing: Option<[Rect; 4]> = None;

        while ACTIVE.load(Ordering::SeqCst)
            && GENERATION.load(Ordering::SeqCst) == generation
            && began.elapsed() < MAX_LIFETIME
        {
            let next = wanted();
            // Only cross to the main thread when something actually moved.
            if next != showing {
                showing = next;
                let dispatched = handle.run_on_main_thread(move || {
                    // `stop` may have run while we were computing this. Painting
                    // now would put bars on screen that nothing owns.
                    if GENERATION.load(Ordering::SeqCst) == generation {
                        imp::apply(next);
                    }
                });
                if let Err(e) = dispatched {
                    eprintln!("[highlight] could not reach the main thread: {e}");
                }
            }
            std::thread::sleep(POLL);
        }

        // However the loop ended — cancelled capture, timeout, missed stop —
        // leave nothing behind on screen. Unless a newer run has taken over, in
        // which case the bars are its business now.
        let _ = handle.run_on_main_thread(move || {
            if GENERATION.load(Ordering::SeqCst) == generation {
                imp::teardown();
            }
        });
        if GENERATION.load(Ordering::SeqCst) == generation {
            ACTIVE.store(false, Ordering::SeqCst);
        }
    });
}

/// Take the outline down. Safe to call from any thread, and when not running.
pub fn stop(app: &AppHandle) {
    // Retire the current run first: this is what stops an in-flight `apply`
    // from repainting after the teardown below.
    GENERATION.fetch_add(1, Ordering::SeqCst);
    ACTIVE.store(false, Ordering::SeqCst);
    // Don't wait for the tracker's next tick to notice.
    let _ = app.run_on_main_thread(imp::teardown);
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{Rect, THICKNESS};
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::MainThreadOnly;
    use objc2_app_kit::{
        NSBackingStoreType, NSColor, NSWindow, NSWindowCollectionBehavior, NSWindowSharingType,
        NSWindowStyleMask, NSFloatingWindowLevel,
    };
    use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};
    use std::sync::Mutex;

    /// The four bars, as raw pointers.
    ///
    /// `Retained<NSWindow>` is not `Send`, so the windows cannot live in a
    /// static directly. Storing the pointers instead is sound because every
    /// dereference below happens on the main thread, which is the only place
    /// `apply` and `teardown` are ever called from.
    static BARS: Mutex<[usize; 4]> = Mutex::new([0; 4]);

    /// Global pointer position, top-left origin, in points.
    pub fn cursor() -> Option<(f64, f64)> {
        use core_graphics::event::CGEvent;
        use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

        let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState).ok()?;
        let point = CGEvent::new(source).ok()?.location();
        Some((point.x, point.y))
    }

    /// Height of the primary display, for the top-left/bottom-left flip.
    ///
    /// Our rects use CoreGraphics' top-left origin; AppKit window frames use a
    /// bottom-left origin anchored at the primary display.
    fn primary_height() -> f64 {
        core_graphics::display::CGDisplay::main().bounds().size.height
    }

    /// One bar: a solid red sliver that can never take a click or be captured.
    fn make_bar(mtm: MainThreadMarker) -> Retained<NSWindow> {
        let zero = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(THICKNESS, THICKNESS));

        // SAFETY: constructing an NSWindow on the main thread, which the
        // MainThreadMarker witnesses.
        let window = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                NSWindow::alloc(mtm),
                zero,
                NSWindowStyleMask::Borderless,
                NSBackingStoreType::Buffered,
                false,
            )
        };

        // A programmatically created NSWindow releases itself when closed. We
        // hold our own reference in BARS, so leaving that on means `close`
        // drops the count to zero and the `Retained` we still hold releases a
        // freed object — an over-release that segfaults in the next autorelease
        // pool drain, well away from the code that caused it.
        // SAFETY: takes ownership of the window's lifetime, which is exactly
        // what `teardown` relies on.
        unsafe { window.setReleasedWhenClosed(false) };

        window.setOpaque(true);
        window.setHasShadow(false);
        // The single most important line here: these windows are never, at any
        // point in their life, in the input path.
        window.setIgnoresMouseEvents(true);
        // Keep the outline out of the screenshot it is annotating.
        window.setSharingType(NSWindowSharingType::None);
        // Above ordinary windows, below the menu bar (24) and Dock (20).
        window.setLevel(NSFloatingWindowLevel);
        window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );

        let red = NSColor::colorWithSRGBRed_green_blue_alpha(0.94, 0.23, 0.21, 1.0);
        window.setBackgroundColor(Some(&red));

        window
    }

    /// Move the ring, or hide it. Main thread only.
    pub fn apply(rects: Option<[Rect; 4]>) {
        let Some(mtm) = MainThreadMarker::new() else {
            eprintln!("[highlight] apply called off the main thread");
            return;
        };
        let mut bars = BARS.lock().unwrap();

        let Some(rects) = rects else {
            for &ptr in bars.iter() {
                if ptr != 0 {
                    // SAFETY: main thread, and the pointer is a window we made
                    // and have not released.
                    unsafe { (*(ptr as *const NSWindow)).orderOut(None::<&AnyObject>) };
                }
            }
            return;
        };

        let flip = primary_height();

        for (slot, r) in bars.iter_mut().zip(rects.iter()) {
            if *slot == 0 {
                *slot = Retained::into_raw(make_bar(mtm)) as usize;
            }
            // SAFETY: as above — main thread, pointer owned by this module.
            let window = unsafe { &*(*slot as *const NSWindow) };

            let frame = NSRect::new(
                NSPoint::new(r.x, flip - (r.y + r.height)),
                // A zero-size window is undefined; clamp to something drawable.
                NSSize::new(r.width.max(1.0), r.height.max(1.0)),
            );
            // AppKit constrains a window to the screen's *visible* frame, so a
            // bar that would land in the menu bar or Dock strip is nudged back
            // by its own thickness and ends up just inside the target instead
            // of just outside it. That is only cosmetic: EDGE_GUARD keeps the
            // pointer further from the edge than a bar is thick, so the picker
            // still cannot end up targeting one.
            window.setFrame_display(frame, false);
            window.orderFrontRegardless();
        }
    }

    /// Close and release every bar. Main thread only; safe to call repeatedly.
    pub fn teardown() {
        let mut bars = BARS.lock().unwrap();
        for slot in bars.iter_mut() {
            if *slot == 0 {
                continue;
            }
            // SAFETY: takes back the ownership handed to `into_raw`, exactly
            // once — the slot is cleared immediately afterwards.
            if let Some(window) = unsafe { Retained::from_raw(*slot as *mut NSWindow) } {
                window.orderOut(None::<&AnyObject>);
                window.close();
            }
            *slot = 0;
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::Rect;

    pub fn cursor() -> Option<(f64, f64)> {
        None
    }
    pub fn apply(_rects: Option<[Rect; 4]>) {}
    pub fn teardown() {}
}
