//! Where a window's contents begin, read off its pixels.
//!
//! The same question [`ax::content_top`](crate::ax::content_top) answers, asked
//! of an application that will not answer it. Chrome is the reason this exists:
//! measured on Chrome 151, every accessibility call about the browser — the
//! window list, a hit test over its own tab strip, even *setting* the attribute
//! that is supposed to switch accessibility on — comes back
//! `kAXErrorAPIDisabled`. There is no version of asking that works, so the
//! toolbars have to be found by looking at them.
//!
//! # When this runs
//!
//! Only where an application refused to speak at all, never where it spoke and
//! said it has nothing above its contents. That distinction is the whole reason
//! this is safe to ship. Measured across a desktop of windows, the rule below
//! is right on Chrome (87pt, the browser chrome exactly, on two windows showing
//! different sites), a terminal (35pt, the tab bar) and Spotify (58pt, its top
//! nav) — and wrong on Excel, where it lands in the spreadsheet grid instead of
//! under the ribbon. Excel never reaches it: Excel answers accessibility, and
//! answers correctly. Every window this rule gets wrong is a window that never
//! asks it.
//!
//! # The rule
//!
//! Window chrome is a stack of full-width strips, so the boundary is the *last*
//! full-width horizontal step inside the top of the window. A step, not a line:
//! the colour has to be different above and below. That one condition is what
//! separates a toolbar's lower edge from a spreadsheet gridline or a row of
//! text, both of which cross the whole window and both of which leave the same
//! colour on either side of them.
//!
//! # What it cannot do
//!
//! Guess right every time. A page whose top is a full-width band of its own —
//! a dark hero image, a coloured site header — reads as one more strip, and
//! left to itself the rule would cut below it. The ceiling is what stops it:
//! nothing past 130pt, which is more than the tallest browser chrome and less
//! than where a site's header tends to end. Nothing past 30% of the window
//! either, and the wheel is always there to widen back to the whole window. An
//! outline that is occasionally too tight is recoverable; this is why it is a
//! fallback and not the first answer.

use image::RgbaImage;

/// How much of the window's width a real boundary spans. Toolbars go edge to
/// edge; everything that stops short of this is something drawn *on* one.
const COVER: f64 = 0.75;

/// How much the colour must change across a boundary, summed over the three
/// channels. Below this it is a line drawn on a surface, not the end of one.
const STEP: i32 = 12;

/// How different two pixels must be to count as a change, likewise summed.
const CHANGE: i32 = 30;

/// Rows this far apart are one boundary reported twice — the step down and the
/// step back up across a two-pixel edge.
const TOGETHER: u32 = 3;

/// The least a cut can take and still be worth making, in points. The same
/// figure `ax::content_top` uses, for the same reason.
const MIN_CUT: f64 = 16.0;

/// The most, in points and as a fraction of the window.
///
/// Bounded by what a *browser's* chrome can be, not by what any window's
/// furniture can be, because a browser is the only thing that ever reaches
/// here — everything else answers accessibility. Measured on Chromium: a tab
/// strip and a toolbar come to 87pt, and a bookmarks bar adds about 33pt more.
/// 130 clears the tallest of those with room to spare and still lands above
/// almost any site's own header, which is the thing this must not eat. It used
/// to be 200pt, which was generous enough to sail past the browser chrome
/// entirely and cut below GitHub's navigation instead — measured at 141.5pt on
/// a 2048×1068 window, where the right answer was 87.
const MAX_CUT: f64 = 130.0;
const MAX_FRACTION: f64 = 0.30;

/// How many columns to look at. The boundary spans the window, so it is found
/// as reliably in a hundred and sixty columns as in four thousand, and this
/// runs on a window's whole image.
const COLUMNS: u32 = 160;

/// How tall a band to take the colour of, on each side of a candidate.
const BAND: u32 = 34;
/// ...starting a little clear of the boundary itself, which is blended.
const CLEAR: u32 = 4;

/// Where the contents begin, in points from the top of the window.
///
/// The image must be the window's own rectangle — no drop shadow — or a row
/// does not map to a point on screen. See `capture_window_flush`.
pub fn content_top(image: &RgbaImage, scale: f64) -> Option<f64> {
    let (width, height) = image.dimensions();
    if width < 32 || height < 32 || scale <= 0.0 {
        return None;
    }

    let columns = sample_columns(width);
    let limit = ((height as f64) * MAX_FRACTION).min(MAX_CUT * scale) as u32;

    let mut found: Vec<u32> = Vec::new();
    for y in CLEAR..limit {
        let changed = columns
            .iter()
            .filter(|&&x| difference(image.get_pixel(x, y).0, image.get_pixel(x, y - 1).0) > CHANGE)
            .count();
        if (changed as f64) < (columns.len() as f64) * COVER {
            continue;
        }
        match found.last_mut() {
            Some(last) if y - *last <= TOGETHER => *last = y,
            _ => found.push(y),
        }
    }

    // Walked backwards: the answer is the last boundary that is a step rather
    // than a line, and there is no reason to price the ones above it.
    let cut = found.iter().rev().find(|&&y| {
        let above = median(image, &columns, y.saturating_sub(BAND), y - CLEAR.min(y));
        let below = median(image, &columns, (y + CLEAR).min(height), (y + BAND).min(height));
        difference(above, below) >= STEP
    })?;

    let points = (*cut as f64) / scale;
    (points >= MIN_CUT).then_some(points)
}

/// Evenly spaced columns, clear of the rounded corners and the window's border.
fn sample_columns(width: u32) -> Vec<u32> {
    let first = (width as f64 * 0.02) as u32;
    let span = width - first * 2;
    (0..COLUMNS).map(|i| first + span * i / COLUMNS).collect()
}

/// How far apart two colours are, summed over the channels. Alpha is ignored:
/// a window's own image is opaque, and where it is not there is nothing to see.
fn difference(a: [u8; 4], b: [u8; 4]) -> i32 {
    (0..3).map(|i| (a[i] as i32 - b[i] as i32).abs()).sum()
}

/// The median colour of a horizontal band.
///
/// Median rather than mean because a toolbar is a flat surface with things
/// scattered on it, and the mean is a blend of the surface and the things
/// while the median is the surface.
fn median(image: &RgbaImage, columns: &[u32], top: u32, bottom: u32) -> [u8; 4] {
    let mut channels: [Vec<u8>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for y in (top..bottom).step_by(2) {
        for &x in columns.iter().step_by(4) {
            let pixel = image.get_pixel(x, y).0;
            for (channel, values) in channels.iter_mut().enumerate() {
                values.push(pixel[channel]);
            }
        }
    }

    let mut out = [0u8, 0, 0, 255];
    for (channel, values) in channels.iter_mut().enumerate() {
        if values.is_empty() {
            return [0, 0, 0, 255];
        }
        values.sort_unstable();
        out[channel] = values[values.len() / 2];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    /// A window: a stack of coloured strips, then a body of another colour.
    /// `strips` are (height in pixels, colour); the rest is the body.
    fn window(width: u32, height: u32, strips: &[(u32, [u8; 3])], body: [u8; 3]) -> RgbaImage {
        let mut image = RgbaImage::from_pixel(width, height, Rgba([body[0], body[1], body[2], 255]));
        let mut y = 0;
        for &(depth, colour) in strips {
            for row in y..(y + depth).min(height) {
                for x in 0..width {
                    image.put_pixel(x, row, Rgba([colour[0], colour[1], colour[2], 255]));
                }
            }
            y += depth;
        }
        image
    }

    /// Chrome's shape: a tab strip, a toolbar, then the page. At 2x, so the
    /// answer comes back in points.
    #[test]
    fn cuts_below_the_last_strip() {
        let image = window(1600, 2000, &[(80, [60, 60, 62]), (94, [40, 40, 42])], [255, 255, 255]);
        assert_eq!(content_top(&image, 2.0), Some(87.0));
    }

    /// The reason the colour has to change across the boundary. Gridlines and
    /// rows of text cross the whole window too, and leave the same colour on
    /// both sides; taking the last full-width *change* would land on one.
    #[test]
    fn ignores_lines_drawn_on_the_contents() {
        let mut image =
            window(1600, 2000, &[(80, [60, 60, 62]), (94, [40, 40, 42])], [255, 255, 255]);
        for line in [400, 500, 600] {
            for x in 0..1600 {
                image.put_pixel(x, line, Rgba([200, 200, 200, 255]));
            }
        }
        assert_eq!(content_top(&image, 2.0), Some(87.0));
    }

    #[test]
    fn leaves_a_window_with_no_chrome_alone() {
        let image = window(1600, 2000, &[], [255, 255, 255]);
        assert_eq!(content_top(&image, 2.0), None);
    }

    #[test]
    fn refuses_a_cut_too_small_to_be_worth_it() {
        let image = window(1600, 2000, &[(20, [60, 60, 62])], [255, 255, 255]);
        assert_eq!(content_top(&image, 2.0), None);
    }

    /// A browser over a site with a header of its own.
    ///
    /// Colours and heights read off a real 2048x1068 Chrome window: tab strip,
    /// toolbar, the toolbar's white lower edge ending at 87pt, then the site's
    /// own full-width header band ending at 141.5pt, then the page. Every one
    /// of those is a step, and taking the last of them cut the site's header
    /// off — the bug this ceiling exists for. 87pt is the answer, and is where
    /// Snagit lands on the same window.
    #[test]
    fn stops_at_the_browser_and_not_inside_the_page() {
        let image = window(
            1600,
            2000,
            &[
                (80, [244, 243, 242]),
                (80, [239, 237, 237]),
                (14, [255, 255, 255]),
                (109, [11, 37, 96]),
            ],
            [252, 252, 252],
        );
        assert_eq!(content_top(&image, 2.0), Some(87.0));
    }

    /// Past 30% of the window it is not furniture any more, whatever it looks
    /// like — the same guard `ax::content_top` applies to its own arithmetic.
    #[test]
    fn refuses_a_cut_that_would_take_most_of_the_window() {
        let image = window(1600, 2000, &[(700, [60, 60, 62])], [255, 255, 255]);
        assert_eq!(content_top(&image, 2.0), None);
    }

    /// A strip that stops short of the window's width is something drawn on a
    /// surface, not the end of one.
    #[test]
    fn ignores_a_boundary_that_does_not_span_the_window() {
        let mut image = window(1600, 2000, &[(80, [60, 60, 62])], [255, 255, 255]);
        for y in 80..300 {
            for x in 0..600 {
                image.put_pixel(x, y, Rgba([10, 10, 10, 255]));
            }
        }
        assert_eq!(content_top(&image, 2.0), Some(40.0));
    }
}
