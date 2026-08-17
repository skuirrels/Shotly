//! What the library needs to know about a movie.
//!
//! Two questions, and neither has an answer in the image crate: how big is it,
//! and what does it look like. Both are answered without adding a dependency —
//! the size and duration by reading the file's own index, the picture by asking
//! QuickLook, which is the same thing Finder shows for the file.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::process::Command;

/// Extensions the library treats as movies.
pub const EXTENSIONS: [&str; 3] = ["mov", "mp4", "m4v"];

pub fn is_video(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VideoInfo {
    pub width: u32,
    pub height: u32,
    pub seconds: f64,
}

/// Read a QuickTime/MP4 file's dimensions and duration from its own header.
///
/// Both live in the `moov` atom: overall length in `mvhd`, and the picture size
/// in the first video track's `tkhd`. Only the atom headers are read on the way
/// there, so this costs a few seeks rather than a pass over the file — which
/// matters, because it runs once per movie every time the library is listed and
/// a screen recording is comfortably a hundred megabytes.
///
/// `None` for anything it does not understand. A movie the library cannot
/// measure should still appear in the library.
pub fn probe(path: &Path) -> Option<VideoInfo> {
    let mut file = std::fs::File::open(path).ok()?;
    let end = file.seek(SeekFrom::End(0)).ok()?;
    let moov = find_atom(&mut file, b"moov", 0, end)?;

    // `moov` is small — track tables, not samples — so from here it is easier
    // to work in memory than to keep seeking.
    file.seek(SeekFrom::Start(moov.0)).ok()?;
    let mut body = vec![0u8; moov.1.min(8 * 1024 * 1024) as usize];
    file.read_exact(&mut body).ok()?;

    let seconds = mvhd_duration(&body).unwrap_or(0.0);
    let (width, height) = tkhd_size(&body)?;

    Some(VideoInfo { width, height, seconds })
}

/// Offset and length of the *contents* of the first `want` atom in a range.
fn find_atom(
    file: &mut std::fs::File,
    want: &[u8; 4],
    from: u64,
    to: u64,
) -> Option<(u64, u64)> {
    let mut at = from;
    while at + 8 <= to {
        file.seek(SeekFrom::Start(at)).ok()?;
        let mut header = [0u8; 8];
        file.read_exact(&mut header).ok()?;

        let mut size = u32::from_be_bytes(header[0..4].try_into().ok()?) as u64;
        let kind = &header[4..8];
        let mut body = at + 8;

        match size {
            // 1 means the real, 64-bit size follows the header.
            1 => {
                let mut wide = [0u8; 8];
                file.read_exact(&mut wide).ok()?;
                size = u64::from_be_bytes(wide);
                body += 8;
            }
            // 0 means "to the end of the file", which only the last atom uses.
            0 => size = to - at,
            _ => {}
        }

        // A size that does not advance would spin here for ever; a size past
        // the end is a truncated file. Neither is worth guessing through.
        if size < 8 || at + size > to {
            return None;
        }

        if kind == want {
            return Some((body, at + size - body));
        }
        at += size;
    }
    None
}

/// Duration in seconds, from the `mvhd` inside a `moov` body.
fn mvhd_duration(moov: &[u8]) -> Option<f64> {
    let mvhd = scan(moov, b"mvhd")?;
    let version = *mvhd.first()?;

    // Version 1 widened creation, modification and duration to 64 bits; the
    // timescale between them stayed 32.
    let (timescale, duration) = if version == 1 {
        (be32(mvhd, 20)? as f64, be64(mvhd, 24)? as f64)
    } else {
        (be32(mvhd, 12)? as f64, be32(mvhd, 16)? as f64)
    };

    (timescale > 0.0).then(|| duration / timescale)
}

/// Picture size, from the first `trak`'s `tkhd`.
///
/// Taken from the track header rather than the sample description because this
/// is the size as *displayed*: a recording of a Retina screen stores twice the
/// pixels it presents, and the library is laying out pictures, not decoding
/// them.
fn tkhd_size(moov: &[u8]) -> Option<(u32, u32)> {
    let trak = scan(moov, b"trak")?;
    let tkhd = scan(trak, b"tkhd")?;
    let version = *tkhd.first()?;

    // Version, flags, two times, track id, reserved, duration, reserved,
    // layer, alternate group, volume, reserved, and a 36-byte display matrix —
    // then the size. Version 1 widens the three times to 64 bits.
    let base = if version == 1 { 88 } else { 76 };

    // 16.16 fixed point; the fraction is almost always zero and never useful.
    let width = be32(tkhd, base)? >> 16;
    let height = be32(tkhd, base + 4)? >> 16;
    (width > 0 && height > 0).then_some((width, height))
}

/// The body of the first `want` atom directly inside `body`.
fn scan<'a>(body: &'a [u8], want: &[u8; 4]) -> Option<&'a [u8]> {
    let mut at = 0usize;
    while at + 8 <= body.len() {
        let size = u32::from_be_bytes(body[at..at + 4].try_into().ok()?) as usize;
        let kind = &body[at + 4..at + 8];
        if size < 8 || at + size > body.len() {
            return None;
        }
        if kind == want {
            return body.get(at + 8..at + size);
        }
        at += size;
    }
    None
}

fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn be64(bytes: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(bytes.get(at..at + 8)?.try_into().ok()?))
}

/// Write a still of `source` into `dest`, no larger than `max` on its long edge.
///
/// QuickLook rather than a frame grabber of our own: it is the picture the user
/// already associates with the file from Finder, it costs no dependency and no
/// codec decisions, and it is one subprocess in the same spirit as the rest of
/// the capture layer. It writes `<name>.png` beside wherever it is pointed, so
/// it is pointed at a directory of its own and the result moved into place.
pub fn poster(source: &Path, dest: &Path, max: u32) -> Result<(), String> {
    let scratch = dest
        .parent()
        .ok_or("no cache directory")?
        .join(format!("ql-{}", std::process::id()));
    std::fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;

    let status = Command::new("/usr/bin/qlmanage")
        .args(["-t", "-s", &max.to_string(), "-o"])
        .arg(&scratch)
        .arg(source)
        .output()
        .map_err(|e| format!("could not run qlmanage: {e}"))?;

    let name = source.file_name().ok_or("no file name")?;
    let produced = scratch.join(format!("{}.png", name.to_string_lossy()));

    if !produced.exists() {
        let _ = std::fs::remove_dir_all(&scratch);
        let stderr = String::from_utf8_lossy(&status.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "QuickLook produced no thumbnail".into()
        } else {
            stderr
        });
    }

    let moved = std::fs::rename(&produced, dest);
    if moved.is_err() {
        std::fs::copy(&produced, dest).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_dir_all(&scratch);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `moov` body with the two headers `probe` reads, and nothing else.
    fn moov(timescale: u32, duration: u32, width: u32, height: u32) -> Vec<u8> {
        let mut mvhd = vec![0u8; 100];
        mvhd[12..16].copy_from_slice(&timescale.to_be_bytes());
        mvhd[16..20].copy_from_slice(&duration.to_be_bytes());

        // A version-0 track header: 76 bytes of everything else, then the
        // display size as two 16.16 fixed-point numbers. These offsets are the
        // whole point of the test — the first version of them was four bytes
        // out, which the synthetic file agreed with and a real movie did not.
        let mut tkhd = vec![0u8; 76];
        tkhd.extend_from_slice(&(width << 16).to_be_bytes());
        tkhd.extend_from_slice(&(height << 16).to_be_bytes());

        let mut trak = Vec::new();
        trak.extend_from_slice(&atom(b"tkhd", &tkhd));

        let mut out = Vec::new();
        out.extend_from_slice(&atom(b"mvhd", &mvhd));
        out.extend_from_slice(&atom(b"trak", &trak));
        out
    }

    fn atom(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut out = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(body);
        out
    }

    #[test]
    fn a_movie_header_gives_up_its_length_and_size() {
        let body = moov(600, 4011, 1512, 982);

        assert_eq!(tkhd_size(&body), Some((1512, 982)));
        let seconds = mvhd_duration(&body).unwrap();
        assert!((seconds - 6.685).abs() < 0.001, "{seconds}");
    }

    #[test]
    fn a_file_that_is_not_a_movie_is_simply_not_measured() {
        assert_eq!(mvhd_duration(b"not an atom in sight"), None);
        assert_eq!(tkhd_size(&[0u8; 3]), None);
        // A size field that does not advance must not spin.
        assert_eq!(scan(&atom(b"mvhd", &[0u8; 4])[..4], b"mvhd"), None);
    }

    #[test]
    fn extensions_are_matched_whatever_their_case() {
        assert!(is_video(Path::new("/x/Recording.MOV")));
        assert!(is_video(Path::new("/x/clip.mp4")));
        assert!(!is_video(Path::new("/x/shot.png")));
        assert!(!is_video(Path::new("/x/movie")));
    }
}
