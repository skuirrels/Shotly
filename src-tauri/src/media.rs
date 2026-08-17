//! Serving a recording to the player without touching the main thread.
//!
//! Tauri's `asset:` protocol is a *synchronous* URI-scheme handler: it opens
//! the file and reads it on whichever thread WebKit calls it from, which on
//! macOS is the main thread. That is fine for a 40 KB thumbnail and wrong for a
//! movie — every seek is another blocking read on the thread that draws the
//! interface, and a file a cloud provider has to fetch first freezes the app
//! outright. Five hang reports in two days were made of exactly that; see
//! `docs/DEVELOPING.md`.
//!
//! So recordings get a scheme of their own, registered with
//! `register_asynchronous_uri_scheme_protocol`, whose handler is free to answer
//! later — from a worker thread — while the main thread carries on.
//!
//! It serves one directory: the capture folder. Nothing else is reachable
//! through it, which is also why the `asset:` scope could shrink back to the
//! scratch directory when this arrived.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use tauri::http::{Request, Response, StatusCode};

/// The URL scheme. `media://localhost/<percent-encoded path>` on macOS.
pub const SCHEME: &str = "media";

/// The most bytes handed back in one response.
///
/// A range request is a promise to send exactly what was asked for, but a media
/// engine asking for "the rest of the file" from byte zero is not asking for
/// 300 MB in one buffer — it is asking to start playing. Answering a megabyte
/// at a time keeps memory flat and costs nothing: WebKit simply asks for the
/// next range, which is the same conversation it has with any HTTP server.
const CHUNK: u64 = 1024 * 1024;

/// A file that fits in one chunk is answered whole, in a single 200.
///
/// The rule is deliberately "one chunk or a range", with no third case: a
/// poster frame comes back in one response, and anything bigger — which in this
/// folder means every recording — is ranged from the first request onwards.
const WHOLE_FILE_LIMIT: u64 = CHUNK;

/// Hand the request to a worker and answer when it is done.
///
/// Nothing here may block: this runs on the main thread, and returning promptly
/// is the entire point of the module.
pub fn serve_async(
    root: PathBuf,
    request: Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    tauri::async_runtime::spawn_blocking(move || responder.respond(serve(&root, &request)));
}

/// Everything above the thread boundary, so it can be tested without one.
pub fn serve(root: &Path, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    // `convertFileSrc` builds `media://localhost/<encodeURIComponent(path)>`,
    // which encodes the separators too — so the path component arrives as one
    // escaped blob behind the authority's slash. Decoding first and then
    // re-establishing a single leading slash handles that and the literal form
    // equally, and cannot turn an absolute path into a relative one by
    // stripping every slash it starts with.
    let decoded = percent_decode(request.uri().path());
    let path = format!("/{}", decoded.trim_start_matches('/'));
    let Some(file_path) = resolve(root, &path) else {
        return reply(StatusCode::FORBIDDEN, Vec::new(), None, None);
    };

    let Ok(meta) = std::fs::metadata(&file_path) else {
        return reply(StatusCode::NOT_FOUND, Vec::new(), None, None);
    };

    // A recording whose bytes a cloud provider has evicted is refused rather
    // than fetched. Reading it here would not freeze the interface — that is
    // what this module is for — but it would still download hundreds of
    // megabytes because a video element asked for four bytes of header, with no
    // progress and no way to cancel. The player checks the same flag before it
    // ever gets here and offers QuickTime instead; this is the backstop.
    if crate::commands::is_dataless(&meta) {
        return reply(StatusCode::SERVICE_UNAVAILABLE, Vec::new(), None, None);
    }

    let len = meta.len();
    let mime = mime_for(&file_path);

    let requested = request
        .headers()
        .get("range")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| parse_range(value, len));

    match requested {
        None if len <= WHOLE_FILE_LIMIT => match std::fs::read(&file_path) {
            Ok(bytes) => reply(StatusCode::OK, bytes, Some(mime), None),
            Err(_) => reply(StatusCode::NOT_FOUND, Vec::new(), None, None),
        },
        // No range header on something large: answer as if it had asked for the
        // whole file from zero, which is what a media engine means by it. The
        // 206 tells it that ranges work, and it takes over from there.
        None => read_range(&file_path, 0, len, len, mime),
        Some(None) => reply(StatusCode::RANGE_NOT_SATISFIABLE, Vec::new(), None, Some(format!("bytes */{len}"))),
        Some(Some((start, end))) => read_range(&file_path, start, end + 1, len, mime),
    }
}

/// Read `[start, end)` — clamped to `CHUNK` — and answer 206.
fn read_range(path: &Path, start: u64, end: u64, len: u64, mime: &'static str) -> Response<Vec<u8>> {
    let last = end.min(start.saturating_add(CHUNK)).max(start + 1) - 1;
    let last = last.min(len.saturating_sub(1));
    let count = last + 1 - start;

    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return reply(StatusCode::NOT_FOUND, Vec::new(), None, None),
    };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return reply(StatusCode::RANGE_NOT_SATISFIABLE, Vec::new(), None, Some(format!("bytes */{len}")));
    }

    let mut buffer = Vec::with_capacity(count as usize);
    if file.take(count).read_to_end(&mut buffer).is_err() {
        return reply(StatusCode::NOT_FOUND, Vec::new(), None, None);
    }

    let last = start + buffer.len() as u64 - 1;
    reply(
        StatusCode::PARTIAL_CONTENT,
        buffer,
        Some(mime),
        Some(format!("bytes {start}-{last}/{len}")),
    )
}

fn reply(
    status: StatusCode,
    body: Vec<u8>,
    mime: Option<&'static str>,
    content_range: Option<String>,
) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", body.len().to_string());
    if let Some(mime) = mime {
        builder = builder.header("Content-Type", mime);
    }
    if let Some(range) = content_range {
        builder = builder.header("Content-Range", range);
    }
    builder.body(body).expect("a response with valid headers")
}

/// `Some(Some((start, end)))` inclusive, `Some(None)` for a range off the end.
///
/// Only the single-range forms a media engine actually sends: `bytes=0-`,
/// `bytes=500-999`, and the suffix form `bytes=-500`. A multi-range request
/// would need a multipart body, and no video element has ever sent one.
fn parse_range(header: &str, len: u64) -> Option<Option<(u64, u64)>> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (from, to) = spec.split_once('-')?;
    let (from, to) = (from.trim(), to.trim());

    // Suffix: the last N bytes.
    if from.is_empty() {
        let n: u64 = to.parse().ok()?;
        if n == 0 || len == 0 {
            return Some(None);
        }
        let start = len.saturating_sub(n);
        return Some(Some((start, len - 1)));
    }

    let start: u64 = from.parse().ok()?;
    if start >= len {
        return Some(None);
    }
    let end = if to.is_empty() {
        len - 1
    } else {
        to.parse::<u64>().ok()?.min(len - 1)
    };
    if end < start {
        return Some(None);
    }
    Some(Some((start, end)))
}

/// The requested path, if it is a real file inside `root`.
///
/// `canonicalize` on both sides is what makes the containment check mean
/// anything: it resolves `..` and follows symlinks, so neither a crafted path
/// nor a symlink planted in the capture folder can point out of it. It reads
/// directory entries only — never file contents — so a cloud placeholder is not
/// disturbed by being resolved.
fn resolve(root: &Path, path: &str) -> Option<PathBuf> {
    let root = root.canonicalize().ok()?;
    let candidate = PathBuf::from(path).canonicalize().ok()?;
    (candidate.starts_with(&root) && candidate.is_file()).then_some(candidate)
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("mov") => "video/quicktime",
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        _ => "application/octet-stream",
    }
}

/// `%20` and friends, without pulling in a crate for it.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(uri: &str, range: Option<&str>) -> Request<Vec<u8>> {
        let mut builder = Request::builder().uri(uri);
        if let Some(range) = range {
            builder = builder.header("range", range);
        }
        builder.body(Vec::new()).expect("a request")
    }

    /// A folder with one 3 MB movie in it, named with a space so the
    /// percent-decoding is exercised by every test rather than only one.
    fn fixture() -> (tempfile::TempDir, Vec<u8>) {
        let dir = tempfile::tempdir().expect("temp dir");
        let bytes: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(dir.path().join("a recording.mov"), &bytes).expect("write");
        (dir, bytes)
    }

    /// The URL the frontend actually builds: `encodeURIComponent` of the whole
    /// path, separators included, behind the authority's slash. Tested in that
    /// shape on purpose — the first version of this module trimmed the leading
    /// slashes off a literal path and turned it relative, which every one of
    /// these tests caught and no amount of reading it did.
    fn uri_for_path(path: &Path) -> String {
        let encoded: String = path
            .to_string_lossy()
            .bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    (b as char).to_string()
                }
                other => format!("%{other:02X}"),
            })
            .collect();
        format!("media://localhost/{encoded}")
    }

    fn uri_for(dir: &tempfile::TempDir) -> String {
        uri_for_path(&dir.path().join("a recording.mov"))
    }

    /// The first request a video element makes carries no range, and the reply
    /// has to say two things at once: here is the start, and ranges work.
    #[test]
    fn a_rangeless_request_for_a_large_file_starts_it_playing() {
        let (dir, bytes) = fixture();
        let response = serve(dir.path(), &request(&uri_for(&dir), None));

        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()["content-range"], "bytes 0-1048575/3000000");
        assert_eq!(response.headers()["accept-ranges"], "bytes");
        assert_eq!(response.headers()["content-type"], "video/quicktime");
        assert_eq!(response.body().len() as u64, CHUNK, "a megabyte, not the file");
        assert_eq!(response.body()[..64], bytes[..64]);
    }

    /// The bytes handed back must be the bytes asked for. Off-by-one here is
    /// silent: the movie plays, and seeking lands in the wrong place.
    #[test]
    fn a_range_is_answered_exactly() {
        let (dir, bytes) = fixture();
        let response = serve(dir.path(), &request(&uri_for(&dir), Some("bytes=1000-1099")));

        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()["content-range"], "bytes 1000-1099/3000000");
        assert_eq!(response.headers()["content-length"], "100");
        assert_eq!(response.body(), &bytes[1000..1100]);
    }

    /// "From here to the end" is the other form a seek takes. Under the cap it
    /// is answered in full; over it, the reply is short — and says where it
    /// actually stopped rather than claiming the range it was asked for.
    #[test]
    fn an_open_ended_range_is_capped_and_says_so() {
        let (dir, bytes) = fixture();

        let tail = serve(dir.path(), &request(&uri_for(&dir), Some("bytes=2500000-")));
        assert_eq!(tail.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(tail.headers()["content-range"], "bytes 2500000-2999999/3000000");
        assert_eq!(tail.body().len(), 500_000, "the rest of the file fits in a chunk");
        assert_eq!(tail.body()[..32], bytes[2_500_000..2_500_032]);

        let capped = serve(dir.path(), &request(&uri_for(&dir), Some("bytes=500000-")));
        assert_eq!(capped.body().len() as u64, CHUNK, "capped at a chunk");
        assert_eq!(
            capped.headers()["content-range"],
            format!("bytes 500000-{}/3000000", 500_000 + CHUNK - 1),
            "the reply must describe what it sent, not what was asked for",
        );
        assert_eq!(capped.body()[..32], bytes[500_000..500_032]);
    }

    /// The suffix form — the last N bytes — is how a player finds a movie's
    /// index when it sits at the end of the file.
    #[test]
    fn a_suffix_range_reads_from_the_end() {
        let (dir, bytes) = fixture();
        let response = serve(dir.path(), &request(&uri_for(&dir), Some("bytes=-500")));

        assert_eq!(response.headers()["content-range"], "bytes 2999500-2999999/3000000");
        assert_eq!(response.body(), &bytes[2_999_500..]);
    }

    #[test]
    fn a_range_past_the_end_is_not_satisfiable() {
        let (dir, _) = fixture();
        let response = serve(dir.path(), &request(&uri_for(&dir), Some("bytes=9000000-")));

        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()["content-range"], "bytes */3000000");
        assert!(response.body().is_empty());
    }

    /// A small file comes back whole, in one 200.
    #[test]
    fn a_small_file_is_answered_in_full() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("poster.png"), b"tiny").expect("write");
        let uri = uri_for_path(&dir.path().join("poster.png"));

        let response = serve(dir.path(), &request(&uri, None));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "image/png");
        assert_eq!(response.body(), b"tiny");
    }

    /// The scheme serves one directory. Anything else is a 403, including the
    /// classic way of asking — a path that climbs out with `..`.
    #[test]
    fn nothing_outside_the_capture_folder_is_reachable() {
        let (dir, _) = fixture();
        let outside = tempfile::tempdir().expect("temp dir");
        std::fs::write(outside.path().join("secret.mov"), b"private").expect("write");

        let direct = serve(dir.path(), &request(&uri_for_path(&outside.path().join("secret.mov")), None));
        assert_eq!(direct.status(), StatusCode::FORBIDDEN);

        let climbing = serve(
            dir.path(),
            &request(
                &uri_for_path(
                    &dir.path()
                        .join("..")
                        .join(outside.path().file_name().unwrap())
                        .join("secret.mov"),
                ),
                None,
            ),
        );
        assert_eq!(climbing.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn a_missing_file_is_a_404() {
        let (dir, _) = fixture();
        let uri = uri_for_path(&dir.path().join("gone.mov"));
        // Nothing to canonicalize, so this is refused before it is looked for —
        // either answer is honest, neither is a panic.
        let status = serve(dir.path(), &request(&uri, None)).status();
        assert!(status == StatusCode::NOT_FOUND || status == StatusCode::FORBIDDEN);
    }

    /// Junk in the range header falls back to serving the start rather than
    /// failing: a player that sends nonsense should still see its movie.
    #[test]
    fn an_unparseable_range_is_ignored() {
        let (dir, _) = fixture();
        for header in ["bytes=abc", "seconds=1-2", "bytes=0-1,5-6", ""] {
            let response = serve(dir.path(), &request(&uri_for(&dir), Some(header)));
            assert_eq!(
                response.status(),
                StatusCode::PARTIAL_CONTENT,
                "range header {header:?} should fall back to the start of the file",
            );
        }
    }

    #[test]
    fn percent_escapes_are_decoded() {
        assert_eq!(percent_decode("/a%20recording.mov"), "/a recording.mov");
        assert_eq!(percent_decode("plain.mov"), "plain.mov");
        // A stray `%` is data, not a crash.
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}
