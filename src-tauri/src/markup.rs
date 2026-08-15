//! Re-editable captures.
//!
//! A saved capture is an ordinary PNG: flattened, so anything that opens it —
//! Preview, Slack, a browser — shows the markup drawn into the pixels. Shotly
//! additionally tucks the *unannotated* original and the annotation list into a
//! private chunk, so reopening the same file in Shotly gives back movable
//! objects rather than baked pixels.
//!
//! Both halves are needed. The annotation list alone would be useless: the
//! visible pixels already have the markup burnt in, so re-drawing over them
//! would double every shape. Carrying the original is what makes the file
//! genuinely re-editable, and it is why an annotated capture is roughly twice
//! the size of a flat one. Export (⌘E) writes the flat PNG with none of this.

use crate::capture::cli::crc32;

const HEADER: usize = 8;
const SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

/// Payload format marker, so a future layout change can be told apart from
/// this one rather than mis-parsed.
const MAGIC: &[u8; 8] = b"SHOTLY01";

/// Our chunk type, and every letter of it is load-bearing per the PNG spec:
/// lowercase 's' = ancillary (decoders may ignore it), lowercase 'h' = private
/// (not a registered public type), uppercase 'T' = reserved, and uppercase 'L'
/// = **unsafe to copy** — an editor that rewrites the pixels must drop this
/// rather than carry an original that no longer matches the image.
const CHUNK: &[u8; 4] = b"shTL";

pub struct Markup {
    /// The unannotated PNG this capture was made from.
    pub original: Vec<u8>,
    /// Serialised editor state — annotations, crop, step counter.
    pub doc: String,
}

fn is_png(bytes: &[u8]) -> bool {
    bytes.len() >= HEADER && &bytes[..HEADER] == SIGNATURE
}

/// Add the re-editing payload to an already-flattened PNG.
///
/// Returns the input untouched if it isn't a PNG we can parse, so a failure
/// here costs the ability to re-edit rather than the save itself.
pub fn embed(flattened: &[u8], original: &[u8], doc: &str) -> Vec<u8> {
    if !is_png(flattened) {
        return flattened.to_vec();
    }

    let json = doc.as_bytes();
    let mut body = Vec::with_capacity(CHUNK.len() + MAGIC.len() + json.len() + original.len() + 8);
    body.extend_from_slice(CHUNK);
    body.extend_from_slice(MAGIC);
    body.extend_from_slice(&(json.len() as u32).to_be_bytes());
    body.extend_from_slice(json);
    body.extend_from_slice(&(original.len() as u32).to_be_bytes());
    body.extend_from_slice(original);

    // A PNG chunk length counts the payload only, not the type or the CRC.
    let payload_len = (body.len() - CHUNK.len()) as u32;

    let mut chunk = Vec::with_capacity(body.len() + 8);
    chunk.extend_from_slice(&payload_len.to_be_bytes());
    chunk.extend_from_slice(&body);
    chunk.extend_from_slice(&crc32(&body).to_be_bytes());

    let mut out = Vec::with_capacity(flattened.len() + chunk.len());
    out.extend_from_slice(&flattened[..HEADER]);

    let mut written = false;

    for (kind, start, end) in chunks(flattened) {
        // Never emit two: re-saving an already-editable file replaces.
        if kind == *CHUNK {
            continue;
        }
        // Ours must sit before IEND; anywhere after IDAT is valid.
        if !written && kind == *b"IEND" {
            out.extend_from_slice(&chunk);
            written = true;
        }
        out.extend_from_slice(&flattened[start..end]);
    }

    if written { out } else { flattened.to_vec() }
}

/// Drop the payload, leaving a plain flattened PNG.
///
/// Used on the way to the clipboard: pasting into a document should hand over
/// an ordinary image, not a copy of the original that the receiving app will
/// carry around forever without ever being able to read it.
pub fn strip(png: &[u8]) -> Vec<u8> {
    if !is_png(png) {
        return png.to_vec();
    }

    let found = chunks(png);
    if !found.iter().any(|(kind, _, _)| *kind == *CHUNK) {
        return png.to_vec();
    }

    let mut out = Vec::with_capacity(png.len());
    out.extend_from_slice(&png[..HEADER]);
    for (kind, start, end) in found {
        if kind != *CHUNK {
            out.extend_from_slice(&png[start..end]);
        }
    }
    out
}

/// Read the payload back, if this file has one.
pub fn extract(png: &[u8]) -> Option<Markup> {
    if !is_png(png) {
        return None;
    }

    for (kind, start, end) in chunks(png) {
        if kind != *CHUNK {
            continue;
        }

        // Skip length + type, stop short of the CRC.
        let body = png.get(start + 8..end.checked_sub(4)?)?;
        let rest = body.strip_prefix(MAGIC)?;

        let (json_len, rest) = take_u32(rest)?;
        let (json, rest) = take(rest, json_len)?;
        let (image_len, rest) = take_u32(rest)?;
        let (original, _) = take(rest, image_len)?;

        return Some(Markup {
            original: original.to_vec(),
            doc: String::from_utf8(json.to_vec()).ok()?,
        });
    }

    None
}

/// Walk the chunk table as `(type, start, end)`, stopping at anything malformed.
fn chunks(png: &[u8]) -> Vec<([u8; 4], usize, usize)> {
    let mut out = Vec::new();
    let mut pos = HEADER;

    while pos + 8 <= png.len() {
        let Ok(len_bytes) = png[pos..pos + 4].try_into() else { break };
        let len = u32::from_be_bytes(len_bytes) as usize;
        let Ok(kind) = png[pos + 4..pos + 8].try_into() else { break };
        let end = match pos.checked_add(12 + len) {
            Some(e) if e <= png.len() => e,
            _ => break,
        };
        out.push((kind, pos, end));
        pos = end;
    }

    out
}

fn take_u32(bytes: &[u8]) -> Option<(usize, &[u8])> {
    let (head, rest) = bytes.split_at_checked(4)?;
    Some((u32::from_be_bytes(head.try_into().ok()?) as usize, rest))
}

fn take(bytes: &[u8], len: usize) -> Option<(&[u8], &[u8])> {
    bytes.split_at_checked(len)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The smallest thing that parses as a PNG: signature, IHDR, IEND.
    fn tiny_png() -> Vec<u8> {
        let mut png = SIGNATURE.to_vec();
        for (kind, payload) in [(b"IHDR", vec![0u8; 13]), (b"IEND", vec![])] {
            let mut body = kind.to_vec();
            body.extend_from_slice(&payload);
            png.extend_from_slice(&(payload.len() as u32).to_be_bytes());
            png.extend_from_slice(&body);
            png.extend_from_slice(&crc32(&body).to_be_bytes());
        }
        png
    }

    #[test]
    fn round_trips() {
        let original = b"the original pixels".to_vec();
        let doc = r#"{"annotations":[]}"#;

        let embedded = embed(&tiny_png(), &original, doc);
        assert!(embedded.len() > tiny_png().len());

        let read = extract(&embedded).expect("payload should be readable");
        assert_eq!(read.original, original);
        assert_eq!(read.doc, doc);
    }

    #[test]
    fn a_plain_png_has_no_payload() {
        assert!(extract(&tiny_png()).is_none());
    }

    #[test]
    fn re_embedding_replaces_rather_than_stacks() {
        let once = embed(&tiny_png(), b"first", "{}");
        let twice = embed(&once, b"second", r#"{"v":2}"#);

        let read = extract(&twice).expect("payload should be readable");
        assert_eq!(read.original, b"second");
        assert_eq!(read.doc, r#"{"v":2}"#);
        // Replaced, not appended: one payload's worth of growth over the first.
        assert!(twice.len() < once.len() + once.len());
    }

    #[test]
    fn a_truncated_payload_is_declined_rather_than_panicking() {
        let mut embedded = embed(&tiny_png(), b"pixels", "{}");
        embedded.truncate(embedded.len() / 2);
        assert!(extract(&embedded).is_none());
    }

    #[test]
    fn stripping_restores_the_plain_file() {
        let plain = tiny_png();
        let embedded = embed(&plain, b"the original pixels", r#"{"annotations":[]}"#);

        assert_eq!(strip(&embedded), plain);
        assert!(extract(&strip(&embedded)).is_none());
        // A file that never had one is handed back untouched.
        assert_eq!(strip(&plain), plain);
    }

    #[test]
    fn non_png_input_passes_through() {
        let junk = b"not a png at all".to_vec();
        assert_eq!(embed(&junk, b"x", "{}"), junk);
        assert!(extract(&junk).is_none());
    }
}
