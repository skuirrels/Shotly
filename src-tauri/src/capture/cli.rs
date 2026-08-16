//! `screencapture(1)`-backed implementation of [`CaptureBackend`].
//!
//! Shelling out buys correct colour profiles, Retina backing stores and
//! multi-display geometry with none of the Objective-C interop that a
//! ScreenCaptureKit backend needs. The cost is ~100ms of process spawn per
//! capture, which is invisible next to the user's own reaction time.

use super::display;
use super::{CaptureBackend, CaptureError, DisplayInfo, Frame, Rect, Result, WindowInfo};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// Has the user granted Screen Recording in System Settings > Privacy?
pub fn has_permission() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        CGPreflightScreenCaptureAccess()
    }
    #[cfg(not(target_os = "macos"))]
    true
}

/// Trigger the system permission prompt. Only shows once per app install;
/// afterwards the user has to go to System Settings themselves.
pub fn request_permission() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        CGRequestScreenCaptureAccess()
    }
    #[cfg(not(target_os = "macos"))]
    true
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Read a PNG's backing scale from its `pHYs` chunk.
///
/// macOS stamps every screenshot with the DPI of the display it came from —
/// 72 for a 1x screen, 144 for Retina. That makes the file itself the most
/// reliable source of truth: it describes the display actually captured, which
/// display-enumeration APIs cannot tell us (`screencapture -i` reports no
/// geometry) and which matters on a mixed-DPI multi-monitor setup.
fn png_scale(path: &std::path::Path) -> Option<f64> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }

    let mut pos = 8usize;
    while pos + 8 <= bytes.len() {
        let len = u32::from_be_bytes(bytes[pos..pos + 4].try_into().ok()?) as usize;
        let kind = &bytes[pos + 4..pos + 8];

        // pHYs always precedes the image data; stop rather than scan the pixels.
        if kind == b"IDAT" {
            return None;
        }

        if kind == b"pHYs" && len >= 9 {
            let body = bytes.get(pos + 8..pos + 17)?;
            let ppu_x = u32::from_be_bytes(body[0..4].try_into().ok()?);
            // A unit of 1 means metres; anything else has no physical meaning.
            if body[8] != 1 || ppu_x == 0 {
                return None;
            }

            let dpi = ppu_x as f64 * 0.0254;
            let scale = dpi / 72.0;
            // Snap to a sensible factor: DPI is integral, so this only tidies
            // the floating-point remainder rather than inventing a value.
            let snapped = (scale * 2.0).round() / 2.0;
            return if snapped >= 1.0 { Some(snapped) } else { None };
        }

        pos += 12 + len;
    }
    None
}

/// PNG chunk checksum. Shared with `markup`, which writes a chunk of its own.
pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

/// Stamp a PNG with the DPI matching `scale`, replacing any existing tag.
///
/// Canvas `toBlob` writes no `pHYs` chunk, so an exported capture would come
/// back as 1x when reopened — losing the Retina factor that `resolve_scale`
/// worked out at capture time. Writing it keeps a re-annotated capture
/// indistinguishable from the original, and matches what macOS itself records.
pub fn with_dpi(png: &[u8], scale: f64) -> Vec<u8> {
    const HEADER: usize = 8;
    if png.len() < HEADER || &png[..HEADER] != b"\x89PNG\r\n\x1a\n" || scale <= 0.0 {
        return png.to_vec();
    }

    // 72 dpi is 1x by convention; pHYs stores pixels per metre.
    let ppu = ((72.0 * scale) / 0.0254).round() as u32;

    let mut body = Vec::with_capacity(21);
    body.extend_from_slice(b"pHYs");
    body.extend_from_slice(&ppu.to_be_bytes());
    body.extend_from_slice(&ppu.to_be_bytes());
    body.push(1); // unit: metres

    let mut chunk = Vec::with_capacity(21);
    chunk.extend_from_slice(&9u32.to_be_bytes());
    chunk.extend_from_slice(&body);
    chunk.extend_from_slice(&crc32(&body).to_be_bytes());

    let mut out = Vec::with_capacity(png.len() + chunk.len());
    out.extend_from_slice(&png[..HEADER]);

    let mut pos = HEADER;
    let mut written = false;

    while pos + 8 <= png.len() {
        let Ok(len_bytes) = png[pos..pos + 4].try_into() else { break };
        let len = u32::from_be_bytes(len_bytes) as usize;
        let kind = &png[pos + 4..pos + 8];
        let end = match pos.checked_add(12 + len) {
            Some(e) if e <= png.len() => e,
            // Truncated or malformed: hand back the original untouched.
            _ => return png.to_vec(),
        };

        // Drop any existing tag so we never emit two.
        if kind == b"pHYs" {
            pos = end;
            continue;
        }

        // pHYs must precede the image data; IHDR is always first.
        if !written && kind == b"IDAT" {
            out.extend_from_slice(&chunk);
            written = true;
        }

        out.extend_from_slice(&png[pos..end]);
        pos = end;
    }

    if written { out } else { png.to_vec() }
}

/// Backing scale recorded in an image file, or 1.0 when it says nothing.
///
/// For a file already on disk the cursor tells us nothing useful, so this
/// consults the DPI tag alone.
pub fn scale_of_file(path: &std::path::Path) -> f64 {
    png_scale(path).unwrap_or(1.0).max(1.0)
}

/// Scale of whichever display the pointer is on.
///
/// Used only when a capture carries no DPI: still better than assuming the
/// primary display, since the cursor ends the drag on the screen just captured.
#[cfg(target_os = "macos")]
fn scale_under_cursor() -> Option<f64> {
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState).ok()?;
    let point = CGEvent::new(source).ok()?.location();

    display::displays().ok()?.into_iter().find_map(|d| {
        let b = d.bounds;
        let inside = point.x >= b.x
            && point.y >= b.y
            && point.x < b.x + b.width
            && point.y < b.y + b.height;
        inside.then_some(d.scale)
    })
}

#[cfg(not(target_os = "macos"))]
fn scale_under_cursor() -> Option<f64> {
    None
}

/// Best available backing scale for a freshly captured file.
fn resolve_scale(path: &std::path::Path) -> f64 {
    png_scale(path)
        .or_else(scale_under_cursor)
        .or_else(|| {
            display::displays()
                .ok()?
                .into_iter()
                .find(|d| d.is_primary)
                .map(|d| d.scale)
        })
        .unwrap_or(1.0)
        .max(1.0)
}

pub struct ScreencaptureCli {
    scratch: PathBuf,
}

impl ScreencaptureCli {
    pub fn new() -> Result<Self> {
        let scratch = std::env::temp_dir().join("shotly");
        std::fs::create_dir_all(&scratch)?;
        Ok(Self { scratch })
    }

    fn temp_png(&self, tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        self.scratch.join(format!("{tag}-{stamp}-{n}.png"))
    }

    fn run(args: &[&str]) -> Result<()> {
        let output = Command::new("/usr/sbin/screencapture")
            .args(args)
            .output()
            .map_err(|e| CaptureError::Process(format!("could not spawn screencapture: {e}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(CaptureError::Process(if stderr.is_empty() {
                format!("screencapture exited with {}", output.status)
            } else {
                stderr
            }));
        }
        Ok(())
    }

    /// Read back the PNG's real pixel size instead of trusting the display's
    /// reported scale — mirrored displays and scaled modes can disagree.
    fn frame_from_file(path: PathBuf, bounds: Rect) -> Result<Frame> {
        let (pw, ph) = image::image_dimensions(&path)?;
        let scale = if bounds.width > 0.0 { pw as f64 / bounds.width } else { 1.0 };

        Ok(Frame {
            path: path.to_string_lossy().into_owned(),
            bounds,
            pixel_width: pw,
            pixel_height: ph,
            scale,
        })
    }
}

impl CaptureBackend for ScreencaptureCli {
    fn displays(&self) -> Result<Vec<DisplayInfo>> {
        display::displays()
    }

    fn capture_displays(&self) -> Result<Vec<Frame>> {
        if !has_permission() {
            return Err(CaptureError::PermissionDenied);
        }

        let displays = display::displays()?;
        let mut frames = Vec::with_capacity(displays.len());

        for (idx, d) in displays.iter().enumerate() {
            let path = self.temp_png("display");
            // `-D` is a 1-based index into the same active-display list that
            // `CGGetActiveDisplayList` returns, so enumeration order lines up.
            // `-x` mutes the shutter, `-o` drops window shadows.
            let display_arg = (idx + 1).to_string();
            let path_str = path.to_string_lossy().into_owned();
            Self::run(&["-x", "-o", "-t", "png", "-D", &display_arg, &path_str])?;

            frames.push(Self::frame_from_file(path, d.bounds)?);
        }

        if frames.is_empty() {
            return Err(CaptureError::NoDisplays);
        }
        Ok(frames)
    }

    fn crop(&self, frame: &Frame, region: Rect) -> Result<Frame> {
        let clipped = region
            .intersect(&frame.bounds)
            .filter(|r| !r.is_empty())
            .ok_or_else(|| CaptureError::Process("selection is outside the captured area".into()))?;

        // Global points -> frame-local points -> backing-store pixels.
        let s = frame.scale;
        let px = ((clipped.x - frame.bounds.x) * s).round().max(0.0) as u32;
        let py = ((clipped.y - frame.bounds.y) * s).round().max(0.0) as u32;
        let pw = (clipped.width * s).round().max(1.0) as u32;
        let ph = (clipped.height * s).round().max(1.0) as u32;

        // Clamp so a rounding overshoot at the screen edge can't panic the crop.
        let pw = pw.min(frame.pixel_width.saturating_sub(px)).max(1);
        let ph = ph.min(frame.pixel_height.saturating_sub(py)).max(1);

        let img = image::open(&frame.path)?;
        let cropped = img.crop_imm(px, py, pw, ph);

        let out = self.temp_png("region");
        cropped.save(&out)?;

        Ok(Frame {
            path: out.to_string_lossy().into_owned(),
            bounds: clipped,
            pixel_width: pw,
            pixel_height: ph,
            scale: s,
        })
    }

    /// Hand selection to macOS's own `screencapture -i` crosshair.
    ///
    /// This replaces a custom transparent overlay window. That overlay was a
    /// full-screen, always-on-top, click-swallowing sheet: whenever it failed
    /// to paint, the desktop became unusable and Shotly had to be force-quit.
    /// The system selector cannot do that, gets Retina and multi-display right,
    /// and users already know it. The cost is our own magnifier and dimensions
    /// HUD, which is a good trade for a tool that can't wedge the machine.
    ///
    /// Blocks until the user finishes, so callers must be off the main thread.
    /// `Ok(None)` means the user pressed Escape.
    ///
    /// `window_mode` switches the crosshair for the system's window picker: the
    /// camera cursor that lights up whichever window is under the pointer and
    /// takes it on click. Shotly can draw that outline itself now, from the
    /// accessibility API, and does when it is allowed to — but that needs a
    /// permission this does not, and until it is granted this is the picker
    /// that behaves the way a window capture should. See `snap::capture_window`.
    fn capture_interactive(&self, window_mode: bool) -> Result<Option<Frame>> {
        if !has_permission() {
            return Err(CaptureError::PermissionDenied);
        }

        let path = self.temp_png("selection");
        let path_str = path.to_string_lossy().into_owned();

        let mut args = vec!["-x", "-t", "png", "-i"];
        if window_mode {
            // `-o` drops the drop shadow, so the captured window has the edges
            // it has on screen rather than a grey halo baked into the pixels.
            args.push("-w");
            args.push("-o");
        }
        args.push(&path_str);

        // A cancelled selection exits non-zero, which isn't an error — the
        // absence of the output file is what distinguishes the two.
        let _ = Command::new("/usr/sbin/screencapture").args(&args).status();

        if !path.exists() {
            return Ok(None);
        }

        let (pw, ph) = image::image_dimensions(&path)?;
        if pw == 0 || ph == 0 {
            let _ = std::fs::remove_file(&path);
            return Ok(None);
        }

        // `screencapture -i` reports no geometry, so take the scale from the
        // file's own DPI tag — correct even when the selection was made on a
        // secondary display with a different pixel density.
        let scale = resolve_scale(&path);

        Ok(Some(Frame {
            path: path_str,
            bounds: Rect {
                x: 0.0,
                y: 0.0,
                width: pw as f64 / scale,
                height: ph as f64 / scale,
            },
            pixel_width: pw,
            pixel_height: ph,
            scale,
        }))
    }

    fn capture_window(&self, window_id: u32) -> Result<Frame> {
        if !has_permission() {
            return Err(CaptureError::PermissionDenied);
        }

        let bounds = display::windows()?
            .into_iter()
            .find(|w| w.id == window_id)
            .map(|w| w.bounds)
            .ok_or_else(|| CaptureError::Process("that window no longer exists".into()))?;

        let path = self.temp_png("window");
        let id_str = window_id.to_string();
        let path_str = path.to_string_lossy().into_owned();
        // No `-o` here: the drop shadow is part of what makes a window capture
        // look like a window capture.
        Self::run(&["-x", "-t", "png", "-l", &id_str, &path_str])?;

        Self::frame_from_file(path, bounds)
    }

    fn list_windows(&self) -> Result<Vec<WindowInfo>> {
        display::windows()
    }
}
