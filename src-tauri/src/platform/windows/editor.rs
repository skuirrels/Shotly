//! Writing out a recording as a list of the parts worth keeping — on Windows.
//!
//! Media Foundation's `SourceReader` and `SinkWriter` are the counterparts to
//! `AVAssetReader`/`AVAssetWriter`, and `Precision::Exact` maps onto them
//! closely: decode, re-encode to H.264 at the source's size and frame rate,
//! mux. That half is a translation.
//!
//! # The half that is not a translation
//!
//! `Precision::Fast` on macOS is frame-accurate *and* lossless, and it manages
//! both by leaning on a QuickTime feature Media Foundation's MP4 sink does not
//! write: an **edit list**. The samples of a cut can only begin at a sync
//! sample, so AVFoundation copies from the sync sample before the mark and
//! then hides the run-up behind an edit that starts playback at the exact
//! instant asked for. Without edit lists there is nowhere to hide it, so a
//! passthrough cut on Windows lands on the sync sample itself — up to a
//! keyframe interval away from where the user put the mark.
//!
//! Three ways out, in the order they should be considered:
//!
//! 1. **Shorten the interval.** Unlike `screencapture -v`, the recorder here
//!    is ours (see `recorder.rs`), so the GOP length is a choice. At a
//!    keyframe every half-second the error is small enough that `Fast` stays
//!    the sensible default for trimming the ends.
//! 2. **Make `Exact` the default for cuts**, where landing on the mark is the
//!    whole point, and keep `Fast` for `Keep`, where the ends being trimmed
//!    are the dead air nobody is trying to remove. `trim.rs` already draws
//!    exactly this distinction for a different reason.
//! 3. **Write the edit list by hand** into the `elst` box after muxing. It is
//!    a small box in a documented format and this is a real option, but it
//!    means owning part of the file layout, which is a large promise for a
//!    feature that option 2 already answers.
//!
//! This is a product decision, not a porting detail: whichever is chosen, a
//! cut on Windows behaves slightly differently from a cut on macOS, and the
//! honest thing is for the interface to say which it is doing. See
//! `docs/WINDOWS.md`.

use std::path::Path;

use crate::trim::{Precision, Segment};

/// Write `keep`, joined end to end, to `dest`.
pub fn write(
    _source: &Path,
    _dest: &Path,
    _keep: &[Segment],
    _precision: Precision,
    _progress: &mut dyn FnMut(f32),
) -> Result<(), String> {
    Err("trimming a recording is not implemented on this platform yet".into())
}

/// The times a passthrough segment may begin at, in seconds.
///
/// `IMFSourceReader` reporting `MFSampleExtension_CleanPoint` on each sample
/// is the counterpart to walking for sync samples. An empty list is a safe
/// answer — `trim::plan` treats it as "no constraint to honour" and the cut
/// falls back to the mark itself.
pub fn sync_points(_source: &Path) -> Vec<f64> {
    Vec::new()
}
