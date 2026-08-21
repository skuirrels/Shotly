//! Finding a capture by what is written in it.
//!
//! A library of four hundred screenshots is unsearchable by filename, because
//! every filename is the date. But a screenshot is mostly *words* — an error
//! message, a stack trace, a name in a sidebar — and macOS will read them out
//! of the pixels for nothing. So every still gets read once, and the text is
//! kept beside the library so that ⌘F can look inside the pictures instead of
//! only at their names.
//!
//! # Where the index lives, and why not in the file
//!
//! In the app's own config directory, not in `~/Documents/Shotly`. The capture
//! folder is the user's, it is the thing they point Finder at and sync to a
//! cloud, and dropping a private database in the middle of it would be rude.
//! Storing the text inside each PNG was the other candidate and is worse: it
//! would rewrite files the user has not touched, would not work for a JPEG
//! dropped in by hand, and would put a copy of everything a screenshot says
//! into a file they are about to email to somebody.
//!
//! An index outside the files it describes can go stale, so it is keyed on
//! modification time and rebuilt for anything that has changed. Losing it
//! entirely costs one background pass, which is why nothing here treats a read
//! failure as an error worth showing anyone.
//!
//! # Why it is done a few at a time
//!
//! Recognition is around a quarter of a second for a full-screen retina
//! capture, so a first run over a big library is minutes of work. Doing it in
//! one command would block a thread of the runtime for all of it and give the
//! interface nothing to say meanwhile. Instead the front end asks for a small
//! batch at a time and stops when there is nothing left — which also means
//! quitting halfway costs nothing, because each batch is saved before it
//! returns.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::commands::{is_dataless, library_dir, CmdResult};

/// Bumped when an entry means something different, which throws the old file
/// away rather than mixing two shapes of entry in one map.
const VERSION: u32 = 1;

/// How much text is kept for one capture.
///
/// A screenful of prose is a couple of kilobytes; this is generous enough for
/// a tall scrolling capture of a whole document and small enough that a big
/// library's index stays a file you could open in an editor. What is dropped
/// is the tail of something already far longer than anyone searches for.
const MAX_TEXT: usize = 16 * 1024;

#[derive(Serialize, Deserialize, Clone)]
struct Entry {
    /// The file's modification time when it was read, in milliseconds.
    modified: u64,
    /// Everything Vision found, lowercased and joined by newlines.
    text: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Index {
    version: u32,
    entries: HashMap<String, Entry>,
}

/// How far through the library the reader has got.
#[derive(Serialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// Captures whose text is known.
    pub indexed: usize,
    /// Captures there are to read, in total.
    pub total: usize,
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;
    Ok(dir.join("text-index.json"))
}

fn load(app: &AppHandle) -> Index {
    let loaded: Index = store_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    // An index written by a version that meant something else by an entry is
    // not worth migrating: re-reading the pictures is a background pass, and
    // guessing at old data is a bug that lives for ever.
    if loaded.version == VERSION {
        loaded
    } else {
        Index { version: VERSION, entries: HashMap::new() }
    }
}

fn save(app: &AppHandle, index: &Index) {
    let Ok(path) = store_path(app) else { return };
    let Ok(raw) = serde_json::to_string(index) else { return };
    // A failure here costs the work of one batch, next launch. It is not worth
    // interrupting anyone over.
    let _ = std::fs::write(path, raw);
}

/// The stills worth reading, newest first.
///
/// Recordings are excluded because there is nothing still to read, and a
/// capture whose bytes live in the cloud because reading it would mean
/// downloading it — which is the one thing the library is careful never to do
/// without being asked.
fn readable(app: &AppHandle) -> CmdResult<Vec<(String, u64)>> {
    let dir = library_dir(app)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut found: Vec<(String, u64)> = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if !path.is_file() || crate::video::is_video(&path) {
            continue;
        }
        let readable_kind = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| matches!(e.to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg"))
            .unwrap_or(false);
        if !readable_kind {
            continue;
        }

        let Ok(meta) = entry.metadata() else { continue };
        if is_dataless(&meta) {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        found.push((path.to_string_lossy().into_owned(), modified));
    }

    // Newest first, so the captures someone is most likely to go looking for
    // become searchable in the first few seconds rather than the last.
    found.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(found)
}

/// Read one file, and hand back what it says.
fn text_of(path: &str) -> String {
    let Ok(bytes) = std::fs::read(path) else { return String::new() };
    let Ok(scan) = crate::platform::text::read(&bytes) else { return String::new() };

    let mut text = String::new();
    for line in &scan.lines {
        // Vision's own confidence, used as a filter rather than shown: an
        // uncertain line in a search index is a false match nobody can explain,
        // where the same line in the grab panel is something to eye and judge.
        if line.confidence < 0.3 {
            continue;
        }
        text.push_str(&line.text.to_lowercase());
        text.push('\n');
        if text.len() >= MAX_TEXT {
            break;
        }
    }
    // The codes too — a QR in a screenshot is usually the most searchable thing
    // in it, and it is already decoded by the same pass.
    for code in &scan.codes {
        text.push_str(&code.payload.to_lowercase());
        text.push('\n');
    }
    text.truncate(MAX_TEXT);
    text
}

/// Drop entries for captures that are no longer there.
fn prune(index: &mut Index, present: &[(String, u64)]) -> bool {
    let before = index.entries.len();
    let live: std::collections::HashSet<&str> = present.iter().map(|(p, _)| p.as_str()).collect();
    index.entries.retain(|path, _| live.contains(path.as_str()));
    index.entries.len() != before
}

/// Read up to `budget` captures that haven't been read yet.
///
/// Returns where the whole library has got to, so the caller can decide
/// whether to come back for more.
#[tauri::command]
pub async fn text_index_step(app: AppHandle, budget: usize) -> CmdResult<Progress> {
    tauri::async_runtime::spawn_blocking(move || {
        let files = readable(&app)?;
        let mut index = load(&app);
        let mut dirty = prune(&mut index, &files);

        let stale = |index: &Index, path: &str, modified: u64| {
            index.entries.get(path).map(|e| e.modified != modified).unwrap_or(true)
        };

        let mut read = 0usize;
        for (path, modified) in &files {
            if read >= budget.clamp(1, 32) {
                break;
            }
            if !stale(&index, path, *modified) {
                continue;
            }
            let text = text_of(path);
            index
                .entries
                .insert(path.to_string(), Entry { modified: *modified, text });
            dirty = true;
            read += 1;
        }

        if dirty {
            save(&app, &index);
        }

        let indexed = files
            .iter()
            .filter(|(path, modified)| !stale(&index, path, *modified))
            .count();
        Ok(Progress { indexed, total: files.len() })
    })
    .await
    .map_err(|e| format!("the text index failed: {e}"))?
}

/// Which captures have this text somewhere in them.
///
/// Every word has to appear, in any order and anywhere in the picture — which
/// is how anyone searching a pile of screenshots actually thinks: two words
/// they remember seeing, not a phrase they could quote.
#[tauri::command]
pub fn search_text(app: AppHandle, query: String) -> Vec<String> {
    let words: Vec<String> = query
        .split_whitespace()
        .filter(|w| w.len() >= 2)
        .map(|w| w.to_lowercase())
        .collect();
    if words.is_empty() {
        return Vec::new();
    }

    let index = load(&app);
    index
        .entries
        .iter()
        .filter(|(_, entry)| words.iter().all(|w| entry.text.contains(w.as_str())))
        .map(|(path, _)| path.clone())
        .collect()
}

/// Forget everything and read the library again.
///
/// The way out when the index is wrong in some way nothing else explains —
/// exposed in Settings rather than run on a schedule, because the modification
/// times it is keyed on are right almost always.
#[tauri::command]
pub fn text_index_reset(app: AppHandle) -> CmdResult<()> {
    save(&app, &Index { version: VERSION, entries: HashMap::new() });
    Ok(())
}

/// Where the reading has got to, without doing any.
#[tauri::command]
pub fn text_index_progress(app: AppHandle) -> CmdResult<Progress> {
    let files = readable(&app)?;
    let index = load(&app);
    let indexed = files
        .iter()
        .filter(|(path, modified)| {
            index.entries.get(path.as_str()).map(|e| e.modified == *modified).unwrap_or(false)
        })
        .count();
    Ok(Progress { indexed, total: files.len() })
}
