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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use image::RgbaImage;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::capture::{cli, display, Frame, Rect};

pub const LABEL: &str = "scroll";

/// How often the region is photographed. `screencapture` takes 100–250ms per
/// shot, so this is a target rather than a promise.
const INTERVAL_MS: u64 = 350;

/// The stitched page may not grow beyond this many device pixels tall. At a
/// sane capture width that is tens of full screens — a limit met on purpose.
const MAX_HEIGHT: u32 = 40_000;

/// The floating panel's size, in points.
const HUD_WIDTH: f64 = 260.0;
const HUD_HEIGHT: f64 = 348.0;

#[derive(Default)]
pub struct ScrollState {
    /// The display the overlay covers, for mapping page coords to the screen.
    bounds: Mutex<Option<(Rect, f64)>>,
    /// Set to ask a running session to stop; the bool is "deliver the result".
    session: Mutex<Option<SessionHandle>>,
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

/// How badly frame and tail disagree at one offset: the mean of per-row
/// distances over their overlap, counting only rows that actually moved since
/// the previous frame. `None` when too few moving rows overlap to judge.
fn offset_cost(tail: &[Sig], frame: &[Sig], moving: &[bool], o: i64) -> Option<f32> {
    let h = frame.len();
    // Frame row y overlaps tail row y + o.
    let y0 = (-o).max(0) as usize;
    let y1 = (h as i64 - o.max(0)).max(0) as usize;
    if y1 <= y0 {
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
        total += row_distance(&frame[y], &tail[(y as i64 + o) as usize]);
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
    range: impl Iterator<Item = i64>,
    threshold: Option<f32>,
) -> Option<i64> {
    let mut best: Option<f32> = None;
    let mut costs: Vec<(i64, f32)> = Vec::new();
    for o in range {
        let Some(cost) = offset_cost(tail, frame, moving, o) else { continue };
        costs.push((o, cost));
        if best.is_none_or(|b| cost < b) {
            best = Some(cost);
        }
    }

    let best = best?;
    if threshold.is_some_and(|t| best > t) {
        return None;
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
fn find_offset(tail: &[Sig], frame: &[Sig], moving: &[bool]) -> Option<i64> {
    let h = frame.len();
    let limit = (h - min_evidence(h)) as i64;

    const POOL: usize = 4;
    let coarse_h = h / POOL;
    if coarse_h < 16 {
        // Too small a frame to be worth two passes.
        return search_offsets(tail, frame, moving, -limit..=limit, Some(MATCH_THRESHOLD));
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
        -coarse_limit..=coarse_limit,
        None,
    );

    if let Some(coarse) = coarse {
        // The coarse answer is within one pool of the truth; search around it.
        let centre = coarse * POOL as i64;
        let from = (centre - (POOL as i64 + 2)).max(-limit);
        let to = (centre + POOL as i64 + 2).min(limit);
        if let Some(offset) =
            search_offsets(tail, frame, moving, from..=to, Some(MATCH_THRESHOLD))
        {
            return Some(offset);
        }
    }

    // The pyramid found nothing believable. On content with no vertical
    // coherence — photographic grain, dithering — pooling genuinely destroys
    // the signal, so pay full price for the honest answer. Rare, and only as
    // slow as the naive search always was.
    search_offsets(tail, frame, moving, -limit..=limit, Some(MATCH_THRESHOLD))
}

/// What one new frame did to the canvas.
#[derive(Debug, PartialEq)]
pub enum Push {
    /// `rows` new rows were appended.
    Appended { rows: u32 },
    /// The content had not moved (or had moved back up); nothing to add.
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
        self.prev_sigs = frame_sigs.clone();

        // Nothing moved at all: the user is reading, not scrolling.
        if moved < min_evidence(h) / 2 {
            return Push::Unchanged;
        }

        // The canvas tail the frame is matched against: its last `h` rows.
        let tail_start = self.sigs.len() - h;
        let tail = &self.sigs[tail_start..];

        let Some(offset) = find_offset(tail, &frame_sigs, &moving) else {
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

    pub fn into_image(self) -> Option<RgbaImage> {
        RgbaImage::from_raw(self.width, self.height, self.canvas)
    }

    /// A thumbnail of the whole page so far, as a PNG data URL for the HUD.
    pub fn preview(&self, width: u32) -> Option<String> {
        let img = RgbaImage::from_raw(self.width, self.height, self.canvas.clone())?;
        let height = ((self.height as f64 / self.width as f64) * width as f64).round() as u32;
        let small = image::imageops::resize(
            &img,
            width,
            height.max(1),
            image::imageops::FilterType::Triangle,
        );
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
    /// Set when the last frame could not be matched.
    stalled: bool,
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
    *app.state::<ScrollState>().bounds.lock().unwrap() = Some((target.bounds, target.scale));

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

    let _ = window.set_focus();
    Ok(())
}

/// The overlay's place on screen, so the page can map a drag to global points.
#[tauri::command]
pub fn scroll_layout(app: AppHandle) -> Result<Rect, String> {
    let state = app.state::<ScrollState>();
    let bounds = state.bounds.lock().unwrap();
    bounds.map(|(rect, _)| rect).ok_or_else(|| "no scroll session".into())
}

/// The region is chosen: turn the overlay into the HUD and start capturing.
#[tauri::command]
pub fn scroll_start(app: AppHandle, region: Rect) -> Result<(), String> {
    if region.width < 60.0 || region.height < 60.0 {
        return Err("drag out a larger area".into());
    }

    let state = app.state::<ScrollState>();
    let (display_bounds, scale) =
        (*state.bounds.lock().unwrap()).ok_or("no scroll session")?;

    {
        let session = state.session.lock().unwrap();
        if session.is_some() {
            return Err("a scrolling capture is already running".into());
        }
    }

    let window = app.get_webview_window(LABEL).ok_or("the overlay is gone")?;

    // The same window becomes the HUD: out of the way of the region, near it.
    let hud = hud_position(&region, &display_bounds);
    window
        .set_position(tauri::LogicalPosition::new(hud.0, hud.1))
        .and_then(|_| window.set_size(tauri::LogicalSize::new(HUD_WIDTH, HUD_HEIGHT)))
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
        run_session(&handle, region, scale, &stop, &deliver);

        let state = handle.state::<ScrollState>();
        *state.session.lock().unwrap() = None;
        if let Some(window) = handle.get_webview_window(LABEL) {
            let _ = window.close();
        }
    });

    Ok(())
}

/// Where the HUD goes: past the region's right edge, else its left, else
/// inside its top-right corner. Never below or above, where page content the
/// user is about to scroll would sit behind it.
fn hud_position(region: &Rect, display: &Rect) -> (f64, f64) {
    const GAP: f64 = 12.0;
    let y = region.y.max(display.y + GAP);

    let right = region.x + region.width + GAP;
    if right + HUD_WIDTH <= display.x + display.width - GAP {
        return (right, y);
    }
    let left = region.x - GAP - HUD_WIDTH;
    if left >= display.x + GAP {
        return (left, y);
    }
    (region.x + region.width - HUD_WIDTH - GAP, y + GAP)
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
        // Cancelled before any region was chosen: just take the overlay down.
        drop(session);
        close(&app);
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

/// One capture of the region, straight to pixels.
fn shoot(region: &Rect) -> Result<RgbaImage, String> {
    let path = std::env::temp_dir().join("shotly").join(format!(
        "scrollframe-{}.png",
        std::process::id()
    ));
    let spec = format!("{},{},{},{}", region.x, region.y, region.width, region.height);
    let path_str = path.to_string_lossy().into_owned();

    let output = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-o", "-t", "png", "-R", &spec, &path_str])
        .output()
        .map_err(|e| format!("could not spawn screencapture: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let img = image::open(&path).map_err(|e| e.to_string())?.into_rgba8();
    let _ = std::fs::remove_file(&path);
    Ok(img)
}

fn run_session(
    app: &AppHandle,
    region: Rect,
    scale: f64,
    stop: &AtomicBool,
    deliver: &AtomicBool,
) {
    let mut stitcher: Option<Stitcher> = None;
    let mut frames = 0u32;
    let mut stalled = false;

    while !stop.load(Ordering::Relaxed) {
        let started = std::time::Instant::now();

        match shoot(&region) {
            Err(err) => eprintln!("[shotly] scroll frame failed: {err}"),
            Ok(img) => {
                frames += 1;
                let mut changed = frames == 1;
                match stitcher.as_mut() {
                    None => stitcher = Some(Stitcher::new(img)),
                    Some(s) => match s.push(img) {
                        Push::Appended { .. } => {
                            changed = true;
                            stalled = false;
                        }
                        Push::Unchanged => stalled = false,
                        Push::NoMatch => stalled = true,
                    },
                }

                if let Some(s) = &stitcher {
                    let (_, height) = s.size();
                    let progress = Progress {
                        frames,
                        height,
                        preview: changed.then(|| s.preview(148)).flatten(),
                        stalled,
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

    let Some(stitched) = stitcher.and_then(Stitcher::into_image) else {
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
        assert_eq!(st.push(window(&page, 0, 400)), Push::Unchanged);
        assert_eq!(st.size().1, 400);
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
    #[test]
    fn keeps_up_at_retina_size_in_debug() {
        let page = page(2400, 6000);
        let h = 1600; // an 800pt-tall selection on a 2x display
        let mut st = Stitcher::new(window(&page, 0, h));

        let started = std::time::Instant::now();
        let mut top = 0;
        for step in [400u32, 37, 1200, 250] {
            top += step;
            assert_eq!(st.push(window(&page, top, h)), Push::Appended { rows: step });
        }
        let per_frame = started.elapsed() / 4;

        assert!(
            per_frame < std::time::Duration::from_millis(300),
            "matching took {per_frame:?} per frame — too slow for the capture loop"
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
