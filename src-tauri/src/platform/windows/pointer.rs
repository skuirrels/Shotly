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

// ------------------------------------------------------- owning the click
//
// The macOS session takes the click with a `CGEventTap`, for a reason that
// does not apply here: on macOS a window that accepts mouse events is
// invisible to accessibility hit-testing, so a click-catching overlay would be
// the only thing the outline could ever find.
//
// Windows has no such rule — `WindowFromPoint` ignores a layered window with
// `WS_EX_TRANSPARENT` — so the overlay itself can take the click and no
// system-wide hook is needed for the common case. If one turns out to be
// (for Escape while another app has focus, say), it is `WH_MOUSE_LL` /
// `WH_KEYBOARD_LL`, which carry the same "the OS switches off a slow callback"
// property the macOS tap does, and want the same do-nothing callback.

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
