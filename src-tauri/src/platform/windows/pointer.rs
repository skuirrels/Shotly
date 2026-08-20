//! Where the pointer is, and what is underneath it — on Windows.
//!
//! See `docs/WINDOWS.md`. This is the concern that changes shape most between
//! the two platforms, and mostly in Windows' favour.

/// Where the pointer is, in global point space with a top-left origin.
///
/// `GetCursorPos`, which already uses a top-left virtual-desktop origin — so
/// unlike almost everything else here, no conversion is needed. The caller
/// must be per-monitor DPI aware or the coordinates come back scaled.
pub fn cursor() -> Option<(f64, f64)> {
    None
}

// -------------------------------------------------------- what is under it
//
// The accessibility hit test (`platform::macos::ax`) exists to answer "what
// would a click here land on", because `CGWindowListCopyWindowInfo` lists
// windows that are not composited and gives no way to tell. Windows answers
// that directly: `EnumWindows` in z-order, filtered by `IsWindowVisible` and
// by `DwmGetWindowAttribute(DWMWA_CLOAKED)` — which is precisely "is the
// compositor showing this" — with `DWMWA_EXTENDED_FRAME_BOUNDS` for the frame
// the user actually sees. `WindowFromPoint` does the hit test itself.
//
// So the 469 lines of AX machinery are expected to shrink rather than
// translate. The one part that does need UI Automation is resolving *inside* a
// window for the scroll-to-tighten behaviour; `IUIAutomation::ElementFromPoint`
// is the counterpart, with the same "an unresponsive app simply will not
// answer" caveat that MESSAGING_TIMEOUT exists for.

use crate::ax::Node;

/// Has the user granted whatever permission the hit test needs?
///
/// Nothing to grant on Windows: `EnumWindows`, `WindowFromPoint` and DWM's
/// attributes are all available to any process. Answering `true` is therefore
/// correct rather than optimistic — and it is what makes `snap`'s "ask for
/// accessibility" path quietly disappear here.
pub fn trusted() -> bool {
    true
}

/// Ask for it anyway. There is nothing to ask for.
pub fn request_trust() -> bool {
    true
}

/// The chain of elements under a point, innermost last.
///
/// `WindowFromPoint` for the window, then `IUIAutomation::ElementFromPoint`
/// and its ancestry for the levels inside it. Empty until implemented, which
/// `snap` already handles: it is the same answer an untrusted Mac gives, and
/// the outline falls back to framing whole windows.
pub fn chain_at(_x: f64, _y: f64) -> Vec<Node> {
    Vec::new()
}

/// What a window puts directly inside itself: its title bar, its toolbars, and
/// whatever holds its contents.
///
/// `IUIAutomation`'s `RawViewWalker` over the element `ElementFromHandle`
/// returns for the window — the same question in Win32 dress, and asked about
/// the window rather than about a point for the same reason `window_children`
/// is on the macOS side: the caller already knows which window it means.
/// `None` until implemented, and the outline frames whole windows in the
/// meantime, which is the answer a Mac without accessibility access gives.
pub fn window_children(_pid: i32, _frame: crate::capture::Rect) -> Option<Vec<Node>> {
    None
}

// ------------------------------------------------------- owning the click
//
// The macOS session takes the click with a `CGEventTap`, for a reason that
// does not apply here: on macOS a window that accepts mouse events is
// invisible to accessibility hit-testing, so a click-catching overlay would be
// the only thing the outline could ever find.
//
// Windows has no such rule — `WindowFromPoint` ignores a layered window with
// `WS_EX_TRANSPARENT` — so the overlay can take its own clicks and no
// system-wide hook is needed for the common case. Where one still is (Escape
// while another app holds focus, say) it is `WH_MOUSE_LL` / `WH_KEYBOARD_LL`,
// which carry the same "the OS switches off a slow callback" property the
// macOS tap does and want the same do-nothing callback.
//
// So this side is expected to be *smaller* than its counterpart, and the
// surface below is the one `snap.rs` already talks to. Filling it in is part
// of Phase 1's window picker.

/// What the session decided to do. Identical to the macOS shape, because
/// `snap.rs` reads it and `snap.rs` is shared.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    None,
    Take,
    Region,
    Cancel,
}

/// Clear everything, at the start of a session.
pub fn reset() {}

/// Take the verdict, leaving nothing behind.
///
/// `None` for ever, which is what keeps a session from doing anything: the
/// tracker polls, finds no verdict, and the watchdog ends it. That is the
/// right failure — an outline nobody can click is inert, not stuck.
pub fn take_verdict() -> Verdict {
    Verdict::None
}

/// End the session from outside — the watchdog, or a second press of the key.
pub fn cancel() {}

/// Wheel movement since this was last asked, cleared by the asking.
pub fn take_scroll() -> i64 {
    0
}

/// Where the button went down.
pub fn press() -> (f64, f64) {
    (0.0, 0.0)
}

/// Where the last mouse event was.
pub fn point() -> (f64, f64) {
    (0.0, 0.0)
}

/// Is the button held?
pub fn pressed() -> bool {
    false
}

/// Has a drag event been seen since the press?
///
/// `false` means the caller falls back to the polled pointer, which on Windows
/// is the right default anyway: nothing here drops the drag events, so the
/// cursor really does move with the drag and polling it is honest.
pub fn tapped_drag() -> bool {
    false
}

/// Take the mouse for one session.
pub fn watch(
    _generation: u64,
    _is_current: fn(u64) -> bool,
    _is_drag: fn((f64, f64), (f64, f64)) -> bool,
) {
}
