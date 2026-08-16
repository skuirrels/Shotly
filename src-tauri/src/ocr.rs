//! Reading the text back out of a picture of text.
//!
//! macOS has done this natively since Monterey, and does it well — the whole
//! job here is handing Vision some pixels and putting what comes back in a
//! sensible order. No model to ship, no network, nothing leaves the machine.

use serde::{Deserialize, Serialize};

/// The part of the capture to read, in source-image pixels.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Region {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// One run of text, and how sure Vision is about it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLine {
    pub text: String,
    /// 0 to 1. Shown so a doubtful line can be eyed rather than trusted.
    pub confidence: f32,
}

/// Read the text in an image file, or in one rectangle of it.
///
/// The path rather than the bytes: a full-screen retina capture is around
/// 8 MB, and marshalling that through the IPC bridge as a JSON array of
/// numbers costs more than the recognition does.
#[tauri::command]
pub fn recognize_text(path: String, region: Option<Region>) -> Result<Vec<TextLine>, String> {
    let png = crop_to_png(&path, region)?;
    read(&png)
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

#[cfg(target_os = "macos")]
fn read(png: &[u8]) -> Result<Vec<TextLine>, String> {
    use objc2::rc::Retained;
    use objc2::AnyThread;
    use objc2_foundation::{NSArray, NSData, NSDictionary};
    use objc2_vision::{
        VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
    };

    let data = NSData::with_bytes(png);

    unsafe {
        let request = VNRecognizeTextRequest::new();
        // Accurate over fast: this runs on a still image the user is looking
        // at, where a wrong character costs more than a tenth of a second.
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setUsesLanguageCorrection(true);

        let handler = VNImageRequestHandler::initWithData_options(
            VNImageRequestHandler::alloc(),
            &data,
            &NSDictionary::new(),
        );

        // Two steps up the chain: a text request is an image-based request
        // before it is a request, and `performRequests:` wants the base class.
        let requests: Retained<NSArray<VNRequest>> = NSArray::from_retained_slice(&[
            Retained::into_super(Retained::into_super(request.clone())),
        ]);
        handler
            .performRequests_error(&requests)
            .map_err(|e| format!("the text recogniser failed: {e}"))?;

        let Some(results) = request.results() else {
            return Ok(Vec::new());
        };

        let mut found = Vec::new();
        for observation in results.iter() {
            // One candidate: the alternatives are the same line spelled
            // slightly differently, and nothing here would know which to show.
            let candidates = observation.topCandidates(1);
            let Some(best) = candidates.iter().next() else {
                continue;
            };
            let box_ = observation.boundingBox();
            found.push((
                TextLine {
                    text: best.string().to_string(),
                    confidence: best.confidence(),
                },
                // Normalised, and bottom-left origin — so a larger y is
                // further *up* the image.
                box_.origin.y as f32,
                box_.origin.x as f32,
                box_.size.height as f32,
            ));
        }

        // Into reading order. Vision returns its observations in whatever
        // order it found them, which for anything but a single column is not
        // the order a person would read them — and text pasted out of order is
        // worse than no text at all.
        //
        // Rows are gathered before anything is compared left-to-right, rather
        // than sorting once with a "near enough vertically" comparator: that
        // comparator is not a total order — A can share a row with B, and B
        // with C, while A and C do not — and Rust's sort detects exactly that
        // and panics.
        found.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        let mut rows: Vec<Vec<(TextLine, f32, f32, f32)>> = Vec::new();
        for item in found {
            match rows.last_mut() {
                // Within half a line of the run that opened this row: the same
                // line of text, with a gap in it.
                Some(row) if (row[0].1 - item.1).abs() < row[0].3.min(item.3) / 2.0 => {
                    row.push(item)
                }
                _ => rows.push(vec![item]),
            }
        }

        Ok(rows
            .into_iter()
            .flat_map(|mut row| {
                row.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal));
                row.into_iter().map(|(line, ..)| line)
            })
            .collect())
    }
}

#[cfg(not(target_os = "macos"))]
fn read(_png: &[u8]) -> Result<Vec<TextLine>, String> {
    Err("text recognition needs macOS".into())
}

