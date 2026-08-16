//! Several captures laid out on one canvas.
//!
//! The common ask is small and specific: put these two screenshots side by
//! side so I can send one file. That is what this does — compose the chosen
//! captures into a single image and hand it to the editor as an ordinary
//! capture, so everything that already works on a capture works on the result.
//!
//! Composing here rather than in the editor is deliberate. The pieces arrive
//! as files, the arithmetic is a few rectangles, and the answer is a PNG; done
//! in the webview it would mean marshalling every source image through the IPC
//! bridge first. What the editor keeps is the *manual* version — an expanded
//! canvas and pasted images, for arranging by hand afterwards.

use image::{imageops, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};

use crate::capture::{cli, Frame, Rect};

/// Which way the captures are stacked.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Layout {
    /// Side by side, tops aligned.
    Row,
    /// One under the next, left edges aligned.
    Column,
    /// Squared off, filling rows left to right.
    Grid,
}

/// Space between captures and around the outside, as a fraction of the
/// smallest capture's shorter side. Proportional so a sheet of phone
/// screenshots and a sheet of 5K ones both look deliberate.
const GAP_FRACTION: f64 = 0.03;

/// Nothing may be composed beyond this, in either direction.
const MAX_EDGE: u32 = 20_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Composed {
    pub path: String,
    pub width: u32,
    pub height: u32,
    /// How many captures actually made it in.
    pub count: usize,
}

/// Lay the given captures out on one canvas and write it to the scratch dir.
///
/// Sources that cannot be read are skipped rather than fatal: one unreadable
/// file out of six should cost that one, not the sheet.
pub fn compose(paths: &[String], layout: Layout, background: &str) -> Result<Composed, String> {
    let mut images: Vec<RgbaImage> = Vec::new();
    for path in paths {
        match image::open(path) {
            Ok(img) => images.push(img.into_rgba8()),
            Err(e) => eprintln!("[shotly] combine: skipping {path}: {e}"),
        }
    }

    if images.is_empty() {
        return Err("none of those captures could be read".into());
    }
    if images.len() == 1 {
        return Err("pick at least two captures to combine".into());
    }

    let shortest = images
        .iter()
        .map(|i| i.width().min(i.height()))
        .min()
        .unwrap_or(0);
    let gap = ((shortest as f64 * GAP_FRACTION).round() as u32).clamp(8, 96);

    let places = arrange(&images, layout, gap);
    let width = places.iter().map(|p| p.x + p.w).max().unwrap_or(0) + gap;
    let height = places.iter().map(|p| p.y + p.h).max().unwrap_or(0) + gap;

    if width > MAX_EDGE || height > MAX_EDGE {
        return Err(format!(
            "that would be {width}×{height}, which is larger than Shotly will compose"
        ));
    }

    let mut canvas = RgbaImage::from_pixel(width, height, parse_colour(background));
    for (img, place) in images.iter().zip(&places) {
        imageops::overlay(&mut canvas, img, place.x as i64, place.y as i64);
    }

    // The scale of the pieces, when they agree. A sheet of Retina captures is
    // itself a Retina image and should say so; a mixed sheet has no honest
    // single answer, so it claims nothing.
    let scales: Vec<f64> = paths
        .iter()
        .map(|p| cli::scale_of_file(std::path::Path::new(p)))
        .collect();
    let scale = if scales.windows(2).all(|w| (w[0] - w[1]).abs() < 0.01) {
        scales[0]
    } else {
        1.0
    };

    let path = write(&canvas, scale)?;
    Ok(Composed { path, width, height, count: images.len() })
}

/// Where one capture sits on the sheet.
struct Place {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

fn arrange(images: &[RgbaImage], layout: Layout, gap: u32) -> Vec<Place> {
    // Columns per row. A row is one row; a column is one per row; a grid is as
    // square as the count allows, which for four is 2×2 and for five is 3+2.
    let columns = match layout {
        Layout::Row => images.len(),
        Layout::Column => 1,
        Layout::Grid => (images.len() as f64).sqrt().ceil() as usize,
    }
    .max(1);

    let mut places = Vec::with_capacity(images.len());
    let mut y = gap;
    let mut row_start = 0;

    while row_start < images.len() {
        let row = &images[row_start..(row_start + columns).min(images.len())];
        let tallest = row.iter().map(|i| i.height()).max().unwrap_or(0);

        let mut x = gap;
        for img in row {
            // Centred within the row's height, so a short capture beside a tall
            // one doesn't hang off the top edge on its own.
            places.push(Place {
                x,
                y: y + (tallest - img.height()) / 2,
                w: img.width(),
                h: img.height(),
            });
            x += img.width() + gap;
        }

        y += tallest + gap;
        row_start += columns;
    }

    places
}

/// `#RRGGBB`, `#RRGGBBAA`, or the word `transparent`.
fn parse_colour(raw: &str) -> Rgba<u8> {
    if raw.eq_ignore_ascii_case("transparent") {
        return Rgba([0, 0, 0, 0]);
    }
    let hex = raw.trim_start_matches('#');
    let byte = |i: usize| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok();

    match hex.len() {
        6 => match (byte(0), byte(1), byte(2)) {
            (Some(r), Some(g), Some(b)) => Rgba([r, g, b, 255]),
            _ => Rgba([255, 255, 255, 255]),
        },
        8 => match (byte(0), byte(1), byte(2), byte(3)) {
            (Some(r), Some(g), Some(b), Some(a)) => Rgba([r, g, b, a]),
            _ => Rgba([255, 255, 255, 255]),
        },
        // Anything unrecognised becomes white rather than an error: the colour
        // came from a picker and a bad one should not lose the composition.
        _ => Rgba([255, 255, 255, 255]),
    }
}

fn write(canvas: &RgbaImage, scale: f64) -> Result<String, String> {
    let mut png = Vec::new();
    canvas
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let png = cli::with_dpi(&png, scale);

    let dir = std::env::temp_dir().join("shotly");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!(
        "combined-{}.png",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    std::fs::write(&path, &png).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Compose the given captures and open the result in the editor.
#[tauri::command]
pub fn combine_captures(
    app: tauri::AppHandle,
    paths: Vec<String>,
    layout: Layout,
    background: String,
) -> Result<(), String> {
    let composed = compose(&paths, layout, &background)?;
    let scale = cli::scale_of_file(std::path::Path::new(&composed.path));

    crate::commands::deliver(
        &app,
        Frame {
            path: composed.path,
            bounds: Rect {
                x: 0.0,
                y: 0.0,
                width: composed.width as f64 / scale,
                height: composed.height as f64 / scale,
            },
            pixel_width: composed.width,
            pixel_height: composed.height,
            scale,
        },
    )
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(w: u32, h: u32, tone: u8) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba([tone, tone, tone, 255]))
    }

    #[test]
    fn a_row_puts_them_side_by_side() {
        let images = vec![block(100, 80, 10), block(60, 40, 20)];
        let places = arrange(&images, Layout::Row, 10);
        assert_eq!((places[0].x, places[0].y), (10, 10));
        // Second starts past the first plus the gap.
        assert_eq!(places[1].x, 120);
        // …and is centred against the taller one: (80 - 40) / 2 = 20.
        assert_eq!(places[1].y, 30);
    }

    #[test]
    fn a_column_stacks_them() {
        let images = vec![block(100, 80, 10), block(60, 40, 20)];
        let places = arrange(&images, Layout::Column, 10);
        assert_eq!((places[0].x, places[0].y), (10, 10));
        assert_eq!((places[1].x, places[1].y), (10, 100));
    }

    #[test]
    fn a_grid_of_four_is_two_by_two() {
        let images: Vec<_> = (0..4).map(|i| block(50, 50, i * 10)).collect();
        let places = arrange(&images, Layout::Grid, 10);
        assert_eq!((places[0].x, places[0].y), (10, 10));
        assert_eq!((places[1].x, places[1].y), (70, 10));
        assert_eq!((places[2].x, places[2].y), (10, 70));
        assert_eq!((places[3].x, places[3].y), (70, 70));
    }

    #[test]
    fn colours_parse_or_fall_back_to_white() {
        assert_eq!(parse_colour("#FF8000"), Rgba([255, 128, 0, 255]));
        assert_eq!(parse_colour("transparent"), Rgba([0, 0, 0, 0]));
        assert_eq!(parse_colour("nonsense"), Rgba([255, 255, 255, 255]));
        assert_eq!(parse_colour("#ZZZZZZ"), Rgba([255, 255, 255, 255]));
    }

    #[test]
    fn one_capture_is_not_a_combination() {
        let dir = std::env::temp_dir().join("shotly-combine-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("one.png");
        block(20, 20, 5).save(&p).unwrap();
        let err = compose(&[p.to_string_lossy().into_owned()], Layout::Row, "#FFFFFF")
            .unwrap_err();
        assert!(err.contains("at least two"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod composed_pixels {
    use super::*;

    /// The whole path: real files in, one PNG out, pieces where they belong.
    #[test]
    fn writes_a_sheet_with_the_pieces_in_the_right_places() {
        let dir = std::env::temp_dir().join("shotly-combine-pixels");
        std::fs::create_dir_all(&dir).unwrap();

        let red = dir.join("red.png");
        let blue = dir.join("blue.png");
        RgbaImage::from_pixel(200, 100, Rgba([255, 0, 0, 255])).save(&red).unwrap();
        RgbaImage::from_pixel(100, 200, Rgba([0, 0, 255, 255])).save(&blue).unwrap();

        let paths = vec![
            red.to_string_lossy().into_owned(),
            blue.to_string_lossy().into_owned(),
        ];
        let out = compose(&paths, Layout::Row, "#00FF00").unwrap();

        // Gap is 3% of the shortest side (100) = 3, clamped up to the floor of 8.
        let gap = 8u32;
        assert_eq!(out.count, 2);
        assert_eq!(out.width, gap + 200 + gap + 100 + gap);
        assert_eq!(out.height, gap + 200 + gap);

        let sheet = image::open(&out.path).unwrap().into_rgba8();
        assert_eq!(sheet.dimensions(), (out.width, out.height));
        // Background shows in the margin.
        assert_eq!(*sheet.get_pixel(1, 1), Rgba([0, 255, 0, 255]));
        // The short red block is centred against the tall blue one:
        // (200 - 100) / 2 = 50, so it starts at y = gap + 50.
        assert_eq!(*sheet.get_pixel(gap + 5, gap + 55), Rgba([255, 0, 0, 255]));
        assert_eq!(*sheet.get_pixel(gap + 5, gap + 5), Rgba([0, 255, 0, 255]));
        // Blue starts past red plus a gap, and runs the full height.
        assert_eq!(*sheet.get_pixel(gap + 200 + gap + 5, gap + 5), Rgba([0, 0, 255, 255]));

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&out.path);
    }
}
