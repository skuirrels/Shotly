//! Which build this is, and how it got here.
//!
//! Shotly is installed three different ways — dragged from a disk image,
//! replaced in place by the updater, or copied over the top by `npm run
//! bundle` during development — and until you look at the version number they
//! are indistinguishable. That bites whenever the number *is* the question: a
//! local debug build sitting at 0.1.5 while the published release is 0.1.6
//! looks exactly like an update that failed.
//!
//! So the About panel says which one it is. Both halves are derived rather
//! than declared: the profile comes from the compiler, and the origin from a
//! marker the updater leaves behind at the moment it installs.

use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager};

/// Shown in parentheses after the version, where macOS expects a build number.
pub const PROFILE: &str = if cfg!(debug_assertions) { "debug" } else { "release" };

fn marker(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("installed-by-updater"))
}

/// Identity of the copy on disk, as the executable's modification time.
///
/// This is what makes the check exact rather than approximate. A version alone
/// would still match after a copy dragged from a disk image landed on top of
/// an updated one of the same version; the timestamp changes when the bytes do.
fn stamp() -> Option<u64> {
    let exe = std::env::current_exe().ok()?;
    let modified = fs::metadata(exe).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_secs())
}

/// Record that the updater put this copy here. Called once it has.
///
/// `version` is the version just *installed*, which has to be passed in: this
/// runs inside the old build, so its own `package_info` still reports the
/// version being replaced — and a marker naming the outgoing version never
/// matches on the next launch, which reads as "installed by hand" for ever.
///
/// Best effort otherwise: a marker that could not be written costs one line of
/// the About panel and nothing else, which is not worth failing an update that
/// has just succeeded.
pub fn record_updater_install(app: &AppHandle, version: &str) {
    let (Some(path), Some(stamp)) = (marker(app), stamp()) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(path, format!("{version}\n{stamp}\n"));
}

/// Whether this exact copy was installed by the updater.
fn from_updater(app: &AppHandle) -> bool {
    // A debug build is never one we published, whatever marker an earlier
    // release may have left in place before it was overwritten.
    if cfg!(debug_assertions) {
        return false;
    }

    let (Some(path), Some(stamp)) = (marker(app), stamp()) else {
        return false;
    };
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };

    let mut lines = text.lines();
    let version = lines.next().unwrap_or_default();
    let recorded: Option<u64> = lines.next().and_then(|line| line.parse().ok());

    version == app.package_info().version.to_string() && recorded == Some(stamp)
}

/// The line beneath the version in the About panel.
pub fn summary(app: &AppHandle) -> String {
    if cfg!(debug_assertions) {
        return "Debug build — built locally, not a published release.".into();
    }
    if from_updater(app) {
        "Release build — installed automatically by Shotly's updater.".into()
    } else {
        "Release build — installed by hand, from the disk image or a copy.".into()
    }
}
