//! Sending one capture to someone, as a link.
//!
//! The shape of this matters more than the code in it, so it is worth stating
//! plainly. A capture lives in the Shotly folder on this Mac and nowhere else.
//! Sharing does not move it, does not need a backup, and does not care whether
//! any cloud app is installed: it uploads **the one file you chose** into a
//! folder of Shotly's own making, marks that one file readable by anyone with
//! the link, and puts the link on your clipboard. Everything else in the
//! library stays where it was and stays private.
//!
//! That is deliberately provider-shaped rather than Google-shaped. Uploading a
//! file, finding-or-making a folder, and turning a file id into a link are the
//! same three moves everywhere; only the URLs and the OAuth dance differ. So
//! the app talks to [`Provider`], and Google Drive is simply the first one
//! implemented — see `google.rs`. Adding OneDrive or Dropbox is a new file
//! implementing this trait and one line in [`all`], with nothing in the
//! frontend to revisit.
//!
//! What this replaced, and why: until 0.9.x an unconnected Shotly made links by
//! reading Drive for desktop's private SQLite index to recover the file id of a
//! backed-up copy. It worked, but it made sharing conditional on backing up
//! *into Google Drive specifically* — the capture in your own Shotly folder was
//! never the thing being shared. One provider, one code path, and the file on
//! your disk is the file that gets sent.

pub mod gauth;
pub mod google;

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter};

/// The folder a provider makes to hold what has been shared.
///
/// Deliberately not `Shotly`: the backup writes a folder of that name into
/// whichever cloud folder you pointed it at, and the two have opposite
/// intentions. Everything in here has been handed to someone on purpose;
/// nothing in the backup has. A separate name keeps a mistake in one from
/// quietly publishing the other.
pub const FOLDER: &str = "ShotlyShared";

/// A link, and whether it was made to work.
///
/// `shared` is not decoration. A link that is correct but opens for nobody is
/// the worst possible outcome — it looks like success on the clipboard and
/// fails at the far end — so a provider that could not set the permission says
/// so here and the caller words itself accordingly.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub url: String,
    pub shared: bool,
}

/// What a cloud has to do for Shotly to hand out links to it.
///
/// `Sync` because the registry hands out `&'static dyn Provider` to whichever
/// blocking thread is doing the upload.
pub trait Provider: Sync {
    /// Stable across releases — it is what the frontend passes back.
    fn id(&self) -> &'static str;

    /// What it is called on screen.
    fn name(&self) -> &'static str;

    /// Whether this build can talk to it at all. False when the app was built
    /// without the provider's client credentials — see `docs/RELEASING.md`.
    fn available(&self) -> bool;

    /// Whether an account is connected right now.
    fn connected(&self) -> bool;

    /// Run the consent flow, opening `open` in the user's browser.
    fn connect(&self, open: &dyn Fn(&str) -> Result<(), String>) -> Result<(), String>;

    /// Forget the account. Never fails: the worst case is a token this Mac has
    /// already stopped using.
    fn disconnect(&self);

    /// Upload `path`, share it, and describe the link — the whole job.
    fn upload(&self, path: &Path, progress: &mut dyn FnMut(u64, u64)) -> Result<Link, String>;
}

/// Every provider this build knows about.
///
/// One entry today. The list exists so that the second one is an addition
/// rather than a refactor, and so Settings can render whatever is here without
/// naming any of them.
fn all() -> Vec<&'static dyn Provider> {
    vec![&google::GOOGLE]
}

/// The provider a share should go to: the connected one.
///
/// With several connected this takes the first, which is only defensible while
/// there is no way to connect more than one at a time. When there is, this is
/// where the user's choice gets read.
fn current() -> Option<&'static dyn Provider> {
    all().into_iter().find(|p| p.connected())
}

fn find(id: &str) -> Result<&'static dyn Provider, String> {
    all().into_iter().find(|p| p.id() == id).ok_or_else(|| format!("no such service: {id}"))
}

/// One provider as the frontend sees it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub id: String,
    pub name: String,
    pub available: bool,
    pub connected: bool,
}

/// Where a capture can be sent, and where it can be sent right now.
#[tauri::command]
pub fn share_providers() -> Vec<Status> {
    all()
        .into_iter()
        .map(|p| Status {
            id: p.id().to_string(),
            name: p.name().to_string(),
            available: p.available(),
            connected: p.connected(),
        })
        .collect()
}

/// Whether anything is connected — the one question the share button asks.
#[tauri::command]
pub fn share_connected() -> bool {
    current().is_some()
}

/// Run a provider's consent flow, and report whether it took.
#[tauri::command]
pub async fn share_connect(app: AppHandle, id: String) -> Result<bool, String> {
    let provider = find(&id)?;
    tauri::async_runtime::spawn_blocking(move || {
        provider.connect(&|url| {
            use tauri_plugin_opener::OpenerExt;
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|e| format!("could not open your browser: {e}"))
        })?;
        Ok(provider.connected())
    })
    .await
    .map_err(|e| format!("connecting failed: {e}"))?
}

#[tauri::command]
pub fn share_disconnect(id: String) -> Result<(), String> {
    find(&id)?.disconnect();
    Ok(())
}

/// Upload one capture, share it, and hand back the link.
///
/// `path` is wherever the capture actually is — the Shotly folder, the Desktop,
/// anywhere the library can show it. Nothing about it needs to be in a cloud
/// folder first, which is the entire point.
///
/// Emits `share:progress` as `{ sent, total }` while it runs: these are
/// recordings, and a 300 MB upload with no progress is indistinguishable from a
/// hang.
#[tauri::command]
pub async fn share_link(app: AppHandle, path: String) -> Result<Link, String> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err("That capture is not on this disk any more.".into());
    }

    let provider = current().ok_or(
        "Connect a cloud account in Settings first — that is where the link comes from.",
    )?;

    tauri::async_runtime::spawn_blocking(move || {
        provider.upload(&source, &mut |sent, total| {
            let _ = app.emit("share:progress", serde_json::json!({ "sent": sent, "total": total }));
        })
    })
    .await
    .map_err(|e| format!("the upload failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ids are what the frontend stores and sends back, and a duplicate would
    /// make `find` answer arbitrarily.
    #[test]
    fn every_provider_has_its_own_id() {
        let mut ids: Vec<&str> = all().iter().map(|p| p.id()).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count);
        assert!(count > 0, "a build with no providers can never share anything");
    }

    #[test]
    fn a_provider_is_found_by_its_id() {
        assert_eq!(find("google").expect("google is built in").name(), "Google Drive");
        assert!(find("onedrive").is_err());
    }

    /// The two folders have opposite intentions — see the constant.
    #[test]
    fn shared_files_do_not_land_in_the_backup_folder() {
        assert_ne!(FOLDER, crate::backup::FOLDER);
    }
}
