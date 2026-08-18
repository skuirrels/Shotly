//! Scrolling capture: a page taller than the screen, taken in one piece.
//!
//! The user drags out a region once, then simply scrolls the content behind
//! it. Shotly photographs the region a few times a second, works out how far
//! each new frame has moved, and appends only the rows that are new. Nothing
//! synthesises scroll events — that would need the Accessibility permission
//! and a model of every app's scrolling — the user's own hand does the
//! scrolling, and the stitcher keeps up.
//!
//! The join is found by matching row signatures rather than raw pixels: each
//! row is reduced to a handful of averaged buckets, and the new frame is slid
//! along the bottom of the canvas until two strips of it line up. Signatures
//! make the search cheap and forgive the odd antialiasing flicker; taking the
//! strips from the middle of the frame keeps a sticky header or footer from
//! pinning the match at zero.
//!
//! There is a speed past which none of that can help: a scroll that carries
//! the page further than one frame can bridge leaves a gap no amount of
//! matching will close, and the only honest answer is to say so. Saying so is
//! the harder half, because the failure is normally silent — a flick that big
//! is over inside a single shutter interval, so there is no run of unmatchable
//! moving frames to notice, just a screen sitting perfectly still somewhere
//! the canvas cannot reach. That is pixel-for-pixel what a user pausing to
//! read looks like. `Stitcher::holds_tail` is what tells the two apart, and
//! without it a session photographs the screen for as long as the user's
//! patience lasts while the panel says to keep scrolling.
//!
//! # Safety model
//!
//! The selection phase is a full-screen, always-on-top window that accepts the
//! mouse — the most dangerous shape of window on macOS, and the same one
//! `annotate` documents at length. It carries the same guards, for the same
//! reasons, and they are not optional:
//!
//! * **Mouse-transparent until the page says it painted.** An unpainted
//!   overlay passes clicks straight through instead of eating the desktop.
//! * **Heartbeat.** The page pings once a second; silence means a hung or
//!   crashed renderer, and the session is torn down. A hung page cannot report
//!   that it hung, so the absence of a signal is the signal.
//! * **A hotkey owned by Rust** toggles it, so there is a way out that does not
//!   run any of this page's code.
//!
//! The heartbeat matters in the HUD phase too, and for a second reason: the
//! capture loop only stops when the page asks it to. A dead HUD would leave a
//! thread photographing the screen every 350ms with nobody left to stop it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use image::RgbaImage;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::capture::{cli, display, Frame, Rect};

pub const LABEL: &str = "scroll";

/// How often the region is photographed.
///
/// Measured rather than guessed: `screencapture` costs about 100ms for a
/// region this size and the matching costs 2ms, so this is close to as fast as
/// the shutter goes. It matters more than it looks — the fastest scroll the
/// stitcher can follow is a fraction of a frame *per interval*, so every
/// millisecond here is scroll speed the user is allowed. The first version
/// used 350ms and spent three quarters of it asleep, which is most of why it
/// lost the thread on an ordinary trackpad flick.
const INTERVAL_MS: u64 = 120;

/// The stitched page may not grow beyond this many device pixels tall. At a
/// sane capture width that is tens of full screens — a limit met on purpose.
const MAX_HEIGHT: u32 = 40_000;

/// How many fruitless frames before the user is told they have lost the thread.
///
/// Not one: a single scroll back over ground already captured is normal, and
/// crying wolf at it would train people to ignore the warning. Three in a row
/// at this interval is under half a second, so the warning still arrives while
/// the hand is on the trackpad.
const STALL_AFTER: u32 = 3;

/// The floating panel's size, in points.
const HUD_WIDTH: f64 = 260.0;
const HUD_HEIGHT: f64 = 348.0;

/// How long the page may go silent before we assume it has died.
const HEARTBEAT_GRACE: Duration = Duration::from_secs(3);
/// How long it may take to paint before we give up on it.
const READY_GRACE: Duration = Duration::from_secs(3);

#[derive(Default)]
pub struct ScrollState {
    /// The display the overlay covers, for mapping page coords to the screen.
    bounds: Mutex<Option<(Rect, f64)>>,
    /// Set to ask a running session to stop; the bool is "deliver the result".
    session: Mutex<Option<SessionHandle>>,
    /// Last heartbeat from the page.
    last_beat: Mutex<Option<Instant>>,
    /// Whether the page has said it painted.
    ///
    /// Deliberately separate from the heartbeat above. A page can be running
    /// its timer — so beating happily — while never getting a frame onto the
    /// screen, and that state leaves a dark sheet over the whole display with
    /// only the hotkey to remove it. Letting a beat stand in for "painted"
    /// would make that state look healthy for ever.
    ready: Mutex<bool>,
}

struct SessionHandle {
    stop: Arc<AtomicBool>,
    deliver: Arc<AtomicBool>,
}

// ------------------------------------------------------------------ stitching

/// Buckets per row. Enough to tell lines of a page apart; few enough that a
/// frame's signature costs almost nothing to compare at every candidate offset.
const SIG_W: usize = 48;

type Sig = [u8; SIG_W];

/// Mean absolute difference per bucket (0–255) below which two rows are the
/// same content. Antialiasing and font smoothing drift a little as content
/// re-renders mid-scroll; genuinely different rows differ by far more.
const MATCH_THRESHOLD: f32 = 6.0;

/// Offsets scoring within this of the best are ties; the smallest wins, so a
/// flat page can never invent a scroll that didn't happen.
const TIE_EPSILON: f32 = 0.75;

/// Rows this close to the same row of the *previous* frame are "still": a
/// sticky header, a fixed sidebar edge, or plain blank space. They are struck
/// off the electorate before any offset is scored — a still row matches
/// everywhere or nowhere, and either way it says nothing about the scroll.
const STILL_ROW: f32 = 1.5;

/// An offset is only believed if at least this many *moving* rows overlap to
/// judge it by. Below that, a patterned page can line up by coincidence.
fn min_evidence(h: usize) -> usize {
    (h / 16).clamp(16, 48)
}

/// How much of the frame must overlap the canvas before a match is believed.
///
/// This is the guard that was missing, and its absence is what made the
/// feature look broken. A frame sharing only its last few rows with the canvas
/// can score a near-perfect match by pure chance — real interfaces are largely
/// flat chrome, and any two thin strips of flat chrome look alike. Measured on
/// a real screenshot: with no genuine overlap at all, the best offset scored
/// 0.63 against a threshold of 6, from 57 shared rows out of 400.
///
/// Demanding a quarter of the frame costs some maximum scroll speed — the
/// largest followable jump drops from about 93% of a frame to 75% — and buys
/// back the thing that matters, which is never stitching two pieces of page
/// that were never next to each other.
fn min_overlap(h: usize) -> usize {
    (h / 4).max(64).min(h)
}

/// How much better than typical the winning offset has to score.
///
/// A second, independent guard. Where `min_overlap` asks "was there enough to
/// compare?", this asks "did comparing it actually tell us anything?" — on a
/// blank or strongly repeating region every offset scores alike, and a winner
/// drawn from a field of equals is a coin toss dressed as a measurement.
const DISTINCT_RATIO: f32 = 3.0;

fn signatures(img: &RgbaImage) -> Vec<Sig> {
    let (w, h) = img.dimensions();
    let mut sigs = Vec::with_capacity(h as usize);
    let bucket = (w as usize).max(SIG_W) / SIG_W;

    for y in 0..h {
        let mut sig = [0u8; SIG_W];
        for (b, slot) in sig.iter_mut().enumerate() {
            let x0 = b * bucket;
            let x1 = ((b + 1) * bucket).min(w as usize);
            let mut sum = 0u32;
            for x in x0..x1 {
                let p = img.get_pixel(x as u32, y);
                // Cheap luma; the comparison only needs consistency.
                sum += (p[0] as u32 + p[1] as u32 * 2 + p[2] as u32) / 4;
            }
            *slot = (sum / (x1 - x0).max(1) as u32) as u8;
        }
        sigs.push(sig);
    }
    sigs
}

fn row_distance(a: &Sig, b: &Sig) -> f32 {
    let mut total = 0u32;
    for k in 0..SIG_W {
        total += a[k].abs_diff(b[k]) as u32;
    }
    total as f32 / SIG_W as f32
}

/// Which buckets are worth listening to: the columns that changed when the
/// page moved.
type Live = [bool; SIG_W];

/// The same distance, over those columns only.
fn row_distance_on(a: &Sig, b: &Sig, live: &Live) -> f32 {
    let mut total = 0u32;
    let mut counted = 0u32;
    for k in 0..SIG_W {
        if live[k] {
            total += a[k].abs_diff(b[k]) as u32;
            counted += 1;
        }
    }
    total as f32 / counted.max(1) as f32
}

/// Which columns moved between two frames.
///
/// The mirror of `STILL_ROW`, and it matters for exactly the same reason. A
/// window has furniture down its side — a thumbnail rail, a navigation pane, a
/// toolbar — that does not scroll with the page. Those columns match perfectly
/// where the frames are aligned and disagree violently everywhere else, so
/// including them in the score punishes the one offset that is right: measured
/// on a real Preview window, the eight columns of its sidebar scored 46 at the
/// true offset while the forty columns of the page scored 3.7, and a threshold
/// of 6 duly threw the answer away. Judging the page by its furniture is how
/// "click a window" came to capture nothing at all.
fn live_columns(prev: &[Sig], now: &[Sig]) -> Option<Live> {
    let mut moved = [0.0f32; SIG_W];
    let rows = now.len().min(prev.len()).max(1);
    for (a, b) in now.iter().zip(prev) {
        for k in 0..SIG_W {
            moved[k] += a[k].abs_diff(b[k]) as f32 / rows as f32;
        }
    }
    let mut live = [false; SIG_W];
    for k in 0..SIG_W {
        live[k] = moved[k] > STILL_ROW;
    }
    // Too little of the width in motion to tell page from furniture — usually
    // because nothing moved at all. Says "ask someone else" rather than
    // answering badly; the stitcher keeps the last answer that meant anything.
    (live.iter().filter(|l| **l).count() >= SIG_W / 6).then_some(live)
}

/// How badly frame and tail disagree at one offset: the mean of per-row
/// distances over their overlap, counting only rows that actually moved since
/// the previous frame. `None` when too few moving rows overlap to judge.
fn offset_cost(tail: &[Sig], frame: &[Sig], moving: &[bool], live: &Live, o: i64) -> Option<f32> {
    let h = frame.len();
    // Frame row y overlaps tail row y + o.
    let y0 = (-o).max(0) as usize;
    let y1 = (h as i64 - o.max(0)).max(0) as usize;
    // Too little shared page to be evidence of anything. See `min_overlap`.
    if y1 <= y0 || y1 - y0 < min_overlap(h) {
        return None;
    }

    // Sampling bounds the work for tall selections; the stride is odd so it
    // cannot lock onto a repeating pattern in the page.
    const MAX_SAMPLES: usize = 384;
    let step = {
        let s = (y1 - y0).div_ceil(MAX_SAMPLES).max(1);
        if s > 1 && s % 2 == 0 { s + 1 } else { s }
    };

    let mut total = 0.0;
    let mut counted = 0usize;
    for y in (y0..y1).step_by(step) {
        if !moving[y] {
            continue;
        }
        total += row_distance_on(&frame[y], &tail[(y as i64 + o) as usize], live);
        counted += 1;
    }

    // Scale the evidence bar by how thinly the overlap was sampled, or a tall
    // page could never clear a bar written for its full row count.
    if counted < min_evidence(h).div_ceil(step) {
        return None;
    }
    Some(total / counted as f32)
}

/// Search every offset in `-limit..=limit` and return the ties-resolved best,
/// or `None` when nothing lines up. The tie rule — of all offsets that explain
/// the frame equally well, the smallest movement wins — is what stops a flat
/// or repeating page from inventing a scroll that didn't happen.
fn search_offsets(
    tail: &[Sig],
    frame: &[Sig],
    moving: &[bool],
    live: &Live,
    range: impl Iterator<Item = i64>,
    threshold: Option<f32>,
) -> Option<i64> {
    let mut best: Option<f32> = None;
    let mut costs: Vec<(i64, f32)> = Vec::new();
    for o in range {
        let Some(cost) = offset_cost(tail, frame, moving, live, o) else { continue };
        costs.push((o, cost));
        if best.is_none_or(|b| cost < b) {
            best = Some(cost);
        }
    }

    let best = best?;
    if threshold.is_some_and(|t| best > t) {
        return None;
    }

    // Did comparing actually distinguish anything? On a blank or repeating
    // region every offset scores alike; picking the smallest of a field of
    // equals is a coin toss. Needs a decent spread of candidates before the
    // median means anything, so a narrow search is exempt — the coarse pass
    // above it has already ruled on distinctiveness for those.
    if threshold.is_some() && costs.len() >= 16 {
        let mut sorted: Vec<f32> = costs.iter().map(|(_, c)| *c).collect();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let median = sorted[sorted.len() / 2];
        if median < best * DISTINCT_RATIO {
            return None;
        }
    }

    costs
        .into_iter()
        .filter(|(_, c)| *c <= best + TIE_EPSILON)
        .map(|(o, _)| o)
        .min_by_key(|o| o.abs())
}

/// Find how far the content moved, coarse-to-fine.
///
/// Trying every offset at full resolution is quadratic in the frame height,
/// which the debug builds people actually install cannot afford at Retina
/// sizes. So the rows are first pooled in groups of four and the whole range
/// searched at quarter resolution — safe *because* of the pooling: the cost
/// surface at full resolution is spiky (one row off a line of text lands on a
/// different line), but averaging rows smooths it enough that the true offset
/// cannot slip between coarse samples. The exact offset is then pinned down by
/// a full-resolution search of the few offsets around the coarse answer.
fn find_offset(tail: &[Sig], frame: &[Sig], moving: &[bool], live: &Live) -> Option<i64> {
    let h = frame.len();
    let limit = (h - min_evidence(h)) as i64;

    const POOL: usize = 4;
    let coarse_h = h / POOL;
    if coarse_h < 16 {
        // Too small a frame to be worth two passes.
        return search_offsets(tail, frame, moving, live, -limit..=limit, Some(MATCH_THRESHOLD));
    }

    let pool = |rows: &[Sig]| -> Vec<Sig> {
        (0..coarse_h)
            .map(|g| {
                let mut sig = [0u16; SIG_W];
                for row in &rows[g * POOL..(g + 1) * POOL] {
                    for k in 0..SIG_W {
                        sig[k] += row[k] as u16;
                    }
                }
                let mut out = [0u8; SIG_W];
                for k in 0..SIG_W {
                    out[k] = (sig[k] / POOL as u16) as u8;
                }
                out
            })
            .collect()
    };

    // Both pooled from row zero, so a coarse offset of `g` groups means a full
    // offset of exactly `g * POOL` rows — no remainder to correct for.
    let coarse_tail = pool(&tail[..coarse_h * POOL]);
    let coarse_frame = pool(&frame[..coarse_h * POOL]);
    // A group has moved if any row in it has.
    let coarse_moving: Vec<bool> =
        (0..coarse_h).map(|g| moving[g * POOL..(g + 1) * POOL].iter().any(|m| *m)).collect();

    // No threshold here: the coarse pass only *locates* — pooling washes out
    // enough detail that a well-matched offset can still score middling, and
    // judging it here would refuse pages the fine pass accepts easily. The
    // threshold belongs to the pass that sees full-resolution rows.
    let coarse_limit = (coarse_h - min_evidence(coarse_h)) as i64;
    let coarse = search_offsets(
        &coarse_tail,
        &coarse_frame,
        &coarse_moving,
        live,
        -coarse_limit..=coarse_limit,
        None,
    );

    if let Some(coarse) = coarse {
        // The coarse answer is within one pool of the truth; search around it.
        let centre = coarse * POOL as i64;
        let from = (centre - (POOL as i64 + 2)).max(-limit);
        let to = (centre + POOL as i64 + 2).min(limit);
        if let Some(offset) =
            search_offsets(tail, frame, moving, live, from..=to, Some(MATCH_THRESHOLD))
        {
            return Some(offset);
        }
    }

    // The pyramid found nothing believable. On content with no vertical
    // coherence — photographic grain, dithering — pooling genuinely destroys
    // the signal, so pay full price for the honest answer. Rare, and only as
    // slow as the naive search always was.
    search_offsets(tail, frame, moving, live, -limit..=limit, Some(MATCH_THRESHOLD))
}

/// What one new frame did to the canvas.
///
/// The three failures are deliberately distinct, because they mean opposite
/// things to the person scrolling. Nothing moved: they are reading, and all is
/// well. Moved but nothing new: they scrolled back over ground already
/// covered, also fine. Moved and nothing matched: the page has run away from
/// the stitcher, and only then is there something to tell them about.
#[derive(Debug, PartialEq)]
pub enum Push {
    /// `rows` new rows were appended.
    Appended { rows: u32 },
    /// Nothing on screen moved, and what is on screen is where the capture
    /// ends. The user is reading, not scrolling.
    Idle,
    /// Nothing on screen moved, and it is not the page we left off at: the
    /// content has been carried somewhere the canvas cannot reach and parked
    /// there. See `Stitcher::holds_tail`.
    Adrift,
    /// The page moved, but onto ground the canvas already holds.
    Unchanged,
    /// The frame did not line up anywhere — a popup, a page change, or a
    /// scroll bigger than a frame can bridge.
    NoMatch,
}

pub struct Stitcher {
    width: u32,
    /// Raw RGBA bytes of the growing page.
    canvas: Vec<u8>,
    height: u32,
    /// Signature of every canvas row, so a new frame can be matched against
    /// the tail no matter what the last few frames did.
    sigs: Vec<Sig>,
    /// The previous frame's signatures, for telling still rows from moving ones.
    prev_sigs: Vec<Sig>,
    /// Height of the frames being pushed; all must agree.
    frame_height: u32,
    /// The columns the page was last seen moving in — everything until a frame
    /// says otherwise. Remembered rather than recomputed per frame because the
    /// question only has an answer while the page is moving, and it has to be
    /// answered when it is still: the canvas keeps a *stitched* copy of any
    /// furniture, which stops matching the real thing the moment anything is
    /// appended, and judging a motionless screen by that is how a window
    /// capture came to report "scrolled too fast" after its first join.
    live: Live,
}

impl Stitcher {
    pub fn new(first: RgbaImage) -> Self {
        let (width, frame_height) = first.dimensions();
        let sigs = signatures(&first);
        Self {
            width,
            canvas: first.into_raw(),
            height: frame_height,
            prev_sigs: sigs.clone(),
            sigs,
            frame_height,
            live: [true; SIG_W],
        }
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// Match a frame against the canvas tail and append whatever is new.
    pub fn push(&mut self, frame: RgbaImage) -> Push {
        let (w, h) = frame.dimensions();
        if w != self.width || h != self.frame_height || self.height >= MAX_HEIGHT {
            return Push::NoMatch;
        }
        let h = h as usize;
        let frame_sigs = signatures(&frame);

        // Which rows moved since the last frame. The still ones — sticky
        // chrome, blank space — are disqualified from voting on the offset.
        let moving: Vec<bool> = frame_sigs
            .iter()
            .zip(&self.prev_sigs)
            .map(|(a, b)| row_distance(a, b) > STILL_ROW)
            .collect();
        let moved = moving.iter().filter(|m| **m).count();
        // Which columns of the frame the page lives in, judged the same way
        // and for the same reason as the rows — and kept, since a still frame
        // cannot answer it but still has to be judged by it.
        if let Some(live) = live_columns(&self.prev_sigs, &frame_sigs) {
            self.live = live;
        }
        self.prev_sigs = frame_sigs.clone();

        // Nothing moved between this frame and the last. That is the user
        // reading rather than scrolling — but only if what they are reading is
        // where the capture ends, so ask before assuming it.
        if moved < min_evidence(h) / 2 {
            return if self.holds_tail(&frame_sigs) { Push::Idle } else { Push::Adrift };
        }

        // The canvas tail the frame is matched against: its last `h` rows.
        let tail_start = self.sigs.len() - h;
        let tail = &self.sigs[tail_start..];

        let Some(offset) = find_offset(tail, &frame_sigs, &moving, &self.live) else {
            return Push::NoMatch;
        };

        if offset <= 0 {
            return Push::Unchanged;
        }

        // The frame's last `offset` rows are past the canvas bottom: new.
        let row_bytes = self.width as usize * 4;
        let keep = h - offset as usize;
        let raw = frame.into_raw();
        self.canvas.extend_from_slice(&raw[keep * row_bytes..]);
        self.sigs.extend_from_slice(&frame_sigs[keep..]);
        self.height += offset as u32;

        Push::Appended { rows: offset as u32 }
    }

    /// Whether what is on screen is still the bottom of the canvas.
    ///
    /// In a healthy session this is an invariant rather than a guess: after an
    /// append the canvas' last rows *are* the frame that was just pushed, and
    /// a frame that changed nothing is that same picture again. So when it
    /// fails on a motionless screen, there is only one thing it can mean — the
    /// page was carried past what the stitcher could bridge and left there.
    ///
    /// Worth stating because a still frame is otherwise indistinguishable from
    /// a pause, and that is the whole failure: a fast enough scroll moves the
    /// page in a single shutter interval, so there is no run of unmatchable
    /// *moving* frames to notice — one miss, and then a screen sitting
    /// perfectly still somewhere the capture can never reach.
    fn holds_tail(&self, frame: &[Sig]) -> bool {
        let tail = &self.sigs[self.sigs.len() - frame.len()..];
        let total: f32 =
            frame.iter().zip(tail).map(|(a, b)| row_distance_on(a, b, &self.live)).sum();
        total / frame.len() as f32 <= MATCH_THRESHOLD
    }

    pub fn into_image(self) -> Option<RgbaImage> {
        self.into_page(false)
    }

    /// The stitched page, optionally trimmed to the part that scrolled.
    ///
    /// Trimming is for a capture whose bounds nobody chose — a window, taken
    /// whole because it was clicked. A rectangle someone dragged is theirs,
    /// margins and all, and quietly cropping it would be answering a question
    /// they did not ask.
    pub fn into_page(self, trim: bool) -> Option<RgbaImage> {
        let live = trim.then(|| self.page_columns()).flatten();
        let img = RgbaImage::from_raw(self.width, self.height, self.canvas)?;
        let Some((x0, x1)) = live else { return Some(img) };
        Some(image::imageops::crop_imm(&img, x0, 0, x1 - x0, self.height).to_image())
    }

    /// The span the page itself occupies, when furniture is standing beside it.
    ///
    /// A window captured whole comes with a thumbnail rail or a navigation
    /// pane down one side, and that furniture does not scroll: every join
    /// stacks another slice of it, so the finished page wears a smear where
    /// the sidebar was. Trimming it is not a liberty — a scrolling capture is
    /// a picture of the thing that scrolled.
    ///
    /// Only whole dead edges are trimmed. Something static in the *middle* of
    /// the page is a sticky header or a floating button, and cutting a column
    /// out of the middle would be worse than the smear.
    fn page_columns(&self) -> Option<(u32, u32)> {
        if self.live.iter().all(|l| *l) {
            return None;
        }
        let first = self.live.iter().position(|l| *l)?;
        let last = self.live.iter().rposition(|l| *l)?;
        let bucket = (self.width as usize).max(SIG_W) / SIG_W;
        let x0 = (first * bucket) as u32;
        let x1 = if last == SIG_W - 1 { self.width } else { ((last + 1) * bucket) as u32 };
        // Not worth the surprise for a sliver, and never nothing.
        (x1 > x0 && x1 - x0 >= self.width / 2).then_some((x0, x1.min(self.width)))
    }

    /// The last few rows of the canvas, as a PNG data URL.
    ///
    /// This is what the user has to bring back on screen for stitching to
    /// resume, and a picture of it is worth any amount of "scroll back a
    /// little" — which was the old advice, and was wrong as often as not.
    pub fn anchor_strip(&self, width: u32) -> Option<String> {
        let rows = (self.frame_height / 6).clamp(40, 200).min(self.height);
        self.encode(self.height - rows, rows, width)
    }

    /// A thumbnail of the whole page so far, as a PNG data URL for the HUD.
    pub fn preview(&self, width: u32) -> Option<String> {
        self.encode(0, self.height, width)
    }

    /// Scale a slice of the canvas down to `width` and encode it.
    ///
    /// Samples straight out of the byte buffer rather than building an image
    /// to resize. The canvas is the whole stitched page — tens of megabytes
    /// once someone has scrolled a while — and this runs on every frame that
    /// changes anything, so copying it each time cost more than the capture
    /// and the matching put together.
    fn encode(&self, from_row: u32, rows: u32, width: u32) -> Option<String> {
        if rows == 0 || self.width == 0 {
            return None;
        }
        let width = width.min(self.width).max(1);
        let height = (((rows as f64 / self.width as f64) * width as f64).round() as u32).max(1);

        let src_stride = self.width as usize * 4;
        let mut small = RgbaImage::new(width, height);
        for ty in 0..height {
            let sy = from_row as usize + (ty as usize * rows as usize) / height as usize;
            let row = sy * src_stride;
            for tx in 0..width {
                let sx = (tx as usize * self.width as usize) / width as usize;
                let i = row + sx * 4;
                let px = self.canvas.get(i..i + 4)?;
                small.put_pixel(tx, ty, image::Rgba([px[0], px[1], px[2], px[3]]));
            }
        }

        let mut png = Vec::new();
        small
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .ok()?;
        Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&png)
        ))
    }

}

// ------------------------------------------------------------------- session

/// Progress, for the HUD to narrate.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    frames: u32,
    /// Device pixels of page captured so far.
    height: u32,
    /// Data-URL thumbnail of the stitched page. Absent when nothing changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    preview: Option<String>,
    /// Set when several frames running have contributed nothing.
    stalled: bool,
    /// While stalled: the page is sitting on ground the canvas already holds,
    /// so the way out is forward rather than back. See `Stall`.
    behind: bool,
    /// The bottom of what has been captured, as a data URL — the thing to
    /// scroll back to. Only sent while stalled, since it costs an encode.
    #[serde(skip_serializing_if = "Option::is_none")]
    anchor: Option<String>,
}

/// Open the region-selection overlay on the display under the cursor.
#[tauri::command]
pub fn scroll_begin(app: AppHandle) -> Result<(), String> {
    if !cli::has_permission() {
        cli::request_permission();
        return Err("permission-denied".into());
    }

    // The same key that opened it is the way out. This matters more than it
    // looks: the overlay is a full-screen, always-on-top window, and if its
    // page ever wedges before painting, a toggle from the hotkey or the tray
    // is what stands between the user and force-quitting Shotly.
    if app.get_webview_window(LABEL).is_some() {
        scroll_cancel(app.clone());
        return Ok(());
    }

    // Keep Shotly's own windows out of the shot.
    crate::commands::conceal_for_capture(&app);

    let displays = display::displays().map_err(|e| e.to_string())?;
    let target = crate::annotate::display_under_cursor(&displays).ok_or("no displays")?;
    {
        let state = app.state::<ScrollState>();
        *state.bounds.lock().unwrap() = Some((target.bounds, target.scale));
        // Cleared before the window exists, so a stale beat from a previous
        // session can never vouch for this one.
        *state.last_beat.lock().unwrap() = None;
        *state.ready.lock().unwrap() = false;
    }

    let bounds = target.bounds;
    let window = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("scroll.html".into()))
        .title("Shotly Scrolling Capture")
        .position(bounds.x, bounds.y)
        .inner_size(bounds.width, bounds.height)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .accept_first_mouse(true)
        .build()
        .map_err(|e| e.to_string())?;

    // Clicks fall through until the page confirms it has drawn something. An
    // overlay that never paints is then an invisible sheet the desktop can be
    // used straight through, rather than one that swallows every click.
    window.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;

    // Where the user is, not where the app happens to have been. Without this
    // a scrolling capture started from a full-screen window — which is most of
    // them, since the pages worth capturing whole are read full screen — opens
    // on the desktop Space: nothing visible, clicks going to the app behind,
    // and a WebView macOS never composites and therefore suspends. Only the
    // Space, not the window level: see `platform::show_on_every_space`.
    if let Err(err) = crate::platform::show_on_every_space(&window) {
        eprintln!("[shotly] the scrolling-capture overlay may open on another Space: {err}");
    }

    let _ = window.set_focus();
    watch(&app);
    Ok(())
}

/// The page has painted: hand it the mouse, and start expecting heartbeats.
#[tauri::command]
pub fn scroll_ready(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window(LABEL).ok_or("the overlay is not open")?;
    {
        let state = app.state::<ScrollState>();
        *state.last_beat.lock().unwrap() = Some(Instant::now());
        *state.ready.lock().unwrap() = true;
    }
    window.set_ignore_cursor_events(false).map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
pub fn scroll_beat(app: AppHandle) {
    *app.state::<ScrollState>().last_beat.lock().unwrap() = Some(Instant::now());
}

/// Tear the session down if the page stops answering.
///
/// Covers both phases. In the selection phase a dead page is a full-screen
/// click target; in the HUD phase it is a capture loop nobody can stop. The
/// same silence means the same thing in both, so one watcher answers for both.
fn watch(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let opened = Instant::now();

        loop {
            std::thread::sleep(Duration::from_millis(500));

            // Finished or cancelled the ordinary way; nothing left to guard.
            if handle.get_webview_window(LABEL).is_none() {
                return;
            }

            let (ready, beat) = {
                let state = handle.state::<ScrollState>();
                let ready = *state.ready.lock().unwrap();
                let beat = *state.last_beat.lock().unwrap();
                (ready, beat)
            };

            let dead = if ready {
                // Painted once: from here on, silence is the only symptom.
                beat.is_none_or(|last| last.elapsed() > HEARTBEAT_GRACE)
            } else {
                // Never got a frame up, however chatty it may have been.
                opened.elapsed() > READY_GRACE
            };

            if dead {
                eprintln!("[shotly] scrolling capture stopped responding; closing it");
                // Cancel rather than finish: a page that has stopped answering
                // cannot be asked whether the stitched page was any good, and
                // filing something nobody approved is the worse guess.
                scroll_cancel(handle.clone());
                return;
            }
        }
    });
}

/// The overlay's place on screen, so the page can map a drag to global points.
#[tauri::command]
pub fn scroll_layout(app: AppHandle) -> Result<Rect, String> {
    let state = app.state::<ScrollState>();
    let bounds = state.bounds.lock().unwrap();
    bounds.map(|(rect, _)| rect).ok_or_else(|| "no scroll session".into())
}

/// The windows the selection can snap to, in the overlay page's own coordinates.
///
/// Taken once, when the page asks. Nothing can move while the overlay is up —
/// it covers the display and takes the mouse — so this is a snapshot rather
/// than something to poll, and the hit test itself belongs in the page where it
/// costs nothing per pointer move.
#[tauri::command]
pub fn scroll_windows(app: AppHandle) -> Result<Vec<Snap>, String> {
    let state = app.state::<ScrollState>();
    let (display, _) = (*state.bounds.lock().unwrap()).ok_or("no scroll session")?;

    Ok(crate::snap::pointable_windows()
        .into_iter()
        .map(|w| Snap {
            id: w.id,
            x: w.bounds.x - display.x,
            y: w.bounds.y - display.y,
            width: w.bounds.width,
            height: w.bounds.height,
        })
        .collect())
}

/// A window the selection can snap to: its place in the overlay's coordinates,
/// and the id that lets the shutter photograph it directly. The page sends the
/// id back with the choice, which is what frees the HUD from having to find
/// screen the capture is not using.
#[derive(Serialize)]
pub struct Snap {
    id: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// The chosen window, if it is still there and still holds what was chosen.
///
/// Falls back to `None` rather than failing: a rectangle of screen is a worse
/// capture than a window — the HUD has to keep out of it, and it does not
/// survive the window moving — but it is a great deal better than nothing.
fn window_source(id: u32, region: Rect, display: Rect) -> Option<Source> {
    let w = crate::snap::pointable_windows().into_iter().find(|w| w.id == id)?;
    let (wx, wy) = (w.bounds.x, w.bounds.y);
    let crop = Rect {
        x: region.x - wx,
        y: region.y - wy,
        width: region.width,
        height: region.height,
    };
    // Only if the choice really is inside that window: a drag that wandered
    // off its edge would otherwise crop to somewhere the user never pointed.
    let inside = crop.x >= -1.0
        && crop.y >= -1.0
        && crop.x + crop.width <= w.bounds.width + 1.0
        && crop.y + crop.height <= w.bounds.height + 1.0;
    let _ = display;
    inside.then_some(Source::Window {
        id,
        crop: Rect { x: crop.x.max(0.0), y: crop.y.max(0.0), ..crop },
        window: (w.bounds.width, w.bounds.height),
    })
}

/// The region is chosen: turn the overlay into the HUD and start capturing.
#[tauri::command]
pub fn scroll_start(app: AppHandle, region: Rect, window: Option<u32>) -> Result<(), String> {
    let started = start(&app, region, window);
    if let Err(err) = &started {
        // Never in silence. The page that called this is about to close, and
        // its console goes with it — so an unreported refusal here is a
        // scrolling capture that simply does not happen, which is exactly how
        // this looked to the one person using it: pick an area, watch the
        // overlay vanish, get nothing, twice.
        let _ = app.emit("capture:error", err.clone());
    }
    started
}

fn start(app: &AppHandle, region: Rect, chosen: Option<u32>) -> Result<(), String> {
    let state = app.state::<ScrollState>();
    let (display_bounds, scale) =
        (*state.bounds.lock().unwrap()).ok_or("no scroll session")?;

    // Squared off before anything is captured with it.
    //
    // `screencapture -R` is quietly unhelpful with a rectangle it doesn't
    // like: hand it fractions and it rounds *outward*, so 400.75 wide comes
    // back 402 points wide; hand it a rectangle overhanging the display and it
    // silently clips to what fits. Neither is fatal on its own — the same
    // input gives the same output every time — but both mean the picture is
    // not the one the user dragged, so settle it here where it can be seen.
    let region = clamp_to_display(region, display_bounds);

    if region.width < 60.0 || region.height < 60.0 {
        return Err("drag out a larger area".into());
    }

    {
        let session = state.session.lock().unwrap();
        if session.is_some() {
            return Err("a scrolling capture is already running".into());
        }
    }

    let overlay = app.get_webview_window(LABEL).ok_or("the overlay is gone")?;

    // A named window is photographed by id, so the HUD is free to sit on top
    // of it; only a bare rectangle of screen needs somewhere out of shot.
    let source = match chosen.and_then(|id| window_source(id, region, display_bounds)) {
        Some(source) => source,
        None => Source::Screen(region),
    };
    let may_overlap = matches!(source, Source::Window { .. });

    // The same window becomes the HUD: out of the way of the region, near it.
    let hud = hud_position(&region, &display_bounds, may_overlap).ok_or(
        "leave a strip of screen free beside the area — the progress panel has to \
         sit somewhere that isn't being photographed",
    )?;
    overlay
        .set_position(tauri::LogicalPosition::new(hud.0, hud.1))
        .and_then(|_| overlay.set_size(tauri::LogicalSize::new(HUD_WIDTH, HUD_HEIGHT)))
        .map_err(|e| e.to_string())?;
    let _ = app.emit_to(LABEL, "scroll:phase", "hud");

    let stop = Arc::new(AtomicBool::new(false));
    let deliver = Arc::new(AtomicBool::new(false));
    *state.session.lock().unwrap() =
        Some(SessionHandle { stop: stop.clone(), deliver: deliver.clone() });

    let handle = app.clone();
    std::thread::spawn(move || {
        // Give the window a beat to move before the first shot, or the HUD
        // itself — still mid-flight across the screen — ends up in frame one.
        std::thread::sleep(std::time::Duration::from_millis(250));
        run_session(&handle, source, scale, &stop, &deliver);

        let state = handle.state::<ScrollState>();
        *state.session.lock().unwrap() = None;
        if let Some(window) = handle.get_webview_window(LABEL) {
            let _ = window.close();
        }
    });

    Ok(())
}

/// Whole points, and inside the display. See `scroll_start` for why.
fn clamp_to_display(region: Rect, display: Rect) -> Rect {
    let x0 = region.x.round().max(display.x);
    let y0 = region.y.round().max(display.y);
    let x1 = (region.x + region.width).round().min(display.x + display.width);
    let y1 = (region.y + region.height).round().min(display.y + display.height);

    Rect { x: x0, y: y0, width: (x1 - x0).max(0.0), height: (y1 - y0).max(0.0) }
}

/// Where the HUD goes: past the region's right edge, else its left, else
/// inside its top-right corner. Never below or above, where page content the
/// user is about to scroll would sit behind it.
fn hud_position(region: &Rect, display: &Rect, may_overlap: bool) -> Option<(f64, f64)> {
    const GAP: f64 = 12.0;
    let y = region.y.max(display.y + GAP).min(display.y + display.height - HUD_HEIGHT - GAP);
    let x = region.x.max(display.x + GAP).min(display.x + display.width - HUD_WIDTH - GAP);

    // Beside it, then under it, then over it — but never *on* it. The HUD is
    // an ordinary window as far as the shutter is concerned, so a HUD inside
    // the region is photographed into every single frame: baked into the
    // finished page, and worse, changing between frames where the matcher
    // reads it as page content that moved.
    let right = region.x + region.width + GAP;
    if right + HUD_WIDTH <= display.x + display.width - GAP {
        return Some((right, y));
    }
    let left = region.x - GAP - HUD_WIDTH;
    if left >= display.x + GAP {
        return Some((left, y));
    }
    let below = region.y + region.height + GAP;
    if below + HUD_HEIGHT <= display.y + display.height - GAP {
        return Some((x, below));
    }
    let above = region.y - GAP - HUD_HEIGHT;
    if above >= display.y + GAP {
        return Some((x, above));
    }

    // Nowhere beside it — a selection that takes the whole display, which is
    // most of what anyone captures this way. When the shutter is pointed at a
    // window rather than the screen, that costs nothing: the window's picture
    // comes back whole however much is sitting on top of it, so the panel goes
    // in the corner and stays out of the reading.
    may_overlap.then(|| {
        (
            display.x + display.width - HUD_WIDTH - GAP,
            display.y + display.height - HUD_HEIGHT - GAP,
        )
    })
}

/// Stop and open what was captured in the editor.
#[tauri::command]
pub fn scroll_finish(app: AppHandle) -> Result<(), String> {
    let state = app.state::<ScrollState>();
    let session = state.session.lock().unwrap();
    if let Some(s) = session.as_ref() {
        s.deliver.store(true, Ordering::Relaxed);
        s.stop.store(true, Ordering::Relaxed);
        Ok(())
    } else {
        // Finished before any region was chosen: take the overlay down and
        // put the editor back where it was.
        drop(session);
        close(&app);
        crate::commands::reveal_after_capture(&app);
        Err("nothing was captured".into())
    }
}

/// Stop and throw the session away.
#[tauri::command]
pub fn scroll_cancel(app: AppHandle) {
    let state = app.state::<ScrollState>();
    if let Some(s) = state.session.lock().unwrap().as_ref() {
        s.deliver.store(false, Ordering::Relaxed);
        s.stop.store(true, Ordering::Relaxed);
        return;
    }
    close(&app);
    crate::commands::reveal_after_capture(&app);
}

fn close(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.close();
    }
}

/// What the shutter is pointed at.
///
/// A window is worth naming separately from the rectangle it happens to
/// occupy, because `screencapture -l` photographs a window's own surface: the
/// picture comes back whole even with the HUD — or anything else — sitting on
/// top of it. That is the difference between a feature that works on a window
/// filling the screen and one that refuses, since a full-width selection
/// leaves nowhere to put a panel that must not be in shot.
///
/// It also survives the window being dragged mid-capture, which the rectangle
/// never could: the crop travels with the window rather than the screen.
enum Source {
    /// A rectangle of the display, whatever is on it.
    Screen(Rect),
    /// A window, by id, cropped to the part of it that was chosen. `window` is
    /// the window's size in points when it was picked, which is how the
    /// returned image's scale is worked out.
    Window { id: u32, crop: Rect, window: (f64, f64) },
}

/// One capture of the region, straight to pixels.
fn shoot(source: &Source) -> Result<RgbaImage, String> {
    let path = std::env::temp_dir().join("shotly").join(format!(
        "scrollframe-{}.png",
        std::process::id()
    ));
    let path_str = path.to_string_lossy().into_owned();

    let spec;
    let args: Vec<&str> = match source {
        Source::Screen(region) => {
            spec = format!("{},{},{},{}", region.x, region.y, region.width, region.height);
            vec!["-x", "-o", "-t", "png", "-R", &spec, &path_str]
        }
        Source::Window { id, .. } => {
            spec = id.to_string();
            vec!["-x", "-o", "-t", "png", "-l", &spec, &path_str]
        }
    };

    let output = std::process::Command::new("/usr/sbin/screencapture")
        .args(&args)
        .output()
        .map_err(|e| format!("could not spawn screencapture: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let img = image::open(&path).map_err(|e| e.to_string())?.into_rgba8();
    let _ = std::fs::remove_file(&path);

    let Source::Window { crop, window, .. } = source else {
        return Ok(img);
    };

    // The window arrives whole; take the part that was chosen. Its scale is
    // read from the picture rather than assumed, so a window that was dragged
    // between displays of different scales crops to the right place.
    let scale = if window.0 > 0.0 { img.width() as f64 / window.0 } else { 1.0 };
    let px = |v: f64| (v * scale).round().max(0.0) as u32;
    let (x, y) = (px(crop.x), px(crop.y));
    let w = px(crop.width).min(img.width().saturating_sub(x));
    let h = px(crop.height).min(img.height().saturating_sub(y));
    if w == 0 || h == 0 {
        return Err("the window no longer holds the area that was chosen".into());
    }
    Ok(image::imageops::crop_imm(&img, x, y, w, h).to_image())
}

/// Whether to warn that nothing is being captured, and which way to point.
///
/// Two different failures wear the same face — a screen that is not moving —
/// and they want opposite advice. A page flicked past what a frame can bridge
/// has to be brought *back* into view. A page scrolled back over ground the
/// canvas already holds has to be carried *forward*. Getting that backwards is
/// worse than saying nothing: the user does as they are told, the capture
/// stays exactly as stuck, and the panel repeats itself.
///
/// Only a frame that moved can tell the two apart, so the verdict of the last
/// moving frame is what is remembered. A motionless screen is `Idle` or
/// `Adrift` depending on where it sits, and neither says which way the page
/// went — so neither is allowed to change the advice.
#[derive(Default)]
struct Stall {
    /// Frames that have contributed nothing since the last append.
    missed: u32,
    /// The last moving frame landed on page the canvas already holds.
    behind: bool,
}

impl Stall {
    fn saw(&mut self, push: &Push) {
        match push {
            Push::Appended { .. } => {
                self.missed = 0;
                self.behind = false;
            }
            // Reading, not scrolling. Says nothing either way, so it must not
            // clear a stall the user has not fixed.
            Push::Idle => {}
            // Still, and not where the capture ends. The commonest way this
            // feature fails — one flick past what a frame can bridge — and
            // before it was counted it looked exactly like a user pausing to
            // read: the panel said "keep scrolling" for as long as they cared
            // to. It cannot say *where* the page went, so it leaves that be.
            Push::Adrift => self.missed += 1,
            // Moved, and landed on ground already captured: they have scrolled
            // back too far, and the way on is down.
            Push::Unchanged => {
                self.missed += 1;
                self.behind = true;
            }
            // Moved, and nothing lined up anywhere: the page has run away.
            Push::NoMatch => {
                self.missed += 1;
                self.behind = false;
            }
        }
    }

    fn stalled(&self) -> bool {
        self.missed >= STALL_AFTER
    }
}

fn run_session(
    app: &AppHandle,
    source: Source,
    scale: f64,
    stop: &AtomicBool,
    deliver: &AtomicBool,
) {
    let mut stitcher: Option<Stitcher> = None;
    let mut frames = 0u32;
    let mut stall = Stall::default();

    while !stop.load(Ordering::Relaxed) {
        let started = std::time::Instant::now();

        match shoot(&source) {
            Err(err) => eprintln!("[shotly] scroll frame failed: {err}"),
            Ok(img) => {
                frames += 1;
                let mut changed = frames == 1;
                match stitcher.as_mut() {
                    None => stitcher = Some(Stitcher::new(img)),
                    Some(s) => {
                        let push = s.push(img);
                        changed |= matches!(push, Push::Appended { .. });
                        stall.saw(&push);
                    }
                }

                let stalled = stall.stalled();

                if let Some(s) = &stitcher {
                    let (_, height) = s.size();
                    let progress = Progress {
                        frames,
                        height,
                        preview: changed.then(|| s.preview(148)).flatten(),
                        stalled,
                        behind: stall.behind,
                        // Where the capture ends, shown only when they need
                        // it: a picture of it is the one instruction that
                        // cannot be misread — which is more than can be said
                        // for the sentence next to it, so `behind` decides
                        // whether that sentence says back or forward.
                        anchor: stalled.then(|| s.anchor_strip(220)).flatten(),
                    };
                    let _ = app.emit_to(LABEL, "scroll:progress", &progress);
                    if height >= MAX_HEIGHT {
                        break;
                    }
                }
            }
        }

        let elapsed = started.elapsed().as_millis() as u64;
        if elapsed < INTERVAL_MS {
            std::thread::sleep(std::time::Duration::from_millis(INTERVAL_MS - elapsed));
        }
    }

    if !deliver.load(Ordering::Relaxed) {
        crate::commands::reveal_after_capture(app);
        return;
    }

    // A window was taken whole because it was clicked; a rectangle is exactly
    // what someone dragged. Only the first has furniture to trim.
    let whole_window = matches!(source, Source::Window { .. });
    let Some(stitched) = stitcher.and_then(|s| s.into_page(whole_window)) else {
        let _ = app.emit("capture:error", "nothing was captured");
        crate::commands::reveal_after_capture(app);
        return;
    };

    match save(stitched, scale) {
        Ok(frame) => {
            // The overlay window is closed by our caller; deliver brings the
            // editor forward with the stitched page in it.
            close(app);
            if let Err(err) = crate::commands::deliver(app, frame) {
                eprintln!("[shotly] could not open the stitched capture: {err}");
                crate::commands::reveal_after_capture(app);
            }
        }
        Err(err) => {
            let _ = app.emit("capture:error", err);
            crate::commands::reveal_after_capture(app);
        }
    }
}

/// Write the stitched page to the scratch directory, DPI-stamped like any
/// other capture so the editor treats it identically.
fn save(image: RgbaImage, scale: f64) -> Result<Frame, String> {
    let (pw, ph) = image.dimensions();

    let mut png = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let png = cli::with_dpi(&png, scale);

    let dir = std::env::temp_dir().join("shotly");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!(
        "scroll-{}.png",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    std::fs::write(&path, &png).map_err(|e| e.to_string())?;

    Ok(Frame {
        path: path.to_string_lossy().into_owned(),
        bounds: Rect { x: 0.0, y: 0.0, width: pw as f64 / scale, height: ph as f64 / scale },
        pixel_width: pw,
        pixel_height: ph,
        scale,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tall page shaped like real content: 14-row "text lines", coherent
    /// within a line and distinct between lines, with hashed blank lines —
    /// and, deliberately, no vertical period. A repeating pattern really does
    /// match itself at the period, and a stitcher honest about that fails any
    /// test that assumed the content was unique.
    fn page(width: u32, height: u32) -> RgbaImage {
        let hash = |v: u32| ((v as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 32) as u32;
        RgbaImage::from_fn(width, height, |x, y| {
            let line = y / 14;
            let tone = if hash(line) % 5 == 0 {
                250 // blank line
            } else {
                // "Glyphs": the pattern varies along x per line, and shades a
                // little down the line's rows the way strokes do.
                let g = 40 + ((hash(line) ^ (x / 9).wrapping_mul(2654435761)) % 150) as u8;
                g.saturating_add(((y % 14) * 3) as u8)
            };
            image::Rgba([tone, tone, tone / 2, 255])
        })
    }

    fn window(page: &RgbaImage, top: u32, height: u32) -> RgbaImage {
        image::imageops::crop_imm(page, 0, top, page.width(), height).to_image()
    }

    #[test]
    fn stitches_a_downward_scroll_exactly() {
        let page = page(320, 2000);
        let h = 400;
        let mut st = Stitcher::new(window(&page, 0, h));

        let mut top = 0;
        for step in [37u32, 120, 5, 231, 90, 260, 1, 44] {
            top += step;
            assert_eq!(st.push(window(&page, top, h)), Push::Appended { rows: step });
        }

        let (w, height) = st.size();
        assert_eq!((w, height), (320, top + h));
        let out = st.into_image().unwrap();
        // Byte-for-byte the same as simply having had a taller screen.
        assert_eq!(out.as_raw(), window(&page, 0, top + h).as_raw());
    }

    #[test]
    fn a_pause_adds_nothing() {
        let page = page(320, 1200);
        let mut st = Stitcher::new(window(&page, 0, 400));
        assert_eq!(st.push(window(&page, 0, 400)), Push::Idle);
        assert_eq!(st.size().1, 400);
    }

    #[test]
    fn the_advice_follows_the_last_frame_that_moved() {
        let mut stall = Stall::default();
        for _ in 0..STALL_AFTER {
            stall.saw(&Push::NoMatch);
        }
        assert!(stall.stalled());
        assert!(!stall.behind, "the page ran away: the way out is back");

        // A motionless screen cannot say which way the page went, and must not
        // be allowed to answer as though it could.
        stall.saw(&Push::Adrift);
        assert!(!stall.behind);

        // Moving onto ground already captured can, and does.
        stall.saw(&Push::Unchanged);
        assert!(stall.behind, "scrolled back too far: the way out is forward");
        stall.saw(&Push::Idle);
        assert!(stall.behind, "a pause must not flip the advice either");

        // And capturing again ends the whole conversation.
        stall.saw(&Push::Appended { rows: 12 });
        assert!(!stall.stalled());
        assert!(!stall.behind);
    }

    /// A window is not all page: it has furniture down the side that stays
    /// put while the content scrolls, and judging the match by that furniture
    /// is how capturing a whole window came to capture nothing.
    #[test]
    fn a_sidebar_that_never_moves_does_not_get_a_vote() {
        let h = 400;
        // The left fifth is a rail: fixed in the frame, whatever the page does.
        let rail = window(&page(64, 4000), 1200, h);
        let page = page(320, 2000);
        let framed = |top: u32| {
            let mut img = window(&page, top, h);
            image::imageops::replace(&mut img, &rail, 0, 0);
            img
        };

        let mut st = Stitcher::new(framed(0));
        let mut top = 0;
        for step in [40u32, 120, 75] {
            top += step;
            assert_eq!(
                st.push(framed(top)),
                Push::Appended { rows: step },
                "the rail outvoted the page it is standing next to"
            );
        }
        assert_eq!(st.size().1, top + h);

        // And the rail is not in the finished page: it never scrolled, so
        // every join stacked another slice of it.
        let out = st.into_page(true).unwrap();
        assert!(out.width() < 320, "the rail was left in the finished page");
        assert!(out.width() >= 320 - 64 - 320 / SIG_W as u32, "too much was trimmed");
    }

    #[test]
    fn a_page_parked_out_of_reach_is_not_a_pause() {
        let page = page(320, 3000);
        let h = 400;
        let mut st = Stitcher::new(window(&page, 0, h));

        // A flick lands somewhere the canvas cannot reach: unmatchable.
        assert_eq!(st.push(window(&page, 1500, h)), Push::NoMatch);

        // And now the hand comes off the trackpad. Every frame from here is
        // identical to the last, which is what "the user is reading" looks
        // like — but they are reading a part of the page the capture never
        // saw, and calling that healthy is what leaves the session quietly
        // photographing nothing while the panel says to keep scrolling.
        for _ in 0..5 {
            assert_eq!(st.push(window(&page, 1500, h)), Push::Adrift);
        }
        assert_eq!(st.size().1, h);
    }

    #[test]
    fn scrolling_back_up_never_duplicates() {
        let page = page(320, 2000);
        let h = 400;
        let mut st = Stitcher::new(window(&page, 0, h));
        assert_eq!(st.push(window(&page, 200, h)), Push::Appended { rows: 200 });
        // Up 150, then back down past where we were.
        assert_eq!(st.push(window(&page, 50, h)), Push::Unchanged);
        assert_eq!(st.push(window(&page, 130, h)), Push::Unchanged);
        assert_eq!(st.push(window(&page, 275, h)), Push::Appended { rows: 75 });

        let out = st.into_image().unwrap();
        assert_eq!(out.as_raw(), window(&page, 0, 275 + h).as_raw());
    }

    #[test]
    fn a_jump_too_big_to_bridge_is_refused() {
        let page = page(320, 3000);
        let h = 400;
        let mut st = Stitcher::new(window(&page, 0, h));
        // Scrolled almost a full frame: no overlap for the strips to find.
        assert_eq!(st.push(window(&page, 2200, h)), Push::NoMatch);
        assert_eq!(st.size().1, h);
    }

    #[test]
    fn unrelated_content_is_refused() {
        let page_a = page(320, 800);
        let mut noise = page(320, 800);
        for p in noise.pixels_mut() {
            p[0] = p[0].wrapping_mul(31).wrapping_add(17);
            p[1] = 255 - p[1];
        }
        let mut st = Stitcher::new(window(&page_a, 0, 400));
        assert_eq!(st.push(window(&noise, 100, 400)), Push::NoMatch);
    }

    /// The builds people install locally are debug builds, so the matcher has
    /// to keep up with the capture cadence *without* the optimiser.
    ///
    /// Timed best-of-three. The question is whether the matching *can* keep up,
    /// and a single run of it shares a machine with every other test in this
    /// file: taking the worst of those measured the test harness, not the
    /// matcher, and failed two runs in three.
    #[test]
    fn keeps_up_at_retina_size_in_debug() {
        let page = page(2400, 6000);
        let h = 1600; // an 800pt-tall selection on a 2x display

        let per_frame = (0..3)
            .map(|_| {
                let mut st = Stitcher::new(window(&page, 0, h));
                let started = std::time::Instant::now();
                let mut top = 0;
                for step in [400u32, 37, 1200, 250] {
                    top += step;
                    assert_eq!(st.push(window(&page, top, h)), Push::Appended { rows: step });
                }
                started.elapsed() / 4
            })
            .min()
            .unwrap();

        // Headroom on purpose. The number that matters is that the matcher is
        // in the hundreds of milliseconds rather than the seconds — a limit set
        // to what an idle machine manages reports on how busy the machine is,
        // which was two failures in three runs of the suite.
        assert!(
            per_frame < std::time::Duration::from_millis(450),
            "matching took {per_frame:?} per frame — too slow for the capture loop"
        );
    }

    /// The bug that made the feature look broken in the field.
    ///
    /// A scroll too fast to follow must be *reported*, not silently accepted
    /// on the strength of a few rows of flat chrome lining up by luck. The
    /// first version answered `Unchanged` here, so the panel went on counting
    /// frames and cheerfully saying "keep scrolling" while capturing nothing.
    #[test]
    fn an_unfollowable_scroll_is_never_mistaken_for_progress() {
        let page = page(320, 4000);
        let h = 400u32;

        for jump in [500u32, 700, 1200, 2000, 3000] {
            let mut st = Stitcher::new(window(&page, 0, h));
            let got = st.push(window(&page, jump, h));
            assert_eq!(got, Push::NoMatch, "a {jump}-row jump should be refused, got {got:?}");
            assert_eq!(st.size().1, h, "nothing may be appended for a {jump}-row jump");
        }
    }

    /// Losing the thread must not end the session — scrolling back into
    /// ground already covered has to pick it up again.
    #[test]
    fn recovers_when_the_user_scrolls_back() {
        let page = page(320, 3000);
        let h = 400u32;
        let mut st = Stitcher::new(window(&page, 0, h));

        assert_eq!(st.push(window(&page, 900, h)), Push::NoMatch);
        // Back into the captured region: picks up exactly where it left off.
        assert_eq!(st.push(window(&page, 250, h)), Push::Appended { rows: 250 });
        assert_eq!(st.push(window(&page, 400, h)), Push::Appended { rows: 150 });

        let out = st.into_image().unwrap();
        assert_eq!(out.as_raw(), window(&page, 0, 400 + h).as_raw());
    }

    /// Reading is not scrolling, and neither is scrolling back over old
    /// ground. Only the third case is worth interrupting someone about.
    #[test]
    fn the_three_kinds_of_nothing_are_told_apart() {
        let page = page(320, 3000);
        let h = 400u32;
        let mut st = Stitcher::new(window(&page, 0, h));

        assert_eq!(st.push(window(&page, 0, h)), Push::Idle, "still page");
        st.push(window(&page, 300, h));
        assert_eq!(st.push(window(&page, 100, h)), Push::Unchanged, "scrolled back");
        assert_eq!(st.push(window(&page, 2500, h)), Push::NoMatch, "ran away");
    }

    /// The panel is an ordinary window to the shutter, so it must never be
    /// placed where it would be photographed into every frame.
    #[test]
    fn the_hud_is_never_placed_inside_the_captured_region() {
        let display = Rect { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 };
        let overlaps = |r: &Rect, at: (f64, f64)| {
            at.0 < r.x + r.width && at.0 + HUD_WIDTH > r.x
                && at.1 < r.y + r.height && at.1 + HUD_HEIGHT > r.y
        };

        for region in [
            Rect { x: 100.0, y: 100.0, width: 700.0, height: 700.0 },   // room right
            Rect { x: 700.0, y: 60.0, width: 780.0, height: 800.0 },    // room left
            Rect { x: 40.0, y: 40.0, width: 1430.0, height: 500.0 },    // room below
            Rect { x: 40.0, y: 420.0, width: 1430.0, height: 520.0 },   // room above
        ] {
            let at = hud_position(&region, &display, false)
                .unwrap_or_else(|| panic!("no place found for {region:?}"));
            assert!(!overlaps(&region, at), "HUD at {at:?} sits inside {region:?}");
        }

        // A region taking the whole display leaves nowhere out of shot, and a
        // rectangle of screen photographs whatever is on it — so it is refused
        // rather than fudged.
        let everything = Rect { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 };
        assert_eq!(hud_position(&everything, &display, false), None);

        // Unless the shutter is pointed at a window, which comes back whole
        // whatever is sitting on top of it. Refusing that was the whole of
        // "scrolling capture does not work": clicking a window — any window
        // filling the screen — landed here and gave up in silence.
        let at = hud_position(&everything, &display, true).expect("a window can be overlapped");
        assert!(at.0 >= display.x && at.0 + HUD_WIDTH <= display.x + display.width);
        assert!(at.1 >= display.y && at.1 + HUD_HEIGHT <= display.y + display.height);
    }

    /// What the shutter is handed must be whole points inside the display, or
    /// `screencapture` quietly rounds it outward and clips it.
    #[test]
    fn the_region_is_squared_off_before_capture() {
        let display = Rect { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 };

        let fractional = Rect { x: 100.5, y: 100.25, width: 400.75, height: 300.5 };
        let r = clamp_to_display(fractional, display);
        assert_eq!((r.x, r.y, r.width, r.height), (101.0, 100.0, 400.0, 301.0));

        // Hanging off two edges: trimmed to what actually exists.
        let overhanging = Rect { x: -50.0, y: 800.0, width: 400.0, height: 400.0 };
        let r = clamp_to_display(overhanging, display);
        assert_eq!((r.x, r.y, r.width, r.height), (0.0, 800.0, 350.0, 182.0));
    }

    /// The thumbnail runs on nearly every frame, so it must not cost more
    /// than the capture it illustrates.
    #[test]
    fn the_preview_stays_cheap_on_a_tall_page() {
        let page = page(1562, 3000);
        let mut st = Stitcher::new(window(&page, 0, 1492));
        // Grow it to something like a long article.
        for top in (40..1500).step_by(40) {
            st.push(window(&page, top, 1492));
        }
        assert!(st.size().1 > 2800, "expected a tall canvas, got {}", st.size().1);

        // Best-of-three, for the reason `keeps_up_at_retina_size_in_debug`
        // gives: this asks what the preview costs, not what the machine was
        // doing at the time.
        let each = (0..3)
            .map(|_| {
                let t0 = std::time::Instant::now();
                for _ in 0..10 {
                    assert!(st.preview(148).is_some());
                }
                t0.elapsed() / 10
            })
            .min()
            .unwrap();

        assert!(
            each < std::time::Duration::from_millis(40),
            "preview took {each:?} per frame on a {}-row canvas",
            st.size().1
        );
    }

    #[test]
    fn a_sticky_header_does_not_pin_the_match() {
        let page = page(320, 2000);
        let h = 400;
        let header = 60u32;

        // Frames whose top 60 rows are always the same banner.
        let with_header = |top: u32| {
            let mut f = window(&page, top, h);
            let banner = window(&page, 0, header);
            image::imageops::overlay(&mut f, &banner, 0, 0);
            f
        };

        let mut st = Stitcher::new(with_header(0));
        // The strips sit below the banner, so the scroll is still found.
        assert_eq!(st.push(with_header(150)), Push::Appended { rows: 150 });
        assert_eq!(st.push(with_header(300)), Push::Appended { rows: 150 });
    }
}
