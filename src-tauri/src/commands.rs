//! The IPC surface. Every frontend capability funnels through these commands.

use crate::capture::cli::{self, ScreencaptureCli};

use crate::capture::{CaptureBackend, Frame, Rect, WindowInfo};
use crate::markup;
use crate::platform;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

pub struct AppState {
    pub backend: ScreencaptureCli,
    /// Whether we hid the editor to keep it out of the capture, and therefore
    /// owe the user a re-show if the capture is cancelled.
    pub hid_editor: Mutex<bool>,
}

/// Get Shotly's own editor window out of the shot before we freeze the screen.
///
/// Without this, the frozen backdrop — and any full-screen capture — contains
/// the Shotly window the user is capturing *from*.
fn conceal_editor(app: &AppHandle) -> bool {
    let Some(editor) = app.get_webview_window("editor") else {
        return false;
    };
    if !editor.is_visible().unwrap_or(false) {
        return false;
    }

    let _ = editor.hide();
    // Let the window server actually composite the removal. Without this the
    // capture races the hide and still catches our window mid-fade.
    std::thread::sleep(std::time::Duration::from_millis(140));
    true
}

fn reveal_editor(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut hid = state.hid_editor.lock().unwrap();
    if !*hid {
        return;
    }
    *hid = false;
    if let Some(editor) = app.get_webview_window("editor") {
        let _ = editor.show();
        let _ = editor.set_focus();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureMode {
    Region,
    Window,
    Fullscreen,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub frame: Frame,
    /// Millisecond timestamp, used as the editor document id.
    pub id: u64,
    /// Serialised annotations, when the opened file was saved by Shotly and
    /// still carries them. `frame.path` then points at the *unannotated*
    /// original, so the editor draws these over clean pixels instead of over a
    /// copy of themselves.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub markup: Option<String>,
}

type CmdResult<T> = Result<T, String>;

/// Disambiguates scratch files opened within the same millisecond.
static OPENED: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------- permissions

#[tauri::command]
pub fn capture_permission_status() -> bool {
    cli::has_permission()
}

#[tauri::command]
pub fn request_capture_permission() -> bool {
    cli::request_permission()
}

/// Relaunch Shotly.
///
/// macOS caches a process's screen-capture TCC answer at first use, so a grant
/// made while Shotly is running can never be observed by this process — no
/// amount of re-checking on focus will see it. Restarting is the only way, so
/// the permission banner offers it as a button.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
}

#[tauri::command]
pub fn open_screen_recording_settings(app: AppHandle) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            None::<&str>,
        )
        .map_err(|e| e.to_string())
}

// -------------------------------------------------------------- capture entry

/// Run an interactive capture and hand the result to the editor.
///
/// Selection is done by macOS itself (`screencapture -i`) rather than by a
/// custom overlay window. The overlay this replaced was a full-screen,
/// always-on-top, click-swallowing sheet, and any failure to paint left the
/// desktop unusable with force-quitting Shotly as the only escape. The system
/// selector cannot wedge the machine.
///
/// `screencapture -i` blocks until the user finishes, so this runs on its own
/// thread — blocking here would freeze the event loop, since the global
/// shortcut handler calls it on the main thread.
pub fn start_capture(app: &AppHandle, mode: CaptureMode) -> CmdResult<()> {
    if !cli::has_permission() {
        // Ask once; the OS only surfaces the prompt if it has never been answered.
        cli::request_permission();
        return Err("permission-denied".into());
    }

    // Keep Shotly out of its own screenshot.
    *app.state::<AppState>().hid_editor.lock().unwrap() = conceal_editor(app);

    let handle = app.clone();
    let window_mode = mode == CaptureMode::Window;

    std::thread::spawn(move || {
        // Window mode gets a red outline tracking the pointer, so it's obvious
        // which window the click will take. Purely decorative — see `highlight`
        // for why it can't interfere with the picker or the desktop.
        if window_mode {
            crate::highlight::start(&handle);
        }

        let outcome = {
            let state = handle.state::<AppState>();
            state.backend.capture_interactive(window_mode)
        };

        // Unconditional, and before anything that can fail: the outline must
        // not outlive the capture it belongs to.
        crate::highlight::stop(&handle);

        match outcome {
            Ok(Some(frame)) => {
                if let Err(err) = deliver(&handle, frame) {
                    eprintln!("[shotly] could not open the capture: {err}");
                    reveal_editor(&handle);
                }
            }
            // Escape: restore the editor exactly as the user left it.
            Ok(None) => reveal_editor(&handle),
            Err(err) => {
                reveal_editor(&handle);
                let _ = handle.emit("capture:error", err.to_string());
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn begin_capture(app: AppHandle, mode: CaptureMode) -> CmdResult<()> {
    start_capture(&app, mode)
}

/// Abandon an in-flight capture and restore the editor.
#[tauri::command]
pub fn cancel_capture(app: AppHandle) -> CmdResult<()> {
    reveal_editor(&app);
    Ok(())
}


#[tauri::command]
pub fn capture_fullscreen(app: AppHandle, display_id: Option<u32>) -> CmdResult<CaptureResult> {
    let state = app.state::<AppState>();

    if !cli::has_permission() {
        cli::request_permission();
        return Err("permission-denied".into());
    }

    // Same reasoning as region capture: don't photograph ourselves. `deliver`
    // brings the editor back up with the result.
    *state.hid_editor.lock().unwrap() = conceal_editor(&app);

    let frames = state.backend.capture_displays().map_err(|e| e.to_string())?;
    let displays = state.backend.displays().map_err(|e| e.to_string())?;

    // Match the requested display by index; fall back to the primary.
    let idx = display_id
        .and_then(|id| displays.iter().position(|d| d.id == id))
        .or_else(|| displays.iter().position(|d| d.is_primary))
        .unwrap_or(0);

    let frame = frames.get(idx).cloned().ok_or("display not found")?;
    deliver(&app, frame)
}

fn deliver(app: &AppHandle, frame: Frame) -> CmdResult<CaptureResult> {
    deliver_with(app, frame, None)
}

fn deliver_with(app: &AppHandle, frame: Frame, markup: Option<String>) -> CmdResult<CaptureResult> {
    let result = CaptureResult { frame, id: now_ms(), markup };

    let editor = app.get_webview_window("editor").ok_or("editor window missing")?;
    // We're showing the editor with the result, so the hide is settled.
    *app.state::<AppState>().hid_editor.lock().unwrap() = false;
    platform::set_accessory_mode(app, false);
    editor.show().map_err(|e| e.to_string())?;
    editor.set_focus().map_err(|e| e.to_string())?;
    app.emit_to("editor", "editor:open", result.clone()).map_err(|e| e.to_string())?;

    Ok(result)
}

// ------------------------------------------------------------------ open file

/// Load an existing image into the editor.
///
/// The file is copied into the scratch directory rather than referenced in
/// place: it keeps the editor's asset-protocol and `read_capture_bytes` scoping
/// to one directory, and means editing can never touch the user's original.
#[tauri::command]
pub fn open_image(app: AppHandle, path: String) -> CmdResult<CaptureResult> {
    let source = std::path::Path::new(&path);
    let name =
        || source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.clone());

    let scale = cli::scale_of_file(source);

    let scratch = std::env::temp_dir().join("shotly");
    std::fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
    // A counter as well as the clock: two opens inside the same millisecond
    // would otherwise land on the same scratch file, and the second would
    // overwrite the pixels the first is still editing.
    let dest = scratch.join(format!("opened-{}-{}.png", now_ms(), OPENED.fetch_add(1, AtomicOrdering::Relaxed)));

    let is_png = source
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("png"));

    // A capture Shotly saved carries the pixels it had *before* the markup was
    // drawn in. Editing must start from those: opening the flattened version
    // and replaying the annotations over it would draw every shape twice.
    let mut markup = None;

    let (width, height) = if is_png {
        let bytes = std::fs::read(source).map_err(|e| format!("could not read {}: {e}", name()))?;

        match crate::markup::extract(&bytes) {
            Some(found) => {
                std::fs::write(&dest, &found.original)
                    .map_err(|e| format!("could not read {}: {e}", name()))?;
                markup = Some(found.doc);
            }
            // Copy the bytes verbatim.
            //
            // Decoding and re-encoding cost 1.7s on a Retina capture — and 1.5s
            // of that was the PNG encoder producing the pixels we already had. A
            // copy is a few milliseconds, and it preserves the DPI tag into the
            // scratch file as a bonus, where re-encoding silently dropped it.
            None => std::fs::write(&dest, &bytes)
                .map_err(|e| format!("could not read {}: {e}", name()))?,
        }

        image::image_dimensions(&dest).map_err(|e| {
            // Don't leave an unusable copy behind in the scratch directory.
            let _ = std::fs::remove_file(&dest);
            format!("could not read {}: {e}", name())
        })?
    } else {
        // Anything else really does need transcoding — the editor's asset
        // protocol and export path both assume PNG.
        let image = image::open(source).map_err(|e| format!("could not read {}: {e}", name()))?;
        let dims = (image.width(), image.height());
        image.save(&dest).map_err(|e| e.to_string())?;
        dims
    };

    if width == 0 || height == 0 {
        let _ = std::fs::remove_file(&dest);
        return Err("that image has no pixels".into());
    }

    // An imported file has no display geometry, so it is its own coordinate
    // space; bounds are pixels divided by whatever scale the file declares.
    let frame = Frame {
        path: dest.to_string_lossy().into_owned(),
        bounds: Rect {
            x: 0.0,
            y: 0.0,
            width: width as f64 / scale,
            height: height as f64 / scale,
        },
        pixel_width: width,
        pixel_height: height,
        scale,
    };

    deliver_with(&app, frame, markup)
}

// ----------------------------------------------------------------- window list

#[tauri::command]
pub fn list_windows(app: AppHandle) -> CmdResult<Vec<WindowInfo>> {
    app.state::<AppState>().backend.list_windows().map_err(|e| e.to_string())
}

// --------------------------------------------------------------------- export

/// Hand a capture's bytes to the frontend so it can build a same-origin blob
/// URL. Loading the PNG over the asset protocol instead would taint the export
/// canvas and make `toBlob` throw.
#[tauri::command]
pub fn read_capture_bytes(path: String) -> CmdResult<Vec<u8>> {
    let requested = std::path::Path::new(&path);
    let scratch = std::env::temp_dir().join("shotly");

    // Only ever serve files we created. `canonicalize` resolves `..` and
    // symlinks, so a crafted path can't climb out of the scratch directory.
    let resolved = requested.canonicalize().map_err(|e| e.to_string())?;
    let root = scratch.canonicalize().map_err(|e| e.to_string())?;
    if !resolved.starts_with(&root) {
        return Err("refusing to read outside the capture directory".into());
    }

    std::fs::read(&resolved).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_png(path: String, bytes: Vec<u8>, scale: Option<f64>) -> CmdResult<()> {
    let bytes = match scale {
        Some(s) => cli::with_dpi(&bytes, s),
        None => bytes,
    };
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())
}

/// Write a flattened PNG that Shotly can still take apart later.
///
/// `source` is the unannotated capture in the scratch directory. It is read
/// here rather than passed in because the IPC bridge serialises byte arrays as
/// JSON numbers — shipping a few megabytes of original through it would cost
/// far more than reading the file Rust wrote in the first place.
///
/// Falls back to a plain save when the original can't be read: a capture that
/// saves without its markup is a limitation, one that fails to save is a lost
/// afternoon.
#[tauri::command]
pub fn save_editable_png(
    path: String,
    bytes: Vec<u8>,
    source: String,
    doc: String,
    scale: Option<f64>,
) -> CmdResult<()> {
    let flattened = match scale {
        Some(s) => cli::with_dpi(&bytes, s),
        None => bytes,
    };

    let out = match std::fs::read(&source) {
        Ok(original) => markup::embed(&flattened, &original, &doc),
        Err(e) => {
            eprintln!("[shotly] saving {path} without re-editable markup: {e}");
            flattened
        }
    };

    std::fs::write(&path, &out).map_err(|e| e.to_string())
}

/// The folder every capture lands in: `~/Documents/Shotly`.
pub fn library_dir(app: &AppHandle) -> CmdResult<std::path::PathBuf> {
    use tauri::Manager;
    let documents = app.path().document_dir().map_err(|e| e.to_string())?;
    Ok(documents.join("Shotly"))
}

#[tauri::command]
pub fn save_library_path(app: AppHandle) -> CmdResult<String> {
    Ok(library_dir(&app)?.to_string_lossy().into_owned())
}

/// Save straight into the capture library, no dialog.
///
/// Returns the final path, which may not match `stem` — a name already in use
/// gets a numeric suffix rather than silently overwriting an earlier capture.
///
/// `source` and `doc` carry the re-editing payload, exactly as in
/// `save_editable_png`. Both are absent for the copy taken the moment a capture
/// arrives, which has no annotations to preserve yet.
#[tauri::command]
pub fn save_to_library(
    app: AppHandle,
    bytes: Vec<u8>,
    stem: String,
    scale: Option<f64>,
    source: Option<String>,
    doc: Option<String>,
) -> CmdResult<String> {
    let bytes = match scale {
        Some(s) => cli::with_dpi(&bytes, s),
        None => bytes,
    };

    let bytes = match (source, doc) {
        (Some(source), Some(doc)) => match std::fs::read(&source) {
            Ok(original) => markup::embed(&bytes, &original, &doc),
            Err(e) => {
                eprintln!("[shotly] saving without re-editable markup: {e}");
                bytes
            }
        },
        _ => bytes,
    };
    let dir = library_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Strip anything that would break out of the directory or upset the
    // filesystem; the stem is generated, but it costs nothing to be safe.
    let safe: String = stem
        .chars()
        .map(|c| if c == '/' || c == '\\' || c == ':' { '-' } else { c })
        .collect();
    let safe = safe.trim().trim_matches('.').to_string();
    let safe = if safe.is_empty() { "Capture".to_string() } else { safe };

    let mut target = dir.join(format!("{safe}.png"));
    let mut n = 2;
    while target.exists() {
        target = dir.join(format!("{safe} ({n}).png"));
        n += 1;
    }

    std::fs::write(&target, &bytes).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------- library

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub path: String,
    pub name: String,
    /// Millisecond timestamp, for sorting newest-first.
    pub modified: u64,
    pub size: u64,
    pub width: u32,
    pub height: u32,
}

const LIBRARY_EXTENSIONS: [&str; 3] = ["png", "jpg", "jpeg"];

/// Everything in `~/Documents/Shotly`, newest first.
///
/// Only metadata — `image_dimensions` reads the header rather than decoding, so
/// this stays fast with a large library. Thumbnails are produced separately and
/// on demand by `library_thumbnail`.
#[tauri::command]
pub fn list_library(app: AppHandle) -> CmdResult<Vec<LibraryItem>> {
    let dir = library_dir(&app)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut items = Vec::new();

    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let is_image = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| LIBRARY_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
            .unwrap_or(false);
        if !is_image {
            continue;
        }

        let Ok(meta) = entry.metadata() else { continue };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        // A file that can't be read as an image shouldn't sink the whole listing.
        let (width, height) = image::image_dimensions(&path).unwrap_or((0, 0));

        items.push(LibraryItem {
            name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            path: path.to_string_lossy().into_owned(),
            modified,
            size: meta.len(),
            width,
            height,
        });
    }

    items.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(items)
}

/// Build (and cache) a thumbnail, returning its path.
///
/// Cached under the source's path hash *and* mtime, so an edited file
/// regenerates rather than serving a stale image.
#[tauri::command]
pub fn library_thumbnail(path: String, max: u32) -> CmdResult<String> {
    use std::hash::{Hash, Hasher};

    let source = std::path::Path::new(&path);
    let meta = std::fs::metadata(source).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    let key = hasher.finish();

    let cache = std::env::temp_dir().join("shotly").join("thumbs");
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;

    let dest = cache.join(format!("{key:x}-{mtime}-{max}.png"));
    if dest.exists() {
        return Ok(dest.to_string_lossy().into_owned());
    }

    let image = image::open(source).map_err(|e| e.to_string())?;
    // `thumbnail` preserves aspect ratio and is much cheaper than a full resize.
    image.thumbnail(max, max).save(&dest).map_err(|e| e.to_string())?;

    Ok(dest.to_string_lossy().into_owned())
}

/// Move captures to the Trash rather than deleting them outright, so a
/// mistaken delete stays recoverable in Finder.
///
/// Takes the whole selection in one AppleScript call: deleting one at a time
/// would leave a half-finished job behind if Finder refused partway through,
/// and would bounce the Trash sound once per file.
#[tauri::command]
pub fn trash_captures(app: AppHandle, paths: Vec<String>) -> CmdResult<()> {
    if paths.is_empty() {
        return Err("nothing selected".into());
    }

    let root = library_dir(&app)?.canonicalize().map_err(|e| e.to_string())?;
    let mut targets = Vec::with_capacity(paths.len());

    // Resolve and check *everything* before deleting *anything*.
    for path in &paths {
        let target = std::path::Path::new(path).canonicalize().map_err(|e| e.to_string())?;
        if !target.starts_with(&root) {
            return Err("refusing to delete outside the capture library".into());
        }
        targets.push(target);
    }

    let list = targets
        .iter()
        .map(|t| format!("POSIX file \"{}\"", t.to_string_lossy().replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(", ");

    let script = format!("tell application \"Finder\" to delete {{{list}}}");
    let status = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .status()
        .map_err(|e| e.to_string())?;

    if status.success() {
        Ok(())
    } else {
        Err(match targets.len() {
            1 => "could not move that file to the Trash".into(),
            n => format!("could not move those {n} files to the Trash"),
        })
    }
}

/// Reveal a saved capture in Finder.
#[tauri::command]
pub fn reveal_in_finder(path: String) -> CmdResult<()> {
    std::process::Command::new("/usr/bin/open")
        .args(["-R", &path])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// How much image data one copy may put on the pasteboard, across all items.
///
/// Generous enough that any realistic selection carries pixels, small enough
/// that a whole library can't wedge the machine.
const IMAGE_BUDGET: usize = 96 * 1024 * 1024;

/// PNG bytes for a library file, transcoding anything that isn't already PNG.
fn png_bytes(path: &std::path::Path) -> CmdResult<Vec<u8>> {
    let is_png = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("png"));
    if is_png {
        // Flat pixels only. The file keeps its re-editing payload; whatever the
        // user pastes into has no use for a second copy of the image it cannot
        // read, and the paste is half the size without it.
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        return Ok(markup::strip(&bytes));
    }

    // A JPEG on the pasteboard tagged as PNG would simply fail to paste, so
    // re-encode rather than lie about the format.
    let image = image::open(path).map_err(|e| e.to_string())?;
    let mut out = std::io::Cursor::new(Vec::new());
    image.write_to(&mut out, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

/// Put one or more saved captures on the clipboard.
///
/// Each file becomes its own pasteboard item carrying *both* the image data and
/// a file URL, which is what makes one action serve two very different pastes:
/// an app that wants pixels (Keynote, a chat box) takes the PNG, and one that
/// wants files (Finder, Mail attachments) takes the URLs. Apps that read only
/// the first item still get a usable single capture.
#[tauri::command]
pub fn copy_files_to_clipboard(app: AppHandle, paths: Vec<String>) -> CmdResult<()> {
    if paths.is_empty() {
        return Err("nothing selected".into());
    }

    // Same scoping as `trash_capture`: only ever act on the library's own files.
    let root = library_dir(&app)?.canonicalize().map_err(|e| e.to_string())?;
    let mut resolved = Vec::with_capacity(paths.len());
    for path in &paths {
        let target = std::path::Path::new(path).canonicalize().map_err(|e| e.to_string())?;
        if !target.starts_with(&root) {
            return Err("refusing to copy outside the capture library".into());
        }
        resolved.push(target);
    }

    #[cfg(target_os = "macos")]
    {
        use objc2::runtime::ProtocolObject;
        use objc2_app_kit::{
            NSPasteboard, NSPasteboardItem, NSPasteboardTypeFileURL, NSPasteboardTypePNG,
        };
        use objc2_foundation::{NSArray, NSData, NSString, NSURL};

        let mut items = Vec::with_capacity(resolved.len());
        let mut budget = IMAGE_BUDGET;

        for path in &resolved {
            let item = NSPasteboardItem::new();

            // The file URL is cheap and always worth attaching.
            // SAFETY: the pasteboard type constants are immortal statics, and
            // every object here is one we just created.
            unsafe {
                let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
                if let Some(string) = url.absoluteString() {
                    item.setString_forType(&string, NSPasteboardTypeFileURL);
                }
            }

            // Image data is not. "Select all, copy" on a large library would
            // otherwise read every capture into memory at once and hand the
            // whole lot to the window server. Past the budget the items still
            // carry their file URL, so they still paste as files.
            if budget > 0 {
                let png = png_bytes(path)?;
                budget = budget.saturating_sub(png.len());
                unsafe { item.setData_forType(&NSData::with_bytes(&png), NSPasteboardTypePNG) };
            }

            items.push(ProtocolObject::from_retained(item));
        }

        // `clearContents` must precede the write, or the pasteboard rejects it.
        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();
        if !pasteboard.writeObjects(&NSArray::from_retained_slice(&items)) {
            return Err("the clipboard rejected the selection".into());
        }
    }

    Ok(())
}

#[tauri::command]
pub fn copy_png_to_clipboard(bytes: Vec<u8>) -> CmdResult<()> {
    let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?.to_rgba8();
    let (w, h) = img.dimensions();

    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard
        .set_image(arboard::ImageData {
            width: w as usize,
            height: h as usize,
            bytes: std::borrow::Cow::Owned(img.into_raw()),
        })
        .map_err(|e| e.to_string())
}

// -------------------------------------------------------------- window control

#[tauri::command]
pub fn hide_editor(app: AppHandle, window: WebviewWindow) -> CmdResult<()> {
    window.hide().map_err(|e| e.to_string())?;
    // Drop back to the menu bar so Shotly stops occupying the Dock and Cmd-Tab.
    platform::set_accessory_mode(&app, true);
    Ok(())
}
