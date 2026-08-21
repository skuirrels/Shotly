//! Reading what a picture says: its text, and any code printed in it.
//!
//! macOS has done both natively since Monterey, and does them well — the whole
//! job here is handing Vision some pixels and putting what comes back in a
//! sensible order.
//!
//! Both run on one pass over the same pixels. Vision takes an array of requests
//! and decodes the image once for all of them, so asking about barcodes as well
//! as text costs a fraction of what a second call would, and it means the user
//! never has to decide in advance which of the two they dragged a box around.

use crate::ocr::{Code, NormRect, Scan, TextLine};

pub fn read(png: &[u8]) -> Result<Scan, String> {
    use objc2::rc::Retained;
    use objc2::AnyThread;
    use objc2_foundation::{NSArray, NSData, NSDictionary};
    use objc2_vision::{
        VNDetectBarcodesRequest, VNImageRequestHandler, VNRecognizeTextRequest, VNRequest,
        VNRequestTextRecognitionLevel,
    };

    let data = NSData::with_bytes(png);

    unsafe {
        let request = VNRecognizeTextRequest::new();
        // Accurate over fast: this runs on a still image the user is looking
        // at, where a wrong character costs more than a tenth of a second.
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setUsesLanguageCorrection(true);

        // Left at its default set of symbologies, which is every one this
        // version of macOS can read. Narrowing it to QR would be faster by an
        // amount nobody could perceive, and would fail on the barcode someone
        // eventually points it at.
        let barcodes = VNDetectBarcodesRequest::new();

        let handler = VNImageRequestHandler::initWithData_options(
            VNImageRequestHandler::alloc(),
            &data,
            &NSDictionary::new(),
        );

        // Two steps up the chain for each: these are image-based requests
        // before they are requests, and `performRequests:` wants the base class.
        let requests: Retained<NSArray<VNRequest>> = NSArray::from_retained_slice(&[
            Retained::into_super(Retained::into_super(request.clone())),
            Retained::into_super(Retained::into_super(barcodes.clone())),
        ]);
        handler
            .performRequests_error(&requests)
            .map_err(|e| format!("the recogniser failed: {e}"))?;

        let codes = collect_codes(&barcodes);

        let Some(results) = request.results() else {
            return Ok(Scan { lines: Vec::new(), codes });
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
                    // Flipped to a top-left origin here and nowhere else. See
                    // `NormRect` — a rectangle that means something different
                    // from every other rectangle in the app is exactly the sort
                    // of thing that is wrong for months without being noticed.
                    rect: Some(NormRect {
                        x: box_.origin.x as f32,
                        y: 1.0 - (box_.origin.y + box_.size.height) as f32,
                        width: box_.size.width as f32,
                        height: box_.size.height as f32,
                    }),
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

        let lines = rows
            .into_iter()
            .flat_map(|mut row| {
                row.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal));
                row.into_iter().map(|(line, ..)| line)
            })
            .collect();

        Ok(Scan { lines, codes })
    }
}

/// What the barcode half of the pass found, top to bottom.
///
/// Codes without a string payload are dropped rather than shown as an empty
/// row: some symbologies carry raw bytes that are not text in any encoding,
/// and there is nothing useful to do with those here.
unsafe fn collect_codes(request: &objc2_vision::VNDetectBarcodesRequest) -> Vec<Code> {
    let Some(results) = request.results() else {
        return Vec::new();
    };

    let mut found: Vec<(Code, f32, f32)> = Vec::new();
    for observation in results.iter() {
        let Some(payload) = observation.payloadStringValue() else {
            continue;
        };
        let payload = payload.to_string();
        if payload.is_empty() {
            continue;
        }

        let box_ = observation.boundingBox();
        found.push((
            Code {
                payload,
                symbology: observation
                    .symbology()
                    .to_string()
                    .trim_start_matches("VNBarcodeSymbology")
                    .to_string(),
            },
            // Normalised and bottom-left origin, as everywhere in Vision, so
            // a larger y is further up the image.
            box_.origin.y as f32,
            box_.origin.x as f32,
        ));
    }

    // Reading order, without the row bucketing the text half needs: several
    // codes in one picture are a list to work down, and two of them at exactly
    // the same height is not a case worth a second sort key.
    found.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal))
    });

    found.into_iter().map(|(code, ..)| code).collect()
}
