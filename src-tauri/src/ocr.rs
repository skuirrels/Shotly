//! Reading what a picture says: its text, and any code printed in it.
//!
//! Both are the operating system's own, on every platform Shotly runs on —
//! no model to ship, no network, nothing leaves the machine. This module is
//! the part that is the same either way: the types, and cropping the pixels
//! down to the region asked about. The recogniser itself is
//! `platform::text::read`.
//!
//! Both run on one pass over the same pixels. Vision takes an array of requests
//! and decodes the image once for all of them, so asking about barcodes as well
//! as text costs a fraction of what a second call would, and it means the user
//! never has to decide in advance which of the two they dragged a box around.

use serde::{Deserialize, Serialize};

/// The part of the capture to read, in source-image pixels.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Region {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Where something sits in the picture, as fractions of its width and height.
///
/// Top-left origin, like every other rectangle in this app. Vision reports its
/// own boxes bottom-left, and that flip is done once, at the recogniser, so
/// nothing above this file has to know about it — the same reason `crop_to_png`
/// crops rather than passing a region of interest down.
#[derive(Debug, Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct NormRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// One run of text, and how sure Vision is about it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLine {
    pub text: String,
    /// 0 to 1. Shown so a doubtful line can be eyed rather than trusted.
    pub confidence: f32,
    /// Where the line is, for anything that wants to draw over it — the
    /// automatic redaction, in practice. Absent where the recogniser gives no
    /// box.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rect: Option<NormRect>,
}

/// A QR code, barcode or similar, and what it had written in it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Code {
    /// What the code says. A URL, most of the time.
    pub payload: String,
    /// "QR", "Aztec", "Code128" — Vision's own name, with its prefix trimmed.
    pub symbology: String,
}

/// Everything one look at the pixels turned up.
#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    pub lines: Vec<TextLine>,
    pub codes: Vec<Code>,
}

/// Read what an image says, or what one rectangle of it says.
///
/// The path rather than the bytes: a full-screen retina capture is around
/// 8 MB, and marshalling that through the IPC bridge as a JSON array of
/// numbers costs more than the recognition does.
#[tauri::command]
pub fn scan_image(path: String, region: Option<Region>) -> Result<Scan, String> {
    let png = crop_to_png(&path, region)?;
    crate::platform::text::read(&png)
}

/// The requested rectangle, as PNG bytes for Vision to take.
///
/// Cropping here rather than setting the request's region of interest: the
/// region is expressed in normalised, bottom-left-origin coordinates, which is
/// one flip away from every other rectangle in this app and exactly the kind
/// of thing that is wrong for months without anyone noticing.
fn crop_to_png(path: &str, region: Option<Region>) -> Result<Vec<u8>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("could not read {path}: {e}"))?;
    let Some(region) = region else {
        return Ok(bytes);
    };

    let image = image::load_from_memory(&bytes).map_err(|e| format!("could not decode: {e}"))?;
    let (w, h) = (image.width(), image.height());

    // A marquee dragged past the edge is the user asking for "to the end",
    // not an error.
    let x = region.x.min(w.saturating_sub(1));
    let y = region.y.min(h.saturating_sub(1));
    let width = region.width.min(w - x);
    let height = region.height.min(h - y);
    if width == 0 || height == 0 {
        return Err("that area is empty".into());
    }

    let cropped = image.crop_imm(x, y, width, height);
    let mut out = Vec::new();
    cropped
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("could not re-encode: {e}"))?;
    Ok(out)
}

