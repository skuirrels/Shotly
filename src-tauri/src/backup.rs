//! A second copy of every capture, in a folder something else syncs.
//!
//! Deliberately not an integration. Google Drive, Dropbox and iCloud all put a
//! real directory on the disk and upload whatever appears in it, so a backup
//! to any of them is a file copy — no OAuth, no tokens to keep safe, no
//! refresh flow to get wrong, and nothing that stops working when a provider
//! changes an API. Shotly's whole part in this is `std::fs::copy`.
//!
//! The cost is honest and worth stating: this only works on a machine where
//! that folder exists and its app is signed in. Uploading over an API would
//! not need one, and is the thing to build if this turns out not to be enough.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// The subfolder captures are copied into, inside whichever folder was chosen.
///
/// Not to be confused with `share::FOLDER`, which is where a capture goes when
/// you deliberately send it to someone. Everything here is a second copy of
/// everything you have taken; everything there has been handed out on purpose.
/// A test asserts the two names differ.
pub const FOLDER: &str = "Shotly";

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
    /// The chosen sync folder — the account root, not the `Shotly` subfolder.
    pub destination: Option<String>,
}

/// A sync folder found on this Mac, ready to be offered as a one-click choice.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// What to show: "Google Drive — you@example.com".
    pub label: String,
    pub path: String,
}

/// What a run of the mirror did.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub copied: usize,
    /// Already there and unchanged.
    pub skipped: usize,
    pub failed: usize,
    /// The full path of the folder written into, for the "show me" link.
    pub destination: String,
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;
    Ok(dir.join("backup.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    store_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = store_path(app)?;
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| format!("could not write {path:?}: {e}"))
}

/// The cloud folders this machine has, as things to click rather than paths to
/// type.
///
/// Where those folders live, and how a provider's name is read out of one, is
/// the operating system's business — see `platform::shell::cloud_folders`. On
/// macOS they are all under one directory; on Windows each provider keeps its
/// own, which is why this is a list-returning call rather than a path constant.
#[tauri::command]
pub fn backup_targets(app: AppHandle) -> Vec<Target> {
    let Ok(home) = app.path().home_dir() else {
        return Vec::new();
    };

    let mut targets: Vec<Target> = crate::platform::shell::cloud_folders(&home)
        .into_iter()
        .map(|found| Target { label: found.label, path: found.path })
        .collect();

    targets.sort_by(|a, b| a.label.cmp(&b.label));
    targets
}

#[tauri::command]
pub fn backup_settings(app: AppHandle) -> Settings {
    load(&app)
}

/// Turn the backup on or off, or point it somewhere else.
///
/// Refuses a destination that isn't there: a backup writing into a folder that
/// no longer exists is worse than no backup, because it looks like one.
#[tauri::command]
pub fn backup_configure(
    app: AppHandle,
    enabled: bool,
    destination: Option<String>,
) -> Result<Settings, String> {
    if enabled {
        let Some(dir) = destination.as_deref() else {
            return Err("choose a folder to back up to".into());
        };
        if !Path::new(dir).is_dir() {
            return Err(format!("{dir} is not a folder on this Mac"));
        }
    }

    let settings = Settings { enabled, destination };
    save(&app, &settings)?;
    Ok(settings)
}

/// The `Shotly` folder inside the chosen destination, created if need be.
fn target_dir(app: &AppHandle) -> Option<PathBuf> {
    let settings = load(app);
    if !settings.enabled {
        return None;
    }
    let dir = Path::new(settings.destination.as_deref()?).join(FOLDER);
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Copy one capture across, if a backup is switched on.
///
/// Never fails the save it is attached to. A capture that made it into the
/// library is safe; a copy that didn't is a copy, and the next "Back up now"
/// will pick it up. Reporting it as a save failure would be a lie.
pub fn mirror_one(app: &AppHandle, path: &str) {
    let Some(dir) = target_dir(app) else { return };
    let source = Path::new(path);
    let Some(name) = source.file_name() else { return };

    if let Err(e) = copy_if_stale(source, &dir.join(name)) {
        eprintln!("[shotly] backup of {path} failed: {e}");
    }
}

/// Copy unless the destination already has the same bytes.
///
/// Compared on size and modification time rather than by reading both files:
/// a library of several hundred retina captures is a couple of gigabytes, and
/// hashing all of it to discover that nothing changed would make "Back up now"
/// take minutes.
fn copy_if_stale(source: &Path, target: &Path) -> std::io::Result<bool> {
    let from = source.metadata()?;
    if let Ok(to) = target.metadata() {
        let same_size = from.len() == to.len();
        let not_newer = match (from.modified(), to.modified()) {
            (Ok(a), Ok(b)) => a <= b,
            _ => false,
        };
        if same_size && not_newer {
            return Ok(false);
        }
    }

    std::fs::copy(source, target)?;
    Ok(true)
}

/// Copy everything in the library that isn't already there.
#[tauri::command]
pub fn backup_now(app: AppHandle) -> Result<Report, String> {
    let settings = load(&app);
    let destination = settings
        .destination
        .clone()
        .ok_or("no backup folder has been chosen")?;

    let dir = Path::new(&destination).join(FOLDER);
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;

    let library = crate::commands::library_dir(&app).map_err(|e| e.to_string())?;
    let entries = match std::fs::read_dir(&library) {
        Ok(entries) => entries,
        // Nothing captured yet is a successful backup of nothing.
        Err(_) => {
            return Ok(Report { destination: dir.to_string_lossy().into_owned(), ..Report::default() })
        }
    };

    let mut report = Report { destination: dir.to_string_lossy().into_owned(), ..Report::default() };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_image = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| matches!(e.to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg"))
            .unwrap_or(false);
        if !is_image {
            continue;
        }
        let Some(name) = path.file_name() else { continue };

        match copy_if_stale(&path, &dir.join(name)) {
            Ok(true) => report.copied += 1,
            Ok(false) => report.skipped += 1,
            Err(e) => {
                eprintln!("[shotly] backup of {path:?} failed: {e}");
                report.failed += 1;
            }
        }
    }

    let _ = app.emit("backup:done", &report);
    Ok(report)
}

// ------------------------------------------------------------ start at login

/// Whether Shotly opens itself when you log in.
///
/// Kept in `backup.rs` only because this is where the app's few *settings*
/// live; it has nothing to do with backups. The plugin writes a LaunchAgent
/// pointing at this bundle, so enabling it from a debug build registers the
/// debug build — which is the honest behaviour, and worth knowing when the
/// switch appears to do nothing after you delete that build.
#[cfg(desktop)]
#[tauri::command]
pub fn launch_at_login(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[cfg(desktop)]
#[tauri::command]
pub fn set_launch_at_login(app: AppHandle, enabled: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| format!("could not add Shotly to your login items: {e}"))?;
    } else {
        manager.disable().map_err(|e| format!("could not remove the login item: {e}"))?;
    }
    // Report what the system says rather than what was asked for: the switch
    // should show the truth even if macOS quietly declined.
    Ok(manager.is_enabled().unwrap_or(enabled))
}
