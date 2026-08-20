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

/// How much of its window's width a thing has to span to be furniture rather
/// than content. Toolbars go edge to edge; the document under them does too,
/// but it is never short.
const CHROME_WIDTH: f64 = 0.9;

/// And how tall it may be, as a fraction of the window. Measured: Word's
/// ribbon is 105pt of a 1068pt window and its title bar 40pt, while the split
/// group holding the document is 903pt. Nothing in between was ever seen.
const CHROME_HEIGHT: f64 = 0.35;

/// The least a cut can take and still be worth making.
const MIN_CHROME: f64 = 16.0;

/// And the most. A window that appears to be more than half furniture has been
/// misread, and framing the remainder would be worse than framing the window.
const MAX_CHROME: f64 = 0.5;

/// Frames within this of each other line up. Same reason as `same`: these have
/// been through a coordinate conversion.
const EDGE_SLACK: f64 = 2.0;

/// How much of the window's width a child must span before it counts as having
/// divided the window at all.
///
/// Far below [`CHROME_WIDTH`], because this is a different question: not "is
/// this child a toolbar" but "has the application said anything about the
/// shape of its window". Half the width is enough to be a pane.
const DIVIDES_WIDTH: f64 = 0.5;

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

/// Whether these children amount to a description of the window at all.
///
/// A reply is not a description. Chrome answers the accessibility API — once
/// something has prompted it to switch its tree on, which querying it for long
/// enough will — with exactly four children: one `AXGroup` whose frame is the
/// window's own frame to the pixel, and the three 16x16 buttons in the corner
/// that close, minimise and zoom it. That is the window restated and its
/// traffic lights. It says nothing whatever about where the tab strip ends or
/// the page begins.
///
/// Left unchecked it is worse than silence, because [`content_top`] correctly
/// finds no chrome in it and the caller reads that as *this window has nothing
/// above its contents* — a settled answer, which switches off the pixel
/// fallback that was reading such windows correctly. So a child only counts if
/// it is a real division of the window: wide enough to be a pane, tall enough
/// to be furniture, and not simply the window handed back again.
///
/// The test is structural rather than a check for Chrome, because Chrome is
/// not the only thing that answers this way — a Chromium shell is the same
/// shape wherever it turns up.
pub fn describes_window(window: Rect, children: &[Node]) -> bool {
    children.iter().any(|child| {
        !same(child.rect, window)
            && child.rect.width >= window.width * DIVIDES_WIDTH
            && child.rect.height >= MIN_CHROME
    })
}

/// Where a window's own contents begin, below whatever it stacks on top of
/// them — its title bar, its toolbar, its ribbon.
///
/// This is the one thing Snagit's all-in-one does that pointing at a window
/// could not say: hover over a document and it frames the document, not the
/// window with two inches of buttons across the top. Every capture of a Word
/// page otherwise arrives with the ribbon in it, and cropping that off by hand
/// afterwards is the tax the feature exists to remove.
///
/// The rule is geometric rather than a list of roles, and deliberately so.
/// Roles are what an application chooses to call things: Word's ribbon is an
/// `AXTabGroup`, Mail's is an `AXToolbar`, Excel puts an `AXUnknown` under
/// both. What they have in common is shape — each one goes the full width of
/// the window, is far too short to be the content, and sits above it. So walk
/// down from the top edge: anything reaching the current line, spanning the
/// window and short enough not to be the thing being framed, moves the line to
/// its own bottom. Where the line stops is where the contents start.
///
/// `None` when there is nothing above the contents worth cutting off, which is
/// the answer for most windows and for every application that declines to
/// describe itself at all.
pub fn content_top(window: Rect, children: &[Node]) -> Option<f64> {
    let mut line = window.y;
    let mut left: Vec<&Node> = children.iter().collect();

    // Repeatedly, because they stack: Word's ribbon only touches the top of
    // the window once the title bar above it has been accounted for.
    while let Some(index) = left.iter().position(|n| {
        n.rect.width >= window.width * CHROME_WIDTH - EDGE_SLACK
            && n.rect.height <= window.height * CHROME_HEIGHT
            && n.rect.y <= line + EDGE_SLACK
            && n.rect.y + n.rect.height > line + EDGE_SLACK
    }) {
        let node = left.remove(index);
        line = node.rect.y + node.rect.height;
    }

    let cut = line - window.y;
    (cut >= MIN_CHROME && cut <= window.height * MAX_CHROME).then_some(line)
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

/// The questions only the operating system can answer, re-exported so
/// that callers say `ax::trusted()` as they always have. Their implementations
/// live in [`platform::pointer`](crate::platform::pointer) — see the note at
/// the top of this file about which half of this module is portable.
pub use crate::platform::pointer::{chain_at, request_trust, trusted, window_children};

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

    /// Chrome's whole answer, measured: a 1512x895 window at (0,33) whose
    /// children are one group with the window's own frame and the three 16x16
    /// buttons that close, minimise and zoom it. Nothing there divides the
    /// window, so it is not an answer and the pixels have to be looked at.
    #[test]
    fn a_window_restated_with_its_traffic_lights_describes_nothing() {
        let window = Rect { x: 0.0, y: 33.0, width: 1512.0, height: 895.0 };
        let children = vec![
            node(0.0, 33.0, 1512.0, 895.0),
            node(12.0, 45.5, 16.0, 16.0),
            node(35.0, 45.5, 16.0, 16.0),
            node(58.0, 45.5, 16.0, 16.0),
        ];
        assert!(!describes_window(window, &children));
        // And the reason it matters: the rule below finds no chrome in it,
        // which read as a settled "nothing to cut" is what took the trim away.
        assert_eq!(content_top(window, &children), None);
    }

    /// A window described the way an application that means it describes one.
    /// Word's shape: a title bar, a ribbon, and the document under them.
    #[test]
    fn a_window_with_furniture_in_it_describes_itself() {
        let window = Rect { x: 0.0, y: 0.0, width: 1822.0, height: 1068.0 };
        let children = vec![
            node(0.0, 0.0, 1822.0, 40.0),
            node(0.0, 40.0, 1822.0, 105.0),
            node(0.0, 145.0, 1822.0, 903.0),
        ];
        assert!(describes_window(window, &children));
    }

    /// An application with nothing above its contents still describes its
    /// window, so long as it says so with something other than the window: a
    /// content pane inset below the title bar is an answer, and must not be
    /// sent to the pixels to be second-guessed.
    #[test]
    fn a_window_that_is_all_contents_still_describes_itself() {
        let window = Rect { x: 0.0, y: 0.0, width: 900.0, height: 700.0 };
        let children = vec![node(0.0, 28.0, 900.0, 672.0)];
        assert!(describes_window(window, &children));
        assert_eq!(content_top(window, &children), None);
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

    /// Word, measured: a 1822x1068 window at -2003,-223 with a title bar, a
    /// ribbon, the document and a status bar. The cut belongs under the ribbon
    /// and above the document — and below the status bar's own top, because
    /// what is being answered is where the contents *start*, not where they
    /// end. Snagit frames the same rectangle.
    #[test]
    fn cuts_word_under_its_ribbon() {
        let window = Rect { x: -2003.0, y: -223.0, width: 1822.0, height: 1068.0 };
        let kids = vec![
            node(-2003.0, -223.0, 1822.0, 40.0),  // title bar
            node(-1992.0, -211.0, 16.0, 16.0),    // close
            node(-2003.0, -191.0, 1822.0, 105.0), // ribbon
            node(-2003.0, -86.0, 1822.0, 903.0),  // the document
            node(-2003.0, 817.0, 1822.0, 28.0),   // status bar
        ];
        assert_eq!(content_top(window, &kids), Some(-86.0));
    }

    /// Mail, measured: one unified toolbar, and a split group that fills the
    /// whole window including the space behind it. The split group must not be
    /// mistaken for furniture, and the toolbar must still be found under it.
    #[test]
    fn cuts_under_a_toolbar_the_content_reaches_behind() {
        let window = Rect { x: 0.0, y: 33.0, width: 1512.0, height: 895.0 };
        let kids = vec![
            node(0.0, 33.0, 1512.0, 895.0), // split group, the full window
            node(0.0, 33.0, 1512.0, 52.0),  // toolbar
            node(272.0, 33.0, 380.0, 52.0), // title text, not full width
        ];
        assert_eq!(content_top(window, &kids), Some(85.0));
    }

    /// Spotify, measured: everything drawn inside one group, nothing declared.
    /// There is no cut to make, and inventing one would frame the wrong thing.
    #[test]
    fn leaves_a_window_that_declares_no_furniture_alone() {
        let window = Rect { x: -1797.0, y: -32.0, width: 1422.0, height: 812.0 };
        let kids = vec![node(-1797.0, -32.0, 1422.0, 812.0)];
        assert_eq!(content_top(window, &kids), None);
    }

    #[test]
    fn refuses_a_cut_too_small_to_be_worth_it() {
        let window = Rect { x: 0.0, y: 0.0, width: 800.0, height: 600.0 };
        assert_eq!(content_top(window, &[node(0.0, 0.0, 800.0, 8.0)]), None);
    }

    /// More than half the window is not furniture; it is a window that has
    /// been misread, and the remainder is not what anyone pointed at.
    #[test]
    fn refuses_a_cut_that_would_take_most_of_the_window() {
        let window = Rect { x: 0.0, y: 0.0, width: 800.0, height: 200.0 };
        let kids = vec![node(0.0, 0.0, 800.0, 60.0), node(0.0, 60.0, 800.0, 60.0)];
        assert_eq!(content_top(window, &kids), None);
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
