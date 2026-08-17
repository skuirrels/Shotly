//! A shareable link to a capture, without a Google API.
//!
//! The backup copies captures into the Drive folder and Drive uploads them —
//! see `backup.rs`, and the reasoning there for why that is a file copy and not
//! an integration. What a copy cannot give you is the *link*: a file's Drive id
//! is not derivable from its path.
//!
//! It is, however, already on this Mac. Drive for desktop keeps everything it
//! syncs in a SQLite database of its own, and the `items` table carries the id
//! beside the name. So a link costs one read-only query — no OAuth, no tokens,
//! nothing to sign into, and nothing that stops working when someone's session
//! expires.
//!
//! **The cost, stated plainly:** that database is Google's private store. It is
//! undocumented and they may change its shape in any update. Every failure here
//! is therefore soft — no link, and the caller says so — and none of it is on a
//! path that has to work for Shotly to be useful.
//!
//! Sharing itself stays where it belongs: the user sets the Shotly folder in
//! Drive to "anyone with the link can view" once, and every capture inside
//! inherits it. Setting that per file would need the API this module exists to
//! avoid.

use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::{AppHandle, Manager};

/// Where Drive for desktop keeps its index, under the home directory.
const DRIVEFS: &str = "Library/Application Support/Google/DriveFS";

/// The file inside each account folder.
const INDEX: &str = "metadata_sqlite_db";

/// How deep a parent walk may go before it is a loop rather than a path.
const MAX_DEPTH: usize = 12;

/// One row of the parent walk: the same file, at one level of its chain.
#[derive(Debug, PartialEq)]
struct Rung {
    id: String,
    depth: usize,
    name: String,
}

/// Every signed-in account's index, newest first is not meaningful — all are
/// searched, because a Mac can be signed into a work account and a personal one
/// and the backup folder belongs to exactly one of them.
fn indexes(home: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(home.join(DRIVEFS)) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| e.path().join(INDEX))
        .filter(|p| p.is_file())
        .collect()
}

/// A string as a SQL literal.
///
/// The CLI takes a statement, not bound parameters, and capture names are the
/// user's — a quote in one would otherwise end the literal early and turn a
/// filename into syntax. Doubling is SQL's own escape and the only one needed
/// inside a quoted string.
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Ask Drive's index for every file of this name, with the chain above it.
///
/// One statement rather than a walk in Rust doing a query per rung: this runs
/// while someone waits for a menu to do something, and the whole point is that
/// it is quick. Read-only, on the live database — measured at 9ms against a
/// real one, which is why it is not worth copying the file first.
fn walk(index: &Path, name: &str) -> Result<Vec<Rung>, String> {
    let sql = format!(
        "WITH RECURSIVE up(stable_id, id, depth, name) AS (
             SELECT stable_id, id, 0, local_title FROM items
              WHERE local_title = {name} AND trashed = 0 AND is_folder = 0
             UNION ALL
             SELECT p.parent_stable_id,
                    up.id,
                    up.depth + 1,
                    (SELECT local_title FROM items WHERE stable_id = p.parent_stable_id)
               FROM up JOIN stable_parents p ON p.item_stable_id = up.stable_id
              WHERE up.depth < {MAX_DEPTH}
         )
         SELECT id, depth, name FROM up WHERE name IS NOT NULL;",
        name = quote(name),
    );

    let output = Command::new("/usr/bin/sqlite3")
        .arg(format!("file:{}?mode=ro", index.to_string_lossy()))
        .arg("-separator")
        .arg("\u{1}")
        .arg(sql)
        .output()
        .map_err(|e| format!("could not read Drive's index: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "could not read Drive's index: {}",
            String::from_utf8_lossy(&output.stderr).trim(),
        ));
    }

    Ok(parse(&String::from_utf8_lossy(&output.stdout)))
}

/// Rows into rungs, skipping anything that is not the three fields expected.
///
/// Separated from the query so the shape of the answer can be tested without
/// standing up a database, and so a schema change shows up as "no link" rather
/// than as a panic.
fn parse(stdout: &str) -> Vec<Rung> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\u{1}');
            let id = parts.next()?.to_string();
            let depth = parts.next()?.parse().ok()?;
            let name = parts.next()?.to_string();
            (!id.is_empty()).then_some(Rung { id, depth, name })
        })
        .collect()
}

/// The one file whose folders match `expected`, leaf first.
///
/// This is the whole reason the parent chain is fetched at all. A real Drive on
/// the machine this was written against has *two* folders called "Shotly", both
/// directly under My Drive, and the backup writes to one of them. Matching on
/// the name alone would be a coin toss, and a link to the wrong file is worse
/// than no link — so an ambiguous answer returns nothing.
fn matching(rungs: Vec<Rung>, expected: &[String]) -> Option<String> {
    let mut by_id: std::collections::HashMap<String, Vec<Rung>> = std::collections::HashMap::new();
    for rung in rungs {
        by_id.entry(rung.id.clone()).or_default().push(rung);
    }

    let mut found: Option<String> = None;
    for (id, mut chain) in by_id {
        chain.sort_by_key(|r| r.depth);
        // Rung 0 is the file itself; the folders start above it.
        let folders: Vec<&str> = chain.iter().skip(1).map(|r| r.name.as_str()).collect();
        if !folders.starts_with(&expected.iter().map(|s| s.as_str()).collect::<Vec<_>>()[..]) {
            continue;
        }
        if found.is_some() {
            return None;
        }
        found = Some(id);
    }
    found
}

/// The folders a backed-up capture sits in, leaf first.
///
/// Derived from the destination the user chose rather than assumed: they picked
/// an account's folder, and `backup.rs` writes into a `Shotly` subfolder of it.
/// Drive's own name for the account root — "My Drive" — is the last rung, and
/// the path already ends in it.
fn expected_chain(destination: &Path, subfolder: &str) -> Vec<String> {
    let mut chain = vec![subfolder.to_string()];
    if let Some(root) = destination.file_name() {
        chain.push(root.to_string_lossy().into_owned());
    }
    chain
}

/// A link to the backed-up copy of `name`, or why there isn't one.
#[tauri::command]
pub async fn drive_link(app: AppHandle, path: String) -> Result<String, String> {
    let settings = crate::backup::load(&app);
    let destination = settings
        .destination
        .filter(|_| settings.enabled)
        .ok_or("Turn on Backup in Settings first — a link points at the copy in your Drive.")?;

    let destination = PathBuf::from(destination);
    if !destination.to_string_lossy().contains("GoogleDrive") {
        return Err("Links come from Google Drive, and the backup folder is somewhere else.".into());
    }

    let name = Path::new(&path)
        .file_name()
        .ok_or("that capture has no name")?
        .to_string_lossy()
        .into_owned();

    // The copy has to exist before Drive can have uploaded it.
    if !destination.join(crate::backup::FOLDER).join(&name).exists() {
        return Err("That capture hasn't been backed up yet — run Back Up Now.".into());
    }

    let home = app.path().home_dir().map_err(|e| format!("no home directory: {e}"))?;
    let expected = expected_chain(&destination, crate::backup::FOLDER);

    tauri::async_runtime::spawn_blocking(move || {
        for index in indexes(&home) {
            if let Some(id) = matching(walk(&index, &name)?, &expected) {
                return Ok(format!("https://drive.google.com/file/d/{id}/view?usp=sharing"));
            }
        }
        Err(
            "Google Drive hasn't finished uploading that one yet. Give it a moment and try again."
                .into(),
        )
    })
    .await
    .map_err(|e| format!("the lookup failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A filename is data, and quoting is the only thing standing between a
    /// quote in one and a broken statement.
    #[test]
    fn names_are_escaped_into_literals() {
        assert_eq!(quote("plain.png"), "'plain.png'");
        assert_eq!(quote("Ty's shot.png"), "'Ty''s shot.png'");
        assert_eq!(quote("'; drop table items; --"), "'''; drop table items; --'");
    }

    #[test]
    fn rows_that_are_not_three_fields_are_ignored() {
        let rows = "abc\u{1}0\u{1}shot.png\nrubbish\n\u{1}1\u{1}Shotly\nabc\u{1}1\u{1}Shotly\n";
        assert_eq!(
            parse(rows),
            vec![
                Rung { id: "abc".into(), depth: 0, name: "shot.png".into() },
                Rung { id: "abc".into(), depth: 1, name: "Shotly".into() },
            ],
        );
    }

    fn rung(id: &str, depth: usize, name: &str) -> Rung {
        Rung { id: id.into(), depth, name: name.into() }
    }

    /// The case a real Drive presented: two folders of the same name, one of
    /// them the backup's. The chain is what tells them apart.
    #[test]
    fn the_right_shotly_folder_wins() {
        let rungs = vec![
            rung("wanted", 0, "clip.mov"),
            rung("wanted", 1, "Shotly"),
            rung("wanted", 2, "My Drive"),
            rung("other", 0, "clip.mov"),
            rung("other", 1, "Archive"),
            rung("other", 2, "My Drive"),
        ];
        let expected = vec!["Shotly".to_string(), "My Drive".to_string()];
        assert_eq!(matching(rungs, &expected), Some("wanted".to_string()));
    }

    /// Two files that both fit the description is not a reason to pick one.
    #[test]
    fn an_ambiguous_answer_is_no_answer() {
        let rungs = vec![
            rung("a", 0, "clip.mov"),
            rung("a", 1, "Shotly"),
            rung("a", 2, "My Drive"),
            rung("b", 0, "clip.mov"),
            rung("b", 1, "Shotly"),
            rung("b", 2, "My Drive"),
        ];
        let expected = vec!["Shotly".to_string(), "My Drive".to_string()];
        assert_eq!(matching(rungs, &expected), None);
    }

    #[test]
    fn a_file_somewhere_else_is_not_a_match() {
        let rungs = vec![rung("x", 0, "clip.mov"), rung("x", 1, "Downloads"), rung("x", 2, "My Drive")];
        let expected = vec!["Shotly".to_string(), "My Drive".to_string()];
        assert_eq!(matching(rungs, &expected), None);
    }

    #[test]
    fn the_chain_comes_from_the_chosen_destination() {
        let chain = expected_chain(Path::new("/Users/x/Library/CloudStorage/GoogleDrive-a@b.c/My Drive"), "Shotly");
        assert_eq!(chain, vec!["Shotly".to_string(), "My Drive".to_string()]);
    }

    /// The query itself, against a database with Drive's shape.
    ///
    /// Worth the trouble of building one: the recursive statement is the part
    /// that would break silently if Drive renamed a column, and a test that
    /// only exercised the Rust either side would go on passing while every link
    /// in the app quietly stopped working.
    #[test]
    fn the_query_reads_a_drive_shaped_index() {
        let dir = tempfile::tempdir().expect("temp dir");
        let db = dir.path().join("metadata_sqlite_db");
        let setup = "
            CREATE TABLE items (stable_id INTEGER, id TEXT, trashed INTEGER, is_folder INTEGER, local_title TEXT);
            CREATE TABLE stable_parents (item_stable_id INTEGER, parent_stable_id INTEGER, local_title_hash INTEGER);
            INSERT INTO items VALUES (101,'root',0,1,'My Drive'),
                                     (131,'folderA',0,1,'Shotly'),
                                     (177,'folderB',0,1,'Shotly'),
                                     (269,'FILEID',0,0,'clip.mov'),
                                     (270,'GONE',1,0,'clip.mov');
            INSERT INTO stable_parents VALUES (131,101,0),(177,101,0),(269,177,0),(270,131,0);
        ";
        let status = Command::new("/usr/bin/sqlite3")
            .arg(&db)
            .arg(setup)
            .status()
            .expect("sqlite3 should run");
        assert!(status.success());

        let rungs = walk(&db, "clip.mov").expect("the query should run");
        let expected = vec!["Shotly".to_string(), "My Drive".to_string()];
        assert_eq!(matching(rungs, &expected), Some("FILEID".to_string()));

        // A name nobody has is not an error, it is an empty answer.
        assert!(matching(walk(&db, "absent.png").expect("query"), &expected).is_none());
    }
}
