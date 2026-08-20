//! Automatic updates.
//!
//! Shotly spends most of its life hidden in the menu bar, so the update cycle
//! is driven from here rather than from the editor's webview: a webview whose
//! window is occluded gets its timers throttled hard by WebKit, and an update
//! schedule that only advances while someone happens to be looking at the
//! library is not a schedule. Rust checks, downloads and installs; the front
//! end only reports what happened and offers the relaunch.
//!
//! Updates are verified twice over. The bundler signs the tarball with a
//! minisign key whose public half is baked into `tauri.conf.json`, so an
//! endpoint that has been tampered with cannot hand us a payload we will
//! install; and the payload itself is a code-signed `.app`, so macOS still has
//! its own say. Both halves matter — see `docs/RELEASING.md`.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

/// Event carrying every `Status` below to the editor window.
pub const EVENT: &str = "update:status";

/// Long enough to stay out of the way of launch — the first capture of a
/// session tends to happen within a second or two of the app appearing, and
/// that should not be competing with a download for the network or the disk.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(20);

/// Shotly is a background app that can stay resident for weeks, so "on launch"
/// alone would leave some users pinned to an old build indefinitely.
const RECHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// Progress events are throttled to this: a chunk callback fires far more
/// often than a progress bar can usefully repaint, and each one crosses the
/// IPC boundary.
const PROGRESS_EVERY: Duration = Duration::from_millis(150);

/// Guards against two checks overlapping — the six-hourly timer and the tray's
/// "Check for Updates…" can otherwise collide and install the same update
/// twice, over the top of itself.
static RUNNING: AtomicBool = AtomicBool::new(false);

/// The most recent status, replayed to the editor when it mounts.
///
/// The background check usually finishes while the editor is hidden, so the
/// event announcing a staged update is emitted to nobody. Without this, an
/// update installed at 3am would never be mentioned.
static LAST: Mutex<Option<Status>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    Checking,
    UpToDate,
    Downloading {
        version: String,
        received: u64,
        /// Absent when the server declines to send a Content-Length.
        total: Option<u64>,
    },
    /// Installed and waiting on a relaunch to take effect.
    Ready {
        version: String,
        notes: Option<String>,
    },
    Failed {
        message: String,
    },
}

impl Status {
    /// Whether this is worth replaying to a newly mounted editor.
    ///
    /// Only a staged update is. Resurfacing "checking", or a download
    /// percentage frozen at whatever it read hours ago, would be a progress
    /// bar that never moves; and a failure is only ever emitted to a window
    /// that was already open to see it.
    fn is_durable(&self) -> bool {
        matches!(self, Status::Ready { .. })
    }
}

fn emit(app: &AppHandle, status: Status) {
    if status.is_durable() {
        *LAST.lock().unwrap() = Some(status.clone());
    }
    let _ = app.emit_to("editor", EVENT, status);
}

/// Replayed by the editor on mount. See `LAST`.
#[tauri::command]
pub fn pending_update() -> Option<Status> {
    LAST.lock().unwrap().clone()
}

/// Check, and install anything newer.
///
/// `announce` distinguishes the two callers. The scheduled check stays quiet
/// until it has something to say, because "no update available" is not news
/// the user asked for; the menu item says so explicitly, because a command you
/// chose from a menu that produces no visible response reads as broken.
async fn run(app: AppHandle, announce: bool) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }

    if let Err(message) = install(&app, announce).await {
        eprintln!("[shotly] update failed: {message}");
        // Only a check the user asked for reports its failure. The scheduled
        // one runs into closed laptops, captive portals and flaky hotel wifi
        // as a matter of course, and none of that is worth interrupting
        // someone mid-annotation with a red box they can do nothing about —
        // the next check in six hours will quietly succeed.
        if announce {
            emit(&app, Status::Failed { message });
        }
    }

    RUNNING.store(false, Ordering::SeqCst);
}

async fn install(app: &AppHandle, announce: bool) -> Result<(), String> {
    if announce {
        emit(app, Status::Checking);
    }

    // Asked for without a cache in the way, and asked for out loud.
    //
    // The manifest comes back from GitHub with no `cache-control` and no
    // `expires` — only `last-modified` and an etag — which is exactly the
    // response any intermediary is entitled to invent a freshness lifetime
    // for, the usual guess being a tenth of the file's age. A release
    // published an hour ago therefore reads as fresh for six minutes to a
    // proxy that has seen the previous answer, and the update quietly does
    // not exist for that long. `no-cache` on the request is the standard
    // instruction not to do that: serve it, but revalidate first.
    let updater = app
        .updater_builder()
        .header("Cache-Control", "no-cache")
        .map_err(|e| e.to_string())?
        .header("Pragma", "no-cache")
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;

    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        // Logged either way, because "the updater cannot see it" is otherwise
        // impossible to tell from "the updater has not looked yet" — and the
        // two have completely different answers.
        eprintln!("[shotly] update check: already newest ({})", app.package_info().version);
        if announce {
            emit(app, Status::UpToDate);
        }
        return Ok(());
    };
    eprintln!("[shotly] update check: {} is available", update.version);

    let version = update.version.clone();
    let notes = update.body.clone();
    emit(
        app,
        Status::Downloading { version: version.clone(), received: 0, total: None },
    );

    let progress_app = app.clone();
    let progress_version = version.clone();
    let mut received: u64 = 0;
    let mut last = Instant::now();

    update
        .download_and_install(
            move |chunk, total| {
                received += chunk as u64;
                if last.elapsed() < PROGRESS_EVERY {
                    return;
                }
                last = Instant::now();
                emit(
                    &progress_app,
                    Status::Downloading {
                        version: progress_version.clone(),
                        received,
                        total,
                    },
                );
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    // The new bundle is on disk by now, so this stamps the copy that is
    // actually installed rather than the one still running — and records the
    // version going in, not the one on its way out.
    crate::build_info::record_updater_install(app, &version);

    emit(app, Status::Ready { version, notes });
    Ok(())
}

/// Start the background schedule. Called once, from setup.
///
/// A plain thread rather than an async timer: this wakes up four times a day,
/// and a thread parked in `sleep` costs a stack and nothing else.
pub fn schedule(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_DELAY);
        loop {
            tauri::async_runtime::block_on(run(app.clone(), false));
            std::thread::sleep(RECHECK_EVERY);
        }
    });
}

/// The tray's "Check for Updates…".
///
/// Brings the editor up first: the answer — up to date, downloading, failed —
/// is rendered in the editor window, and a menu item whose entire response
/// lands in a window you cannot see has told you nothing.
pub fn check_from_tray(app: &AppHandle) {
    if let Some(editor) = app.get_webview_window("editor") {
        crate::platform::chrome::set_accessory_mode(app, false);
        let _ = editor.show();
        let _ = editor.set_focus();
    }
    tauri::async_runtime::spawn(run(app.clone(), true));
}

#[tauri::command]
pub fn check_for_updates(app: AppHandle) {
    tauri::async_runtime::spawn(run(app, true));
}
