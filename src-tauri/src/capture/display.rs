//! Display and window enumeration via CoreGraphics.
//!
//! CoreGraphics' global display space already uses a top-left origin anchored
//! at the primary display, which is the convention we expose everywhere else,
//! so no Y-flipping is needed here. (Cocoa's `NSScreen` uses bottom-left — that
//! conversion only matters where we touch AppKit, in `platform.rs`.)

use super::{CaptureError, DisplayInfo, Rect, Result, WindowInfo};

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use core_foundation::base::{CFType, CFTypeRef, TCFType, ToVoid};
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use core_graphics::display::CGDisplay;
    use core_graphics::window::{
        copy_window_info, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
    };

    pub fn displays() -> Result<Vec<DisplayInfo>> {
        let ids = CGDisplay::active_displays().map_err(|e| {
            CaptureError::Process(format!("CGGetActiveDisplayList failed with code {e}"))
        })?;
        if ids.is_empty() {
            return Err(CaptureError::NoDisplays);
        }

        let main_id = CGDisplay::main().id;
        let mut out = Vec::with_capacity(ids.len());

        for id in ids {
            let display = CGDisplay::new(id);
            let b = display.bounds();

            // Ask the display *mode* for both figures. `CGDisplayPixelsWide`
            // reports points rather than backing pixels on a scaled Retina
            // display, which silently yields 1.0 and makes Retina captures look
            // like 1x. The mode exposes the two separately and is always right.
            let scale = display
                .display_mode()
                .map(|mode| {
                    let points = mode.width() as f64;
                    if points > 0.0 {
                        mode.pixel_width() as f64 / points
                    } else {
                        1.0
                    }
                })
                .unwrap_or(1.0)
                .max(1.0);

            out.push(DisplayInfo {
                id,
                bounds: Rect {
                    x: b.origin.x,
                    y: b.origin.y,
                    width: b.size.width,
                    height: b.size.height,
                },
                scale,
                is_primary: id == main_id,
            });
        }

        Ok(out)
    }

    /// Fetch a key from an untyped CFDictionary.
    ///
    /// CoreGraphics returns `CFDictionary<*const c_void, *const c_void>`, so
    /// both keys and values are raw pointers that we re-wrap by hand.
    fn dict_get(dict: &CFDictionary, key: &str) -> Option<CFType> {
        let k = CFString::new(key);
        let value = dict.find(k.to_void())?;
        if (*value).is_null() {
            return None;
        }
        // SAFETY: the value is owned by `dict`, which outlives this borrow, and
        // get-rule wrapping retains it for as long as we hold the CFType.
        Some(unsafe { CFType::wrap_under_get_rule(*value as CFTypeRef) })
    }

    fn dict_number(dict: &CFDictionary, key: &str) -> Option<f64> {
        dict_get(dict, key)?.downcast::<CFNumber>()?.to_f64()
    }

    fn dict_string(dict: &CFDictionary, key: &str) -> Option<String> {
        Some(dict_get(dict, key)?.downcast::<CFString>()?.to_string())
    }

    fn dict_dict(dict: &CFDictionary, key: &str) -> Option<CFDictionary> {
        dict_get(dict, key)?.downcast::<CFDictionary>()
    }

    /// Describe one CGWindowList entry, or `None` when it isn't a real window
    /// belonging to another application.
    fn parse_window(dict: &CFDictionary) -> Option<WindowInfo> {
        // Fully transparent windows are invisible helpers, not real targets.
        if dict_number(dict, "kCGWindowAlpha").unwrap_or(1.0) <= 0.01 {
            return None;
        }

        let id = dict_number(dict, "kCGWindowNumber")?;
        let bounds_dict = dict_dict(dict, "kCGWindowBounds")?;
        let app_name = dict_string(dict, "kCGWindowOwnerName").unwrap_or_default();

        // Shotly's own windows must never be offered as a capture target.
        // Neither must the system picker's own full-screen sheet, which is an
        // ordinary layer-0 window named "windowselection" owned by
        // `screencapture` — and which, incidentally, is why the truth about
        // what is really on screen cannot be checked while the picker is up.
        if app_name == "Shotly" || app_name == "screencapture" {
            return None;
        }

        Some(WindowInfo {
            id: id as u32,
            title: dict_string(dict, "kCGWindowName").unwrap_or_default(),
            app_name,
            bounds: Rect {
                x: dict_number(&bounds_dict, "X").unwrap_or(0.0),
                y: dict_number(&bounds_dict, "Y").unwrap_or(0.0),
                width: dict_number(&bounds_dict, "Width").unwrap_or(0.0),
                height: dict_number(&bounds_dict, "Height").unwrap_or(0.0),
            },
            layer: dict_number(dict, "kCGWindowLayer").unwrap_or(0.0) as i32,
        })
    }

    fn window_list() -> Result<core_foundation::array::CFArray> {
        let options = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
        copy_window_info(options, 0)
            .ok_or_else(|| CaptureError::Process("CGWindowListCopyWindowInfo returned null".into()))
    }

    /// Is this something the user could sensibly capture?
    ///
    /// Layer 0 is the normal application window layer. Everything above it is
    /// system chrome, and it is not merely uninteresting — the Dock owns an
    /// invisible full-screen window at layer 20 that sits in front of every
    /// application, so admitting other layers makes the Dock the answer to
    /// every hit test.
    fn is_target(info: &WindowInfo) -> bool {
        // Slivers are 1px helper windows some apps keep around.
        info.layer == 0 && info.bounds.width >= 40.0 && info.bounds.height >= 40.0
    }

    pub fn windows() -> Result<Vec<WindowInfo>> {
        let list = window_list()?;
        let mut out = Vec::new();

        for item in list.iter() {
            // Each element is a CFDictionaryRef describing one window.
            // SAFETY: each element of the window list is a CFDictionaryRef
            // owned by the array we are iterating.
            let dict = unsafe { CFDictionary::wrap_under_get_rule(*item as CFDictionaryRef) };
            let Some(info) = parse_window(&dict) else { continue };

            if is_target(&info) {
                out.push(info);
            }
        }

        Ok(out)
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;

    pub fn displays() -> Result<Vec<DisplayInfo>> {
        Err(CaptureError::Process("only macOS is supported".into()))
    }

    pub fn windows() -> Result<Vec<WindowInfo>> {
        Err(CaptureError::Process("only macOS is supported".into()))
    }
}

pub use imp::{displays, windows};

/// The union of every display: the rect the selection overlay must cover.
pub fn virtual_bounds(displays: &[DisplayInfo]) -> Option<Rect> {
    let first = displays.first()?;
    let mut min_x = first.bounds.x;
    let mut min_y = first.bounds.y;
    let mut max_x = first.bounds.x + first.bounds.width;
    let mut max_y = first.bounds.y + first.bounds.height;

    for d in displays.iter().skip(1) {
        min_x = min_x.min(d.bounds.x);
        min_y = min_y.min(d.bounds.y);
        max_x = max_x.max(d.bounds.x + d.bounds.width);
        max_y = max_y.max(d.bounds.y + d.bounds.height);
    }

    Some(Rect { x: min_x, y: min_y, width: max_x - min_x, height: max_y - min_y })
}
