//! Writing out a recording as a list of the parts worth keeping.
//!
//! One operation underneath two: keeping the middle and throwing the ends away
//! is a list of one part, and cutting a section out of the middle is a list of
//! two. Nothing here knows which of those it is doing — see `trim.rs`, which
//! turns marks on a timeline into the list.
//!
//! # Why AVFoundation and not another subprocess
//!
//! The trim used to be `/usr/bin/avconvert --start --duration`, in the spirit
//! of `screencapture` and `qlmanage`, and for one span that was exactly right.
//! A cut is where it runs out: `avconvert` writes one span per run, and joining
//! two of its outputs would need a muxer that macOS does not ship as a command.
//! So the join has to happen in-process, and an `AVMutableComposition` is the
//! thing that does it — at which point the composition can hold one segment
//! just as easily as two, and the converter has nothing left to do that this
//! does not do better.
//!
//! What it buys, beyond the cut: no child process to supervise, no deadline on
//! somebody else's binary, and errors that say what went wrong instead of a
//! usage dump on stderr.
//!
//! # Why it stays lossless
//!
//! `AVAssetExportPresetPassthrough` copies the sample data instead of decoding
//! and re-encoding it. The samples of a cut can only begin at a sync sample, so
//! the composition's segments carry edit lists that start playback at the exact
//! instant asked for — the cut is frame-accurate and the pixels are the ones
//! that were recorded. A re-encoding preset would cost minutes on a Retina
//! capture and give back a worse-looking file.
//!
//! Passthrough is also what makes joining two segments safe: both come from one
//! asset, so they are the same codec at the same size, and there is no format
//! negotiation to get wrong.

use std::path::Path;

use block2::StackBlock;
use objc2_av_foundation::{
    AVAssetExportPresetPassthrough, AVAssetExportSession, AVAssetExportSessionStatus, AVFileType,
    AVFileTypeMPEG4, AVFileTypeQuickTimeMovie, AVMediaTypeVideo, AVMutableComposition, AVURLAsset,
};
use objc2_core_media::{CMTime, CMTimeRange};
use objc2_foundation::{NSString, NSURL};

/// The timescale times are built at.
///
/// 600 is QuickTime's traditional choice because it divides exactly by 24, 25,
/// 30 and 60 — every frame rate a screen recording is likely to have — so a
/// mark on the timeline lands on a frame boundary rather than a hair off one.
const TIMESCALE: i32 = 600;

/// How long the export may run before it is given up on.
///
/// Passthrough is I/O-bound and finishes in seconds even on a recording of
/// several hundred megabytes, so this is not a budget — it is the guarantee
/// that a wedged export cannot hold a Tauri worker thread for ever.
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

/// How often the export is asked whether it has finished.
const POLL: std::time::Duration = std::time::Duration::from_millis(50);

/// A stretch of the source to keep, in seconds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Segment {
    pub start: f64,
    pub seconds: f64,
}

/// Write `keep`, joined end to end, to `dest`.
///
/// The parts are laid down in the order given and each is appended to whatever
/// is already there, so two segments come out as one continuous movie with the
/// gap closed.
///
/// `progress` is called with 0..1 as the export runs. It is a callback rather
/// than an event so that nothing here has to know what a Tauri window is —
/// the same arrangement `share::Provider::upload` uses for the same reason.
pub fn write(
    source: &Path,
    dest: &Path,
    keep: &[Segment],
    progress: &mut dyn FnMut(f32),
) -> Result<(), String> {
    if keep.is_empty() {
        return Err("there is nothing left to keep".into());
    }

    // SAFETY: every call below is a plain Objective-C message to an object this
    // function owns, on values it created. None of it touches the main thread
    // or any UI object, which is what would make AVFoundation particular about
    // where it is called from; an export is explicitly a background operation.
    unsafe {
        let asset = AVURLAsset::URLAssetWithURL_options(&url_for(source), None);
        let composition = AVMutableComposition::composition();

        for part in keep {
            let range = CMTimeRange {
                start: CMTime::with_seconds(part.start, TIMESCALE),
                duration: CMTime::with_seconds(part.seconds, TIMESCALE),
            };
            // Appended at the composition's current end, which is what turns a
            // list of parts into one movie with the gaps closed.
            //
            // The deprecation is Apple steering callers to an async variant
            // that reports progress through a block. This whole function is
            // synchronous by design — it runs on a Tauri worker thread and the
            // work takes seconds — so the block would buy nothing but a way to
            // get the lifetimes wrong.
            #[allow(deprecated)]
            composition
                .insertTimeRange_ofAsset_atTime_error(range, &asset, composition.duration())
                .map_err(|e| format!("could not assemble the recording: {}", describe(&e)))?;
        }

        let session = AVAssetExportSession::exportSessionWithAsset_presetName(
            &composition,
            AVAssetExportPresetPassthrough,
        )
        .ok_or("this recording cannot be cut without re-encoding it")?;

        session.setOutputURL(Some(&url_for(dest)));
        session.setOutputFileType(file_type(dest));

        // The completion handler does nothing: `status` is the same answer and
        // reading it from this thread avoids handing AVFoundation a closure
        // that has to outlive the call. The block is required all the same —
        // this is the method that starts the export.
        session.exportAsynchronouslyWithCompletionHandler(&StackBlock::new(|| {}));

        let deadline = std::time::Instant::now() + TIMEOUT;
        loop {
            match session.status() {
                AVAssetExportSessionStatus::Completed => return Ok(()),
                AVAssetExportSessionStatus::Failed => {
                    return Err(match session.error() {
                        Some(e) => format!("could not write the recording: {}", describe(&e)),
                        None => "could not write the recording".into(),
                    })
                }
                AVAssetExportSessionStatus::Cancelled => {
                    return Err("the export was cancelled".into())
                }
                _ if std::time::Instant::now() >= deadline => {
                    session.cancelExport();
                    return Err("that recording took too long to write out".into());
                }
                _ => {
                    progress(session.progress());
                    std::thread::sleep(POLL);
                }
            }
        }
    }
}

/// Every instant a segment may begin at, in seconds, in order.
///
/// These are the track's **full sync samples** — the frames that can be decoded
/// without reference to any other. They matter because a passthrough export
/// cannot re-encode: a segment starting anywhere else has to carry the samples
/// back to the preceding sync sample so the first frame can be decoded at all,
/// and then hide them behind an edit list. That hidden run-up is real footage
/// sitting in the file. Beginning every segment on one of these instants is
/// what makes it not exist rather than merely not play. See `trim::plan`.
///
/// Empty if the track cannot be walked, which the caller reads as "do not
/// snap": a recording that will not give up its sync samples should still be
/// trimmable, on the old terms.
pub fn sync_points(source: &Path) -> Vec<f64> {
    let mut points = Vec::new();

    // SAFETY: as `write` — messages to objects this function owns, none of them
    // UI, on a thread of the caller's choosing.
    unsafe {
        let asset = AVURLAsset::URLAssetWithURL_options(&url_for(source), None);
        let Some(media_type) = AVMediaTypeVideo else { return points };
        // Deprecated in favour of an async, block-based variant. This whole
        // function is synchronous by design — it runs on a worker thread and
        // costs under a millisecond on a short recording — so the block would
        // buy nothing but a way to get the lifetimes wrong.
        #[allow(deprecated)]
        let tracks = asset.tracksWithMediaType(media_type);
        let Some(track) = tracks.firstObject() else { return points };

        let zero = CMTime::with_seconds(0.0, TIMESCALE);
        let Some(cursor) = track.makeSampleCursorWithPresentationTimeStamp(zero) else {
            return points;
        };

        // Walked one sample at a time because AVFoundation offers no "next sync
        // sample" jump. That is thousands of messages for a long recording and
        // still costs milliseconds — but the bound is here anyway, because this
        // runs on a worker thread and a cursor that never reports the end would
        // otherwise spin for ever.
        const LIMIT: usize = 500_000;
        for _ in 0..LIMIT {
            if cursor.currentSampleSyncInfo().sampleIsFullSync.as_bool() {
                points.push(cursor.presentationTimeStamp().seconds());
            }
            if cursor.stepInPresentationOrderByCount(1) == 0 {
                break;
            }
        }
    }

    // Presentation order is not decode order, and the caller wants a timeline.
    points.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    points
}

/// A `file:` URL for a path, which is the only kind AVFoundation takes here.
fn url_for(path: &Path) -> objc2::rc::Retained<NSURL> {
    NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))
}

/// The container to write, chosen from the destination's extension.
///
/// Matched to the source elsewhere, so a trimmed `.mov` stays a `.mov`. QuickTime
/// is the fallback because that is what `screencapture -v` writes and so what
/// almost every recording here is.
fn file_type(dest: &Path) -> Option<&'static AVFileType> {
    let mp4 = dest
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_ascii_lowercase().as_str(), "mp4" | "m4v"))
        .unwrap_or(false);

    // SAFETY: reading two immutable statics AVFoundation exports.
    unsafe {
        if mp4 {
            AVFileTypeMPEG4
        } else {
            AVFileTypeQuickTimeMovie
        }
    }
}

/// What an `NSError` says, in one line fit for a toast.
fn describe(error: &objc2_foundation::NSError) -> String {
    error.localizedDescription().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The harness's twelve-second test pattern, found through the manifest
    /// directory so the test does not care where it was run from.
    fn sample() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../harness/sample.mov")
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(name);
        let _ = std::fs::remove_file(&path);
        path
    }

    /// One segment: the trim. Asked of `video::probe`, which is the code the
    /// library and the player use, because a file that exports cleanly and
    /// cannot then be measured would reach the library as a recording with no
    /// duration and no thumbnail.
    #[test]
    fn one_segment_comes_back_as_a_movie_shotly_can_measure() {
        let dest = scratch("shotly-compose-one.mov");
        write(&sample(), &dest, &[Segment { start: 2.5, seconds: 5.0 }], &mut |_| {})
            .expect("should export");

        let info = crate::video::probe(&dest).expect("a trim must be measurable");
        // Exact, not "near a keyframe": the edit list is what buys this, and
        // losing it to a preset change would show up here first.
        assert!((info.seconds - 5.0).abs() < 0.05, "{} seconds", info.seconds);
        // Passthrough copies the samples, so the picture is the one that went
        // in. A re-encode would show up here as a resize.
        assert_eq!((info.width, info.height), (1280, 720));

        let _ = std::fs::remove_file(&dest);
    }

    /// Two segments: the cut. This is the one that could not be done with a
    /// converter at all, and the assertion that matters is the arithmetic —
    /// twelve seconds with four taken out of the middle is eight, and if the
    /// join silently dropped the second part it would be four.
    #[test]
    fn two_segments_are_joined_into_one_movie_with_the_gap_closed() {
        let dest = scratch("shotly-compose-two.mov");
        write(
            &sample(),
            &dest,
            &[Segment { start: 0.0, seconds: 4.0 }, Segment { start: 8.0, seconds: 4.0 }],
            &mut |_| {},
        )
        .expect("should export");

        let info = crate::video::probe(&dest).expect("a cut must be measurable");
        assert!((info.seconds - 8.0).abs() < 0.1, "{} seconds", info.seconds);
        assert_eq!((info.width, info.height), (1280, 720));

        let _ = std::fs::remove_file(&dest);
    }

    #[test]
    fn a_recording_with_nothing_left_in_it_is_refused() {
        assert!(write(&sample(), &scratch("shotly-compose-none.mov"), &[], &mut |_| {}).is_err());
    }
}

