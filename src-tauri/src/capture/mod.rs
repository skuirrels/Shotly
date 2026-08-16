//! Capture engine.
//!
//! Everything above this module talks to [`CaptureBackend`] only. The current
//! implementation shells out to the system `screencapture` binary, which gets
//! Retina scaling, colour profiles and multi-display geometry right for free.
//! A ScreenCaptureKit backend (needed for video) can be dropped in behind the
//! same trait without the rest of the app noticing.

pub mod cli;
pub mod display;

use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    #[error("screen recording permission has not been granted")]
    PermissionDenied,
    #[error("no displays were found")]
    NoDisplays,
    #[error("capture process failed: {0}")]
    Process(String),
    #[error("image decode/encode failed: {0}")]
    Image(#[from] image::ImageError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl serde::Serialize for CaptureError {
    // Fully qualified: the `Result<T>` alias below shadows `std::result::Result`
    // for the rest of this module.
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, CaptureError>;

/// A rectangle in the global (virtual desktop) coordinate space, in points.
///
/// macOS Cocoa uses a bottom-left origin; we normalise everything to a
/// top-left origin at the boundary so the frontend never has to think about it.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn is_empty(&self) -> bool {
        self.width < 1.0 || self.height < 1.0
    }

    /// Intersection with another rect, or `None` when they don't overlap.
    pub fn intersect(&self, other: &Rect) -> Option<Rect> {
        let x0 = self.x.max(other.x);
        let y0 = self.y.max(other.y);
        let x1 = (self.x + self.width).min(other.x + other.width);
        let y1 = (self.y + self.height).min(other.y + other.height);
        if x1 <= x0 || y1 <= y0 {
            return None;
        }
        Some(Rect { x: x0, y: y0, width: x1 - x0, height: y1 - y0 })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    pub id: u32,
    /// Position and size in global point space, top-left origin.
    pub bounds: Rect,
    /// Backing scale factor — 2.0 on Retina.
    pub scale: f64,
    pub is_primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub id: u32,
    pub title: String,
    pub app_name: String,
    pub bounds: Rect,
    pub layer: i32,
    /// True when this window has been taken full screen.
    ///
    /// Worth knowing because such a window cannot be captured by id at all:
    /// `screencapture -l` hands back its drop shadow and nothing else, an
    /// image whose middle is entirely transparent, whichever Space is in
    /// front. The picker says so rather than offering an empty rectangle.
    pub full_screen: bool,
}

/// A captured image plus the geometry it came from.
///
/// `rename_all` matters here: the frontend reads `pixelWidth`/`pixelHeight`,
/// and without it serde emits snake_case, which silently becomes `undefined`
/// in TypeScript and propagates as NaN through every dimension in the editor.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    /// Absolute path to the PNG on disk. The frontend loads it through the
    /// asset protocol rather than shuttling megabytes over IPC as base64.
    pub path: String,
    /// Logical bounds this frame covers in global point space.
    pub bounds: Rect,
    /// Pixel dimensions, which are `bounds * scale` on Retina.
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub scale: f64,
}

pub trait CaptureBackend: Send + Sync {
    /// Grab every display at once. Used to build the frozen backdrop the
    /// selection overlay draws, so the screen appears to stop while the user
    /// drags a region.
    fn capture_displays(&self) -> Result<Vec<Frame>>;

    /// Crop a previously captured display frame to a region, in global points.
    /// Cropping the freeze-frame (rather than re-capturing) means the pixels
    /// the user selected are exactly the pixels they saw.
    fn crop(&self, frame: &Frame, region: Rect) -> Result<Frame>;

    /// Interactive selection driven by the OS. Blocks; `None` means cancelled.
    fn capture_interactive(&self, window_mode: bool) -> Result<Option<Frame>>;

    /// Capture a single window including its shadow and rounded corners.
    fn capture_window(&self, window_id: u32) -> Result<Frame>;

    fn list_windows(&self) -> Result<Vec<WindowInfo>>;

    fn displays(&self) -> Result<Vec<DisplayInfo>>;
}
