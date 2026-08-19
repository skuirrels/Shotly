//! What the desktop-shell jobs will be on Windows.
//!
//! Every one of these has a counterpart — this is the concern with the least
//! doubt attached to it and the smallest total cost, roughly a week for all
//! five. They are stubs rather than implementations because the port has not
//! started; the note on each says what it will be, so that whoever writes it
//! is not rediscovering the same three MSDN pages.
//!
//! See `docs/WINDOWS.md`.

use std::path::Path;

/// Move files to the Recycle Bin, all of them or none.
///
/// `IFileOperation` with `FOF_ALLOWUNDO`, which is the shell's own bulk delete
/// — the same one Explorer uses, so the progress dialog, the undo entry and
/// the "this is too big for the bin" prompt all come for free. The `trash`
/// crate wraps it if pulling in COM by hand is not worth it.
pub fn trash(_paths: &[std::path::PathBuf]) -> Result<(), String> {
    Err("moving files to the Recycle Bin is not implemented yet".into())
}

/// Show a file where it lives, selected, in Explorer.
///
/// `explorer /select,<path>` is the direct equivalent of `open -R`. Worth
/// knowing before writing it: `explorer.exe` exits non-zero on success, so the
/// exit status must be ignored exactly as `open -R`'s is.
pub fn reveal(_path: &Path) -> Result<(), String> {
    Err("revealing a file is not implemented yet".into())
}

/// A clipboard write being assembled, one file at a time.
///
/// Same shape as the macOS one, and for the same memory reason — see the note
/// there. The implementation underneath is quite different: Windows has no
/// per-item clipboard, so the whole set becomes a single `CF_HDROP` naming
/// every file, plus at most one image in `CF_DIBV5` and a registered `PNG`
/// format (which is what modern applications actually read).
///
/// That gives the one real behavioural difference to plan for: a multi-file
/// copy can carry the files but not the pixels, because there is only one
/// image slot. Explorer behaves the same way, so it is what users expect —
/// but `push` will have to keep only the first image and drop the rest, rather
/// than attaching one per item.
pub struct ClipboardWrite {
    files: Vec<std::path::PathBuf>,
    image: Option<Vec<u8>>,
}

impl ClipboardWrite {
    pub fn with_capacity(files: usize) -> Self {
        Self { files: Vec::with_capacity(files), image: None }
    }

    /// Add one file, and its pixels if it is carrying any.
    pub fn push(&mut self, path: &Path, png: Option<Vec<u8>>) {
        self.files.push(path.to_path_buf());
        // Only the first image can be represented; see the note above.
        if self.image.is_none() {
            self.image = png;
        }
    }

    /// Hand the lot to the clipboard.
    pub fn finish(self) -> Result<(), String> {
        Err("copying files to the clipboard is not implemented yet".into())
    }
}

/// Are this file's bytes actually on the disk?
///
/// **This one is not optional and not cosmetic.** OneDrive's Files On-Demand
/// is the same hazard as `SF_DATALESS` on macOS, which cost five hang reports
/// in two days: opening an evicted file blocks while hundreds of megabytes are
/// fetched. The flags are `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` (a
/// placeholder whose bytes are remote) and `FILE_ATTRIBUTE_OFFLINE`, both on
/// `std::os::windows::fs::MetadataExt::file_attributes`.
///
/// It returns `false` today, which is the *dangerous* answer — it claims every
/// file is present. That is deliberate: a stub that refused everything would
/// make the library unusable, and this way the failure is a hang in one place
/// rather than an empty library everywhere. Implement it in the same change
/// that first opens a library file on Windows.
pub fn is_dataless(_meta: &std::fs::Metadata) -> bool {
    false
}

/// Draw a picture of a movie for the library grid.
///
/// `IShellItemImageFactory::GetImage`, which asks the same thumbnail providers
/// Explorer uses and therefore handles whatever codecs the machine has. Unlike
/// `qlmanage` it is in-process and synchronous, so the twenty-second deadline
/// and the scratch directory both disappear — but it must stay off the main
/// thread, which is where the caller already puts it.
pub fn poster(_source: &Path, _dest: &Path, _max: u32) -> Result<(), String> {
    Err("video thumbnails are not implemented yet".into())
}

/// A cloud sync folder found on this machine.
pub struct CloudFolder {
    /// What to show: "OneDrive — Contoso".
    pub label: String,
    /// Where to write, which is not always the folder that was found.
    pub path: String,
}

/// The cloud folders this PC has.
///
/// No `Library/CloudStorage` here — Windows has no single directory the
/// providers agree to mount under, so each is found its own way and this
/// returns the union. What is known:
///
/// * **OneDrive** sets `%OneDrive%`, and per-account `%OneDriveConsumer%` /
///   `%OneDriveCommercial%`. Environment variables are the documented route
///   and cover the renamed-folder case that guessing the path does not.
/// * **Dropbox** writes `%LOCALAPPDATA%\Dropbox\info.json`, which names every
///   configured account and its root. This is the documented location.
/// * **Google Drive** mounts a *drive letter* by default rather than a folder,
///   and the letter is configurable. `DriveFS` keeps its account list under
///   `%LOCALAPPDATA%\Google\DriveFS`, which is the same private store the old
///   `drive.rs` read — undocumented, so any failure here must stay soft.
///
/// Returning an empty list is always acceptable: the user can still pick a
/// folder by hand, which is what the button beside these does.
pub fn cloud_folders(_home: &Path) -> Vec<CloudFolder> {
    Vec::new()
}
