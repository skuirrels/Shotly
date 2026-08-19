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
//! that is busy will simply not answer. `MESSAGING_TIMEOUT` bounds that, and
//! the fast path deliberately asks for two things (the element, then its
//! window) rather than walking the whole ancestry on every tick.

use crate::capture::Rect;

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

/// The three questions only the operating system can answer, re-exported so
/// that callers say `ax::trusted()` as they always have. Their implementations
/// live in [`platform::pointer`](crate::platform::pointer) — see the note at
/// the top of this file about which half of this module is portable.
pub use crate::platform::pointer::{chain_at, request_trust, trusted};

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
