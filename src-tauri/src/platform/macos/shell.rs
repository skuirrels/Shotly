//! Asking the desktop shell to do the things a file manager does.
//!
//! Five jobs that have nothing in common except that the operating system owns
//! all of them: move a file somewhere recoverable, show one to the user, put a
//! selection on the clipboard, draw a picture of a movie, and say whether a
//! file's bytes are actually here. Each is a one-liner in AppKit or a
//! subprocess, and each is a different API on Windows — which is the whole
//! reason they are collected rather than left where they were used.
//!
//! Nothing in here validates anything. The callers resolve paths, check them
//! against the library root and decide what is worth putting on a clipboard;
//! by the time it reaches this module the decision has been made and only the
//! syscall is left. See `docs/WINDOWS.md`.

use std::path::Path;
use std::process::Command;

/// A clipboard write being assembled, one file at a time.
///
/// Built incrementally rather than from a slice of prepared files, and the
/// reason is memory. The budget lets a selection carry up to 96 MB of pixels;
/// if the caller read all of that first and handed it over in one go, those
/// bytes would exist twice at the moment of the write — once in the caller's
/// buffers and again inside the pasteboard items. Taking one file at a time
/// lets each `Vec` go as soon as its bytes have been copied, so the peak stays
/// at the budget rather than twice it.
///
/// The caller still decides *what* gets pixels: transcoding and rationing are
/// the same on every platform and are none of this module's business.
pub struct ClipboardWrite {
    items: Vec<objc2::rc::Retained<objc2::runtime::ProtocolObject<dyn objc2_app_kit::NSPasteboardWriting>>>,
}

/// Move files to the Trash, all of them or none.
///
/// One AppleScript call for the whole selection: deleting one at a time would
/// leave a half-finished job behind if Finder refused partway through, and
/// would bounce the Trash sound once per file.
pub fn trash(paths: &[std::path::PathBuf]) -> Result<(), String> {
    let list = paths
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
        Err(match paths.len() {
            1 => "could not move that file to the Trash".into(),
            n => format!("could not move those {n} files to the Trash"),
        })
    }
}

/// Show a file where it lives, selected, in Finder.
pub fn reveal(path: &Path) -> Result<(), String> {
    std::process::Command::new("/usr/bin/open")
        .args(["-R".as_ref(), path.as_os_str()])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Put a selection of files on the clipboard, as files *and* as pixels.
///
/// Both representations at once is what makes one copy paste as an image into
/// a document and as an attachment into Finder or Mail, without the user
/// having to say which they meant.
impl ClipboardWrite {
    pub fn with_capacity(files: usize) -> Self {
        Self { items: Vec::with_capacity(files) }
    }

    /// Add one file, and its pixels if it is carrying any.
    ///
    /// `png` is taken by value and dropped here: the bytes are copied into the
    /// pasteboard item, and holding the original any longer is what this API
    /// exists to avoid.
    pub fn push(&mut self, path: &Path, png: Option<Vec<u8>>) {
        use objc2::runtime::ProtocolObject;
        use objc2_app_kit::{NSPasteboardItem, NSPasteboardTypeFileURL, NSPasteboardTypePNG};
        use objc2_foundation::{NSData, NSString, NSURL};

        let item = NSPasteboardItem::new();

        // SAFETY: the pasteboard type constants are immortal statics, and
        // every object here is one we just created.
        unsafe {
            // The file URL is cheap and always worth attaching.
            let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
            if let Some(string) = url.absoluteString() {
                item.setString_forType(&string, NSPasteboardTypeFileURL);
            }

            // Image data is not. Past the budget an item carries only its file
            // URL, so it still pastes as a file.
            if let Some(png) = png {
                item.setData_forType(&NSData::with_bytes(&png), NSPasteboardTypePNG);
            }
        }

        self.items.push(ProtocolObject::from_retained(item));
    }

    /// Hand the lot to the pasteboard.
    pub fn finish(self) -> Result<(), String> {
        use objc2_app_kit::NSPasteboard;
        use objc2_foundation::NSArray;

        // `clearContents` must precede the write, or the pasteboard rejects it.
        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();
        if !pasteboard.writeObjects(&NSArray::from_retained_slice(&self.items)) {
            return Err("the clipboard rejected the selection".into());
        }
        Ok(())
    }
}

/// Are this file's bytes actually on the disk?
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
pub fn is_dataless(meta: &std::fs::Metadata) -> bool {
    use std::os::macos::fs::MetadataExt;
    /// `sys/stat.h`: "file is dataless object".
    const SF_DATALESS: u32 = 0x4000_0000;
    meta.st_flags() & SF_DATALESS != 0
}

/// How long QuickLook may take over one poster frame.
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Write a still of `source` into `dest`, no larger than `max` on its long edge.
///
/// QuickLook rather than a frame grabber of our own: it is the picture the user
/// already associates with the file from Finder, it costs no dependency and no
/// codec decisions, and it is one subprocess in the same spirit as the rest of
/// the capture layer. It writes `<name>.png` beside wherever it is pointed, so
/// it is pointed at a directory of its own and the result moved into place.
/// Somewhere for QuickLook to write, belonging to this one thumbnail.
///
/// Per call, not per process: thumbnails are asked for concurrently now that
/// they are off the main thread, and this directory is deleted when its poster
/// is done — a shared one would be deleted out from under whichever poster was
/// still being written into it.
fn scratch_for(dest: &Path) -> Option<std::path::PathBuf> {
    let stem = dest.file_stem()?.to_string_lossy().into_owned();
    Some(dest.parent()?.join(format!("ql-{stem}")))
}

pub fn poster(source: &Path, dest: &Path, max: u32) -> Result<(), String> {
    let scratch = scratch_for(dest).ok_or("no cache directory")?;
    std::fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;

    let mut child = Command::new("/usr/bin/qlmanage")
        .args(["-t", "-s", &max.to_string(), "-o"])
        .arg(&scratch)
        .arg(source)
        // No pipes: `output()` waits for the pipes to close rather than for the
        // process to end, and QuickLook is a daemon-backed thing whose helpers
        // can outlive the command. Whether it worked is answered by whether the
        // file appeared, which needs no output at all.
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("could not run qlmanage: {e}"))?;

    // A deadline, because this is somebody else's process. It normally takes
    // well under a second — three seconds the first time after login, while
    // QuickLook warms up — and a thumbnail is never worth waiting longer than
    // this for.
    let deadline = std::time::Instant::now() + TIMEOUT;
    let finished = loop {
        match child.try_wait() {
            Ok(Some(_)) => break true,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
            Err(_) => break false,
        }
    };

    let name = source.file_name().ok_or("no file name")?;
    let produced = scratch.join(format!("{}.png", name.to_string_lossy()));

    if !produced.exists() {
        let _ = std::fs::remove_dir_all(&scratch);
        return Err(if finished {
            "QuickLook produced no thumbnail".into()
        } else {
            "QuickLook took too long over the thumbnail".into()
        });
    }

    let moved = std::fs::rename(&produced, dest);
    if moved.is_err() {
        std::fs::copy(&produced, dest).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_dir_all(&scratch);
    Ok(())
}

/// Where macOS mounts the sync folders of every cloud provider.
const CLOUD_STORAGE: &str = "Library/CloudStorage";

/// A cloud sync folder found on this machine.
pub struct CloudFolder {
    /// What to show: "Google Drive — you@example.com".
    pub label: String,
    /// Where to write, which is not always the folder that was found.
    pub path: String,
}

/// The cloud folders this Mac has.
///
/// One directory holds them all, named `Provider-account`, so a person with a
/// work and a personal Drive gets two entries and can tell them apart.
pub fn cloud_folders(home: &Path) -> Vec<CloudFolder> {
    let Ok(entries) = std::fs::read_dir(home.join(CLOUD_STORAGE)) else {
        return Vec::new();
    };

    let mut found = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Folders only, and no dotfiles: this directory has a .DS_Store in it,
        // and offering that as somewhere to keep your screenshots would be a
        // poor first impression.
        if name.starts_with('.') || !entry.path().is_dir() {
            continue;
        }
        let (provider, account) = match name.split_once('-') {
            Some((provider, account)) => (provider, Some(account.to_string())),
            None => (name.as_str(), None),
        };

        // Drive puts everything one level further down, under "My Drive";
        // writing to the account root itself is not allowed.
        let root = entry.path();
        let path = if root.join("My Drive").is_dir() { root.join("My Drive") } else { root };

        let provider = match provider {
            "GoogleDrive" => "Google Drive",
            "Dropbox" => "Dropbox",
            "OneDrive" => "OneDrive",
            other => other,
        };

        found.push(CloudFolder {
            label: match &account {
                Some(account) if !account.is_empty() => format!("{provider} — {account}"),
                _ => provider.to_string(),
            },
            path: path.to_string_lossy().into_owned(),
        });
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two thumbnails being made at once must not share a workspace: each one
    /// deletes its own when it finishes, and the first to finish would take the
    /// other's poster frame with it.
    #[test]
    fn two_posters_never_share_a_scratch_directory() {
        let cache = Path::new("/tmp/shotly/thumbs");
        let one = scratch_for(&cache.join("1a2b-1786961840681-480.png")).unwrap();
        let two = scratch_for(&cache.join("9f8e-1786961840681-480.png")).unwrap();

        assert_ne!(one, two);
        // Beside the thumbnail it is for, so cleaning the cache cleans these.
        assert_eq!(one.parent().unwrap(), cache);
        assert_eq!(scratch_for(Path::new("no-parent.png")), Some("ql-no-parent".into()));
    }
}

#[cfg(test)]
mod smoke {
    //! Exercises the shell calls that the unit tests cannot reach, against
    //! real files in a temporary directory. Ignored by default: `reveal`
    //! opens a Finder window and `trash` moves a file, so neither belongs in
    //! an unattended run. `cargo test -- --ignored smoke` to check a refactor
    //! of this module by hand.
    use super::*;

    #[test]
    #[ignore]
    fn a_file_can_be_revealed_and_then_trashed() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("smoke capture.png");
        std::fs::write(&file, b"not really a png").unwrap();

        reveal(&file).expect("reveal should spawn");
        trash(&[file.clone()]).expect("trash should succeed");
        assert!(!file.exists(), "the file should have left the directory");
    }

    #[test]
    #[ignore]
    fn a_selection_reaches_the_pasteboard() {
        let dir = tempfile::tempdir().unwrap();
        let one = dir.path().join("one.png");
        let two = dir.path().join("two.png");
        let png = image::RgbaImage::from_pixel(4, 4, image::Rgba([255, 0, 0, 255]));
        png.save(&one).unwrap();
        png.save(&two).unwrap();

        let mut write = ClipboardWrite::with_capacity(2);
        write.push(&one, Some(std::fs::read(&one).unwrap()));
        write.push(&two, None);
        write.finish().expect("the pasteboard should accept it");
    }
}
