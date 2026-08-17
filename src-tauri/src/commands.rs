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
    conceal_editor_inner(app)
}

/// The same hide, for capture flows that live outside this module.
pub fn conceal_for_capture(app: &AppHandle) {
    *app.state::<AppState>().hid_editor.lock().unwrap() = conceal_editor_inner(app);
}

/// Undo `conceal_for_capture` after a cancelled or failed capture.
pub fn reveal_after_capture(app: &AppHandle) {
    reveal_editor(app);
}

fn conceal_editor_inner(app: &AppHandle) -> bool {
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

/// The Keyboard Shortcuts pane, where macOS's own screenshot keys are turned
/// off — the one thing that has to happen elsewhere before ⌘⇧4 can be recorded
/// as a Shotly hotkey.
#[tauri::command]
pub fn open_keyboard_settings(app: AppHandle) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(
            "x-apple.systempreferences:com.apple.preference.keyboard?Shortcuts",
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
    // Window capture is answered in one place so that the hotkey, the tray and
    // the editor's own toolbar button cannot drift apart — which they had.
    //
    // It draws Shotly's own outline, which needs no permission this capture
    // does not already need. If it cannot start at all, the system's own window
    // picker is the fallback rather than an error: the camera cursor that
    // lights up whatever is under the pointer. What used to be here instead was
    // the thumbnail grid, which was the wrong answer twice over — it takes a
    // picture of every open window before it can show you anything, and
    // choosing from a contact sheet is not what anyone means by pointing at a
    // window.
    if mode == CaptureMode::Window {
        match crate::snap::begin(app) {
            Err(err) if err != "permission-denied" => {
                eprintln!("[snap] outline unavailable ({err}); using the system picker");
            }
            other => return other,
        }
    }

    if !cli::has_permission() {
        // Ask once; the OS only surfaces the prompt if it has never been answered.
        cli::request_permission();
        return Err("permission-denied".into());
    }

    // Keep Shotly out of its own screenshot.
    *app.state::<AppState>().hid_editor.lock().unwrap() = conceal_editor(app);

    let handle = app.clone();

    std::thread::spawn(move || {
        let outcome = {
            let state = handle.state::<AppState>();
            state.backend.capture_interactive(mode == CaptureMode::Window)
        };

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

/// Ask the editor to put up the window picker.
///
/// Window capture no longer goes through `screencapture -i -w`. Choosing by
/// sight beats choosing by pointer here: the pointer can only reach what is in
/// front, and — as the removed outline proved — cannot even reliably tell you
/// what that is. See `window_thumbnail`.
pub fn request_window_pick(app: &AppHandle) -> CmdResult<()> {
    if !cli::has_permission() {
        cli::request_permission();
        return Err("permission-denied".into());
    }

    let editor = app.get_webview_window("editor").ok_or("editor window missing")?;
    *app.state::<AppState>().hid_editor.lock().unwrap() = false;
    platform::set_accessory_mode(app, false);
    editor.show().map_err(|e| e.to_string())?;
    editor.set_focus().map_err(|e| e.to_string())?;
    app.emit_to("editor", "editor:pick-window", ()).map_err(|e| e.to_string())
}

/// Bring the editor forward with Settings open on one of its tabs.
///
/// The way in from the menu bar, which is where someone whose hotkey has been
/// stolen by another app has to start: the editor window may well be hidden,
/// and its own ⌘, cannot be reached from a window you cannot see.
pub fn request_settings(app: &AppHandle, tab: &str) -> CmdResult<()> {
    present_editor(app)?;
    app.emit_to("editor", "editor:settings", tab)
        .map_err(|e| e.to_string())
}

/// Bring the editor forward, whatever state it was left in.
///
/// Not `reveal_editor`, which only undoes a hide *we* did: this is for the
/// times something has happened that the user has to be told about, and the
/// window that does the telling has spent the whole operation hidden. A
/// finished screen recording is the example — it is filed silently, in a folder
/// the library grid does not show movies from, so without this the entire
/// feature is indistinguishable from one that does nothing at all.
pub fn present_editor(app: &AppHandle) -> CmdResult<()> {
    let editor = app.get_webview_window("editor").ok_or("editor window missing")?;
    *app.state::<AppState>().hid_editor.lock().unwrap() = false;
    platform::set_accessory_mode(app, false);
    editor.show().map_err(|e| e.to_string())?;
    editor.set_focus().map_err(|e| e.to_string())
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

pub(crate) fn deliver(app: &AppHandle, frame: Frame) -> CmdResult<CaptureResult> {
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
///
/// Async for the same reason as `list_library`: this reads a whole PNG, and the
/// file it reads is one of the user's own captures — which may be a placeholder
/// a file provider has to fetch first. Read on the main thread, that is a
/// frozen app for as long as the download takes. See `is_dataless`.
#[tauri::command]
pub async fn open_image(app: AppHandle, path: String) -> CmdResult<CaptureResult> {
    let scale = cli::scale_of_file(std::path::Path::new(&path));
    let (frame, markup) = tauri::async_runtime::spawn_blocking(move || load_image(&path, scale))
        .await
        .map_err(|e| format!("opening that image failed: {e}"))??;

    // Handing it to the editor is the other half, and it is AppKit work —
    // changing the activation policy and showing a window — so it goes back to
    // the main thread rather than running on whichever worker did the reading.
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(deliver_with(&handle, frame, markup));
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

/// Copy an image into the scratch directory and describe it. Never on the main
/// thread — see the caller.
fn load_image(path: &str, scale: f64) -> CmdResult<(Frame, Option<String>)> {
    let source = std::path::Path::new(path);
    let name =
        || source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string());

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

    Ok((frame, markup))
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
pub async fn read_capture_bytes(path: String) -> CmdResult<Vec<u8>> {
    tauri::async_runtime::spawn_blocking(move || capture_bytes(&path))
        .await
        .map_err(|e| format!("reading the capture failed: {e}"))?
}

/// Off the main thread, always: see `is_dataless`.
fn capture_bytes(path: &str) -> CmdResult<Vec<u8>> {
    let requested = std::path::Path::new(path);
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
    app: AppHandle,
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

    std::fs::write(&path, &out).map_err(|e| e.to_string())?;

    // Re-saving an existing capture never touches `write_into_library`, so
    // without this a backup would hold the version from the first save for
    // ever — quietly, which is the worst way for a backup to be wrong.
    crate::backup::mirror_one(&app, &path);
    Ok(())
}

/// Whether this file's contents live somewhere other than this disk.
///
/// macOS marks a file whose bytes a file provider — iCloud Drive, Dropbox,
/// Google Drive — has evicted with `SF_DATALESS`. `stat` still answers, so the
/// name, size and date are free; **reading a single byte blocks until the
/// provider has fetched the whole file**, which for a screen recording is a
/// download of hundreds of megabytes.
///
/// Five hang reports in two days all had the same shape: the main thread, in a
/// WebKit URL-scheme callback, stopped in `apfs_materialize_dataless_file_ext`.
/// Anything that opens a library file has to either be off the main thread or
/// ask this first — and listing a folder should never trigger a download at
/// all, which is what the caller in `read_library` uses this for.
#[cfg(target_os = "macos")]
pub fn is_dataless(meta: &std::fs::Metadata) -> bool {
    use std::os::macos::fs::MetadataExt;
    /// `sys/stat.h`: "file is dataless object".
    const SF_DATALESS: u32 = 0x4000_0000;
    meta.st_flags() & SF_DATALESS != 0
}

#[cfg(not(target_os = "macos"))]
pub fn is_dataless(_meta: &std::fs::Metadata) -> bool {
    false
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
    write_into_library(&app, &bytes, &stem)
}

/// Write bytes into the library under `stem`, without overwriting anything.
///
/// Shared with the annotation layer, which saves the screen it was drawn over
/// on its way out. Kept here because the naming rules — what a stem may
/// contain, and how a collision is resolved — are the library's business.
pub fn write_into_library(app: &AppHandle, bytes: &[u8], stem: &str) -> CmdResult<String> {
    let target = free_name(app, stem, "png")?;
    std::fs::write(&target, bytes).map_err(|e| e.to_string())?;

    let path = target.to_string_lossy().into_owned();
    crate::backup::mirror_one(app, &path);
    Ok(path)
}

/// Move a finished file into the library under `stem`, without overwriting
/// anything. For things too big to have been held in memory on the way here —
/// a screen recording is the only one so far.
pub fn move_into_library(
    app: &AppHandle,
    source: &std::path::Path,
    stem: &str,
    extension: &str,
) -> CmdResult<String> {
    let target = free_name(app, stem, extension)?;
    place_file(source, &target)?;

    let path = target.to_string_lossy().into_owned();
    crate::backup::mirror_one(app, &path);
    Ok(path)
}

/// A path in the library for `stem`.`extension` that nothing is using yet.
fn free_name(app: &AppHandle, stem: &str, extension: &str) -> CmdResult<std::path::PathBuf> {
    let dir = library_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(free_name_in(&dir, stem, extension))
}

/// The naming rules themselves, against a directory rather than the app — so
/// that what a stem may contain, and how a collision is resolved, can be tested
/// without a library on disk.
fn free_name_in(dir: &std::path::Path, stem: &str, extension: &str) -> std::path::PathBuf {
    // Strip anything that would break out of the directory or upset the
    // filesystem; the stem is generated, but it costs nothing to be safe.
    let safe: String = stem
        .chars()
        .map(|c| if c == '/' || c == '\\' || c == ':' { '-' } else { c })
        .collect();
    let safe = safe.trim().trim_matches('.').to_string();
    let safe = if safe.is_empty() { "Capture".to_string() } else { safe };

    let mut target = dir.join(format!("{safe}.{extension}"));
    let mut n = 2;
    while target.exists() {
        target = dir.join(format!("{safe} ({n}).{extension}"));
        n += 1;
    }
    target
}

/// Put `source` at `target`, leaving nothing behind at `source`.
///
/// A rename is instant and a copy is not, but the scratch directory and the
/// library are only usually on the same volume — `TMPDIR` can be moved, and a
/// home directory can be on an external disk. Copy when the cheap move is
/// refused rather than losing a recording to it.
fn place_file(source: &std::path::Path, target: &std::path::Path) -> CmdResult<()> {
    if std::fs::rename(source, target).is_ok() {
        return Ok(());
    }
    std::fs::copy(source, target).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(source);
    Ok(())
}

/// The name a capture is filed under: "Recording 2026-08-17 at 11.52.03".
///
/// The same shape as `captureStem` in `src/lib/naming.ts`, which names
/// everything that arrives through the editor — macOS's own screenshot format,
/// so a library sorted by name reads chronologically. Rust needs its own copy
/// because a recording can be filed with no page left alive to ask.
pub fn stamped_stem(prefix: &str) -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as libc::time_t;

    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: `localtime_r` fills a caller-owned `tm` and touches nothing else;
    // both pointers are to live stack values. The `_r` form is the one that can
    // be called from any thread.
    unsafe {
        libc::localtime_r(&secs, &mut tm);
    }

    format!(
        "{prefix} {:04}-{:02}-{:02} at {:02}.{:02}.{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec
    )
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
    /// A screen recording rather than a capture. There is nothing to annotate
    /// in one, so the grid opens it in whatever plays movies instead.
    pub video: bool,
    /// How long it runs, for movies. Zero when it could not be measured.
    pub seconds: f64,
    /// The bytes are not on this disk — a file provider has evicted them, and
    /// touching the contents means a download. Its size and date are still
    /// honest; its dimensions and duration are not, because reading them is
    /// exactly what must not happen while listing. See `is_dataless`.
    pub cloud: bool,
}

const LIBRARY_EXTENSIONS: [&str; 3] = ["png", "jpg", "jpeg"];

/// Everything in `~/Documents/Shotly`, newest first.
///
/// Only metadata — `image_dimensions` reads the header rather than decoding, so
/// this stays fast with a large library. Thumbnails are produced separately and
/// on demand by `library_thumbnail`.
///
/// **Async, and that is load-bearing.** A synchronous command runs on the main
/// thread, and this one opens every file in the folder to read its header. One
/// cloud-evicted capture in there froze the whole app — see `is_dataless`. The
/// library is also re-read on every window focus, so this is not a rare path.
#[tauri::command]
pub async fn list_library(app: AppHandle) -> CmdResult<Vec<LibraryItem>> {
    let dir = library_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || read_library(&dir))
        .await
        .map_err(|e| format!("the library listing failed: {e}"))?
}

pub fn read_library(dir: &std::path::Path) -> CmdResult<Vec<LibraryItem>> {
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut items = Vec::new();

    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let is_image = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| LIBRARY_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
            .unwrap_or(false);
        let is_video = crate::video::is_video(&path);
        if !is_image && !is_video {
            continue;
        }

        let Ok(meta) = entry.metadata() else { continue };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        // A capture whose bytes are in the cloud is listed from its `stat`
        // alone. Every line below this one opens the file, and opening an
        // evicted file downloads it — browsing a folder must not pull a
        // gigabyte of recordings back onto the disk.
        let cloud = is_dataless(&meta);

        // Neither an unreadable image nor an unmeasurable movie should sink the
        // whole listing: both are shown, without their dimensions.
        let (width, height, seconds) = if cloud {
            (0, 0, 0.0)
        } else if is_video {
            crate::video::probe(&path)
                .map(|v| (v.width, v.height, v.seconds))
                .unwrap_or((0, 0, 0.0))
        } else {
            let (w, h) = image::image_dimensions(&path).unwrap_or((0, 0));
            (w, h, 0.0)
        };

        items.push(LibraryItem {
            name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            path: path.to_string_lossy().into_owned(),
            modified,
            size: meta.len(),
            width,
            height,
            video: is_video,
            seconds,
            cloud,
        });
    }

    items.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(items)
}

/// Build (and cache) a thumbnail, returning its path.
///
/// Cached under the source's path hash *and* mtime, so an edited file
/// regenerates rather than serving a stale image.
/// A picture of one window, small, for the picker to show.
///
/// `screencapture -l` reads the window's own backing store rather than the
/// screen, so this works for a window that is behind another, on a different
/// Space, or — as it turns out — not being composited at all. That is the
/// whole point of the picker: a window that looks like nothing you recognise
/// is one you can decline to choose, where the old red outline just pointed at
/// it and offered no way to tell.
///
/// Not cached. A window's contents change, and a picker showing what an app
/// looked like ten minutes ago would be its own kind of lie.
#[tauri::command]
pub fn window_thumbnail(app: AppHandle, window_id: u32, max: u32) -> CmdResult<String> {
    let state = app.state::<AppState>();
    let shot = state
        .backend
        .capture_window(window_id)
        .map_err(|e| e.to_string())?;

    let image = image::open(&shot.path).map_err(|e| e.to_string())?;
    let thumb = image.thumbnail(max, max);
    let _ = std::fs::remove_file(&shot.path);

    let mut png = Vec::new();
    thumb
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;

    use base64::Engine;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&png)
    ))
}

/// Capture one window by id and open it in the editor.
///
/// The counterpart to the picker. Nothing has to be hidden first and no
/// overlay goes up: `-l` photographs the window itself, so Shotly's own window
/// being in front of it is irrelevant.
#[tauri::command]
pub fn capture_window(app: AppHandle, window_id: u32) -> CmdResult<CaptureResult> {
    let frame = {
        let state = app.state::<AppState>();
        state.backend.capture_window(window_id).map_err(|e| e.to_string())?
    };
    deliver(&app, frame)
}

#[tauri::command]
pub async fn library_thumbnail(path: String, max: u32) -> CmdResult<String> {
    // `async`, and this is not decoration: a synchronous `#[tauri::command]`
    // runs on the main thread, and this one decodes images and — for a
    // recording — shells out to QuickLook, which measured 3.1 seconds the
    // first time after launch while the whole interface sat frozen. The
    // library asks for one of these per card the moment the editor opens, so
    // that was a hang on startup for anyone with a recording in their library.
    tauri::async_runtime::spawn_blocking(move || thumbnail(path, max))
        .await
        .map_err(|e| format!("the thumbnail task failed: {e}"))?
}

/// Generate a capture's thumbnail ahead of anybody asking for it.
///
/// The size matches what the library requests, or the cache key would not
/// match and the work would be done twice. See `libraryThumbnail` in ipc.ts.
pub fn warm_thumbnail(path: &str) -> CmdResult<String> {
    thumbnail(path.to_string(), 480)
}

fn thumbnail(path: String, max: u32) -> CmdResult<String> {
    use std::hash::{Hash, Hasher};

    let source = std::path::Path::new(&path);
    let meta = std::fs::metadata(source).map_err(|e| e.to_string())?;

    // Never fetch a file back from the cloud to make a picture of it. The grid
    // asks for a thumbnail per card as it scrolls, and a folder of recordings
    // would quietly become a gigabyte of downloads — the caller shows the
    // card without one instead. See `is_dataless`.
    if is_dataless(&meta) {
        return Err("that capture's contents are not on this disk".into());
    }

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

    if crate::video::is_video(source) {
        // A movie's poster frame comes from QuickLook at the size asked for,
        // so there is nothing left to resize. See `video::poster`.
        crate::video::poster(source, &dest, max)?;
        return Ok(dest.to_string_lossy().into_owned());
    }

    let image = image::open(source).map_err(|e| e.to_string())?;
    // `thumbnail` preserves aspect ratio and is much cheaper than a full resize.
    image.thumbnail(max, max).save(&dest).map_err(|e| e.to_string())?;

    Ok(dest.to_string_lossy().into_owned())
}

/// Hand a file to whatever the system opens it with.
///
/// For recordings: there is nothing to annotate in a movie, so double-clicking
/// one in the library sends it to QuickTime Player — or to whatever the user
/// has told macOS they prefer — rather than into an editor built for pictures.
#[tauri::command]
pub fn open_externally(app: AppHandle, path: String) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
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

/// Copy an image that is already on disk.
///
/// The path rather than the pixels, for the pins: they know where their image
/// came from, and sending several megabytes up to the page and straight back
/// down again only to reach the same clipboard would be wasted work.
#[tauri::command]
pub fn copy_file_image_to_clipboard(path: String) -> CmdResult<()> {
    let bytes = std::fs::read(&path).map_err(|e| format!("could not read {path}: {e}"))?;
    copy_png_to_clipboard(bytes)
}

/// Whatever image is on the clipboard, as a PNG data URL.
///
/// `Ok(None)` rather than an error when there isn't one: pressing ⌘V with text
/// on the clipboard is an ordinary thing to do, not a failure to report.
///
/// A data URL rather than a file on disk because an overlay embeds its pixels
/// in the document — see `lib/overlay.ts` for why.
#[tauri::command]
pub fn read_clipboard_image() -> CmdResult<Option<String>> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let Ok(image) = clipboard.get_image() else {
        return Ok(None);
    };

    let (width, height) = (image.width as u32, image.height as u32);
    let buffer = image::RgbaImage::from_raw(width, height, image.bytes.into_owned())
        .ok_or("the clipboard image was not the size it claimed")?;

    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(buffer)
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;

    Ok(Some(data_url(&png.into_inner())))
}

/// A saved capture's pixels as a PNG data URL, for overlaying onto another.
///
/// Goes through `png_bytes`, which strips any markup the file carries: an
/// overlay wants the picture, not a second document's worth of shapes nested
/// inside the one being edited.
#[tauri::command]
pub async fn image_data_url(path: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(data_url(&png_bytes(std::path::Path::new(&path))?))
    })
    .await
    .map_err(|e| format!("reading that image failed: {e}"))?
}

fn data_url(png: &[u8]) -> String {
    use base64::Engine;
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png))
}

// -------------------------------------------------------------- window control

#[tauri::command]
pub fn hide_editor(app: AppHandle, window: WebviewWindow) -> CmdResult<()> {
    window.hide().map_err(|e| e.to_string())?;
    // Drop back to the menu bar so Shotly stops occupying the Dock and Cmd-Tab.
    platform::set_accessory_mode(&app, true);
    Ok(())
}

#[cfg(test)]
mod naming_tests {
    use super::{free_name_in, place_file};

    /// A recording is filed under its own extension, and never over the top of
    /// something already there.
    #[test]
    fn a_name_already_taken_is_numbered_rather_than_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let stem = "Recording 2026-08-17 at 13.58.12";

        let first = free_name_in(dir.path(), stem, "mov");
        assert_eq!(first.file_name().unwrap(), format!("{stem}.mov").as_str());

        std::fs::write(&first, b"").unwrap();
        let second = free_name_in(dir.path(), stem, "mov");
        assert_eq!(second.file_name().unwrap(), format!("{stem} (2).mov").as_str());

        std::fs::write(&second, b"").unwrap();
        let third = free_name_in(dir.path(), stem, "mov");
        assert_eq!(third.file_name().unwrap(), format!("{stem} (3).mov").as_str());

        // A still of the same name is a different file, not a collision.
        let png = free_name_in(dir.path(), stem, "png");
        assert_eq!(png.file_name().unwrap(), format!("{stem}.png").as_str());
    }

    #[test]
    fn a_stem_cannot_climb_out_of_the_library() {
        let dir = tempfile::tempdir().unwrap();

        // The separators are what matter, not the dots: "..-..-etc-passwd.mov"
        // is an odd name for a file and a perfectly harmless one, because it
        // cannot be anywhere but in the library.
        let escaped = free_name_in(dir.path(), "../../etc/passwd", "mov");
        assert_eq!(escaped.parent().unwrap(), dir.path());
        let name = escaped.file_name().unwrap().to_string_lossy();
        assert!(!name.contains('/') && !name.contains('\\') && !name.contains(':'), "{name}");

        // Nothing usable left in the name is still a file, not an extension
        // with no name in front of it.
        let empty = free_name_in(dir.path(), "  ...  ", "mov");
        assert_eq!(empty.file_name().unwrap(), "Capture.mov");
    }

    /// The recording is moved out of the scratch directory, not copied and
    /// left behind: these are hundreds of megabytes.
    #[test]
    fn filing_a_recording_leaves_nothing_in_the_scratch_directory() {
        let scratch = tempfile::tempdir().unwrap();
        let library = tempfile::tempdir().unwrap();

        let source = scratch.path().join("recording-1786961840681.mov");
        std::fs::write(&source, b"pretend this is a movie").unwrap();

        let target = free_name_in(library.path(), "Recording 2026-08-17 at 13.58.12", "mov");
        place_file(&source, &target).unwrap();

        assert!(!source.exists(), "the scratch copy was left behind");
        assert_eq!(std::fs::read(&target).unwrap(), b"pretend this is a movie");
    }

    #[test]
    fn a_stamped_stem_reads_the_way_a_screenshot_name_does() {
        let stem = super::stamped_stem("Recording");

        // "Recording 2026-08-17 at 11.52.03" — the shape `captureStem` in
        // src/lib/naming.ts produces, so a library sorted by name stays in
        // chronological order whatever put the file there.
        let rest = stem.strip_prefix("Recording ").expect("prefix");
        let (date, time) = rest.split_once(" at ").expect("date at time");

        assert_eq!(date.len(), 10, "{date} is not YYYY-MM-DD");
        assert_eq!(date.matches('-').count(), 2);
        assert_eq!(time.len(), 8, "{time} is not HH.MM.SS");
        assert_eq!(time.matches('.').count(), 2);
        assert!(date.chars().all(|c| c.is_ascii_digit() || c == '-'));
        assert!(time.chars().all(|c| c.is_ascii_digit() || c == '.'));
    }
}

#[cfg(test)]
mod tests {
    use super::data_url;

    /// Guards the base64 dependency across upgrades.
    ///
    /// Both places that hand a picture to the front end — the window picker's
    /// thumbnails and `image_data_url` — go through here, and a data URL that
    /// is subtly wrong shows up as an image that silently fails to decode
    /// rather than as anything that looks like an error. The vector is from
    /// RFC 4648, so this checks the encoding itself and not merely that some
    /// string came back.
    #[test]
    fn a_data_url_carries_standard_base64() {
        assert_eq!(data_url(b"foobar"), "data:image/png;base64,Zm9vYmFy");
        // Padding is the half that changes between encoders.
        assert_eq!(data_url(b"foob"), "data:image/png;base64,Zm9vYg==");
        assert_eq!(data_url(b""), "data:image/png;base64,");
    }
}

#[cfg(test)]
mod library_listing_tests {
    use super::{is_dataless, read_library};

    /// An ordinary file is not a cloud placeholder.
    ///
    /// Thin on its own — the interesting case cannot be built in a test, since
    /// only a file provider can mark a file dataless — but it pins the flag
    /// arithmetic. Getting `SF_DATALESS` wrong in the other direction would
    /// declare every capture undownloaded and empty the library grid.
    #[test]
    fn an_ordinary_file_is_not_dataless() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("plain.png");
        std::fs::write(&path, b"not really a png").expect("write");
        let meta = std::fs::metadata(&path).expect("stat");
        assert!(!is_dataless(&meta));
    }

    /// A listing survives files it cannot measure, and says so honestly.
    ///
    /// The bytes here are deliberately nonsense: an image whose header will not
    /// parse and a movie with no `moov` atom. Both must still appear — a
    /// capture that vanishes from the grid because its header is odd is worse
    /// than one listed without its dimensions.
    #[test]
    fn unreadable_captures_are_still_listed() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("shot.png"), b"nonsense").expect("write");
        std::fs::write(dir.path().join("clip.mov"), b"nonsense").expect("write");
        // Not a capture at all: it must not be listed.
        std::fs::write(dir.path().join("notes.txt"), b"hello").expect("write");

        let items = read_library(dir.path()).expect("listing");
        assert_eq!(items.len(), 2, "the text file should not be listed");

        let movie = items.iter().find(|i| i.name == "clip.mov").expect("the movie");
        assert!(movie.video);
        assert_eq!(movie.seconds, 0.0, "an unmeasurable movie reports no duration");
        assert!(!movie.cloud);

        let still = items.iter().find(|i| i.name == "shot.png").expect("the still");
        assert!(!still.video);
        assert_eq!((still.width, still.height), (0, 0));
        assert!(still.size > 0, "the size comes from stat and is always known");
    }

    /// A missing library folder is empty, not an error.
    #[test]
    fn a_missing_folder_lists_nothing() {
        let dir = tempfile::tempdir().expect("temp dir");
        let items = read_library(&dir.path().join("no-such-folder")).expect("listing");
        assert!(items.is_empty());
    }
}
