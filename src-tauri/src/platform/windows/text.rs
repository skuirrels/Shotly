//! Reading what a picture says — on Windows.
//!
//! `Windows.Media.Ocr.OcrEngine` is built into the OS and needs no model
//! shipped with the app, which makes the text half a close match for Vision:
//! `OcrEngine::TryCreateFromUserProfileLanguages` then `RecognizeAsync` over a
//! `SoftwareBitmap`, giving lines with bounding boxes — everything
//! `crate::ocr`'s reading order needs. Accuracy is generally a little below
//! Vision's; there is no accurate/fast switch to trade for it.
//!
//! **There is no barcode reader**, which is the one real gap. Windows has
//! nothing equivalent to `VNDetectBarcodesRequest`, so QR and barcode payloads
//! need a crate — `rxing` (a Rust port of ZXing) reads the same symbologies
//! Vision does. That is the only place in the whole port where a macOS feature
//! has no system counterpart at all and a dependency has to make up for it.
//!
//! One structural difference worth planning for: Vision decodes the image once
//! and serves both requests from that single pass, which is why asking about
//! barcodes is nearly free. Here they are two separate passes over the pixels,
//! so the cost of scanning for codes is real — but it is still well under the
//! time it takes to look at the result.
//!
//! See `docs/WINDOWS.md`.

use crate::ocr::Scan;

pub fn read(_png: &[u8]) -> Result<Scan, String> {
    Err("reading text from an image is not implemented on this platform yet".into())
}
