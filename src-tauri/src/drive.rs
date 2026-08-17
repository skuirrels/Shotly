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

use tauri::{AppHandle, Emitter, Manager};

/// Where Drive for desktop keeps its index, under the home directory.
const DRIVEFS: &str = "Library/Application Support/Google/DriveFS";

/// The file inside each account folder.
const INDEX: &str = "metadata_sqlite_db";

/// How deep a parent walk may go before it is a loop rather than a path.
const MAX_DEPTH: usize = 12;

/// One row of the parent walk: the same file, at one level of its chain.
#[derive(Debug, PartialEq, Clone)]
struct Rung {
    /// The file the walk started from — the same on every rung of one chain.
    id: String,
    depth: usize,
    name: String,
    /// The Drive id of *this* rung: the file at depth 0, its folder at 1.
    own_id: String,
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
        "WITH RECURSIVE up(stable_id, id, depth, name, own_id) AS (
             SELECT stable_id, id, 0, local_title, id FROM items
              WHERE local_title = {name} AND trashed = 0 AND is_folder = 0
             UNION ALL
             SELECT p.parent_stable_id,
                    up.id,
                    up.depth + 1,
                    (SELECT local_title FROM items WHERE stable_id = p.parent_stable_id),
                    (SELECT id FROM items WHERE stable_id = p.parent_stable_id)
               FROM up JOIN stable_parents p ON p.item_stable_id = up.stable_id
              WHERE up.depth < {MAX_DEPTH}
         )
         SELECT id, depth, name, own_id FROM up WHERE name IS NOT NULL;",
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
            let own_id = parts.next()?.to_string();
            (!id.is_empty()).then_some(Rung { id, depth, name, own_id })
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
fn matching(rungs: Vec<Rung>, expected: &[String]) -> Option<Vec<Rung>> {
    let mut by_id: std::collections::HashMap<String, Vec<Rung>> = std::collections::HashMap::new();
    for rung in rungs {
        by_id.entry(rung.id.clone()).or_default().push(rung);
    }

    let mut found: Option<Vec<Rung>> = None;
    for (_, mut chain) in by_id {
        chain.sort_by_key(|r| r.depth);
        // Rung 0 is the file itself; the folders start above it.
        let folders: Vec<&str> = chain.iter().skip(1).map(|r| r.name.as_str()).collect();
        if !folders.starts_with(&expected.iter().map(|s| s.as_str()).collect::<Vec<_>>()[..]) {
            continue;
        }
        if found.is_some() {
            return None;
        }
        found = Some(chain);
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

/// Make `id` readable by anyone who has the link.
///
/// The one thing the local index cannot do, and the whole reason `gauth.rs`
/// exists: permissions live on Google's servers. Idempotent — asking twice for
/// the same permission is not an error, and Drive answers the second one the
/// same way it answered the first.
fn share(id: &str) -> Result<(), String> {
    let token = crate::gauth::token()?;
    let reply = ureq::post(&format!(
        "https://www.googleapis.com/drive/v3/files/{id}/permissions?supportsAllDrives=true"
    ))
    .header("Authorization", &format!("Bearer {token}"))
    .send_json(serde_json::json!({ "role": "reader", "type": "anyone" }));

    match reply {
        Ok(_) => Ok(()),
        Err(ureq::Error::StatusCode(403)) => Err(
            "Google refused: this account cannot share that file. If it is in a Shared Drive, its \
             admin may have link sharing switched off."
                .into(),
        ),
        Err(ureq::Error::StatusCode(404)) => {
            Err("Google has no such file — it may still be uploading.".into())
        }
        Err(e) => Err(format!("could not set sharing: {e}")),
    }
}

/// Whether Shotly can set sharing itself — an account is connected.
#[tauri::command]
pub fn drive_connected() -> bool {
    crate::gauth::connected()
}

/// A link, and whether it was made to work.
///
/// The distinction is the whole difference between the two ways of doing this,
/// and the caller has to say which one happened: an unshared link is correct
/// and useless to the person you send it to.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub url: String,
    /// True when Shotly set anyone-with-the-link on it just now.
    pub shared: bool,
}

/// A link to the backed-up copy of `name`, or why there isn't one.
#[tauri::command]
pub async fn drive_link(app: AppHandle, path: String) -> Result<Link, String> {
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

    // With an account connected, the link is made to *work* before it is
    // handed over: the file is set to anyone-with-the-link first, so what lands
    // on the clipboard opens for whoever it is sent to. Without one, the link
    // is still correct — it just opens for nobody but its owner until the
    // folder is shared by hand, which is what the caller's wording reflects.
    let connected = crate::gauth::connected();

    tauri::async_runtime::spawn_blocking(move || {
        for index in indexes(&home) {
            if let Some(chain) = matching(walk(&index, &name)?, &expected) {
                let id = &chain[0].own_id;
                if connected {
                    share(id)?;
                }
                return Ok(Link {
                    url: format!("https://drive.google.com/file/d/{id}/view?usp=sharing"),
                    shared: connected,
                });
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

/// A link to the folder the backup writes into, for setting its sharing once.
///
/// Found through a file rather than by name, and that is not fussiness: this
/// machine has two folders called `Shotly` directly under My Drive, so a search
/// by name is ambiguous by construction. A capture that is definitely *in* the
/// right one names its own parent, which cannot be.
#[tauri::command]
pub async fn drive_folder_link(app: AppHandle) -> Result<String, String> {
    let settings = crate::backup::load(&app);
    let destination = settings
        .destination
        .filter(|_| settings.enabled)
        .ok_or("Turn on Backup in Settings first.")?;

    let destination = PathBuf::from(destination);
    if !destination.to_string_lossy().contains("GoogleDrive") {
        return Err("The backup folder is not in Google Drive.".into());
    }

    // Any backed-up capture will do; the newest is the likeliest to have
    // finished uploading.
    let folder = destination.join(crate::backup::FOLDER);
    let mut names: Vec<String> = std::fs::read_dir(&folder)
        .map_err(|_| "Nothing has been backed up yet — run Back Up Now first.".to_string())?
        .flatten()
        .filter(|e| e.path().is_file())
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|n| !n.starts_with('.'))
        .collect();
    names.sort();
    names.reverse();
    if names.is_empty() {
        return Err("Nothing has been backed up yet — run Back Up Now first.".into());
    }

    let home = app.path().home_dir().map_err(|e| format!("no home directory: {e}"))?;
    let expected = expected_chain(&destination, crate::backup::FOLDER);

    tauri::async_runtime::spawn_blocking(move || {
        for index in indexes(&home) {
            for name in &names {
                if let Some(chain) = matching(walk(&index, name)?, &expected) {
                    // Rung 1 is the folder the file sits in — the one to share.
                    if let Some(rung) = chain.get(1) {
                        let id = &rung.own_id;
                        return Ok(format!("https://drive.google.com/drive/folders/{id}"));
                    }
                }
            }
        }
        Err("Google Drive hasn't finished uploading these yet. Give it a moment.".into())
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
        let rows = "abc\u{1}0\u{1}shot.png\u{1}abc\nrubbish\n\u{1}1\u{1}Shotly\u{1}f\nabc\u{1}1\u{1}Shotly\u{1}folder\n";
        assert_eq!(
            parse(rows),
            vec![
                Rung { id: "abc".into(), depth: 0, name: "shot.png".into(), own_id: "abc".into() },
                Rung { id: "abc".into(), depth: 1, name: "Shotly".into(), own_id: "folder".into() },
            ],
        );
    }

    fn rung(id: &str, depth: usize, name: &str) -> Rung {
        Rung { id: id.into(), depth, name: name.into(), own_id: format!("{id}-{depth}") }
    }

    /// The file's own id, for the tests that only care which chain won.
    fn leaf(found: Option<Vec<Rung>>) -> Option<String> {
        found.map(|chain| chain[0].own_id.clone())
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
        assert_eq!(leaf(matching(rungs, &expected)), Some("wanted-0".to_string()));

        // And the rung above it is the folder — what `drive_folder_link` sends
        // you to in order to share the lot in one go.
        let again = vec![
            rung("wanted", 0, "clip.mov"),
            rung("wanted", 1, "Shotly"),
            rung("wanted", 2, "My Drive"),
        ];
        let chain = matching(again, &expected).expect("a chain");
        assert_eq!(chain[1].own_id, "wanted-1");
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
        let chain = matching(rungs, &expected).expect("the file's chain");
        assert_eq!(chain[0].own_id, "FILEID");
        // The folder to share, resolved through the file rather than by name —
        // there are two called Shotly in this fixture, exactly as in the real
        // Drive this was written against.
        assert_eq!(chain[1].own_id, "folderB");

        // A name nobody has is not an error, it is an empty answer.
        assert!(matching(walk(&db, "absent.png").expect("query"), &expected).is_none());
    }
}

// ------------------------------------------------------------- uploading

/// The folder Shotly makes in your Drive, and everything it may ever touch.
const UPLOAD_FOLDER: &str = "Shotly";

/// How much is sent per request, and so how often progress moves.
///
/// Google requires resumable chunks to be a multiple of 256 KB. Eight megabytes
/// is large enough that the per-request overhead disappears on a fast line and
/// small enough that a 300 MB recording reports progress forty times rather
/// than twice.
const CHUNK: usize = 8 * 1024 * 1024;

fn api(token: &str, method: &str, url: &str) -> ureq::RequestBuilder<ureq::typestate::WithBody> {
    let request = match method {
        "POST" => ureq::post(url),
        "PATCH" => ureq::patch(url),
        _ => ureq::put(url),
    };
    request.header("Authorization", &format!("Bearer {token}"))
}

/// The id of Shotly's folder, making it if this is the first time.
///
/// `drive.file` means the app can only see what it created, so this cannot
/// accidentally find and fill up a folder of the user's called Shotly — the
/// query is scoped to the app's own files by Google, not by us.
fn folder(token: &str) -> Result<String, String> {
    let query = urlencoding(&format!(
        "mimeType = 'application/vnd.google-apps.folder' and name = '{UPLOAD_FOLDER}' \
         and trashed = false"
    ));
    let found = ureq::get(&format!(
        "https://www.googleapis.com/drive/v3/files?q={query}&fields=files(id)&pageSize=1"
    ))
    .header("Authorization", &format!("Bearer {token}"))
    .call()
    .map_err(|e| format!("could not ask Drive for the folder: {e}"))?
    .body_mut()
    .read_to_string()
    .map_err(|e| e.to_string())?;

    #[derive(serde::Deserialize)]
    struct Listing {
        #[serde(default)]
        files: Vec<Entry>,
    }
    #[derive(serde::Deserialize)]
    struct Entry {
        id: String,
    }

    if let Some(entry) = serde_json::from_str::<Listing>(&found).ok().and_then(|l| l.files.into_iter().next())
    {
        return Ok(entry.id);
    }

    let made = api(token, "POST", "https://www.googleapis.com/drive/v3/files?fields=id")
        .send_json(serde_json::json!({
            "name": UPLOAD_FOLDER,
            "mimeType": "application/vnd.google-apps.folder",
        }))
        .map_err(|e| format!("could not make the Shotly folder: {e}"))?
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())?;

    serde_json::from_str::<Entry>(&made)
        .map(|e| e.id)
        .map_err(|_| "Drive did not say what it made".to_string())
}

/// Send `path` to Drive in chunks, reporting how far it has got.
///
/// Resumable rather than a single POST, for the reason the whole feature
/// exists: these are recordings, and a 300 MB upload that fails at 90% with no
/// progress shown is the worst of both worlds.
fn upload(
    token: &str,
    path: &Path,
    parent: &str,
    mut progress: impl FnMut(u64, u64),
) -> Result<String, String> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let total = std::fs::metadata(path).map_err(|e| e.to_string())?.len();

    let start = api(
        token,
        "POST",
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink",
    )
    .send_json(serde_json::json!({ "name": name, "parents": [parent] }))
    .map_err(|e| format!("could not start the upload: {e}"))?;

    let session = start
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .ok_or("Drive did not offer somewhere to upload to")?
        .to_string();

    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut sent: u64 = 0;
    let mut buffer = vec![0u8; CHUNK];

    while sent < total {
        let want = CHUNK.min((total - sent) as usize);
        file.seek(SeekFrom::Start(sent)).map_err(|e| e.to_string())?;
        file.read_exact(&mut buffer[..want]).map_err(|e| e.to_string())?;

        let last = sent + want as u64 - 1;
        let reply = ureq::put(&session)
            .header("Content-Length", &want.to_string())
            .header("Content-Range", &format!("bytes {sent}-{last}/{total}"))
            .send(&buffer[..want]);

        match reply {
            // 200/201: the last chunk landed and Drive described the file.
            Ok(mut done) => {
                let body = done.body_mut().read_to_string().map_err(|e| e.to_string())?;
                #[derive(serde::Deserialize)]
                struct Made {
                    id: String,
                }
                progress(total, total);
                return serde_json::from_str::<Made>(&body)
                    .map(|m| m.id)
                    .map_err(|_| "Drive did not say what it stored".to_string());
            }
            // 308: this chunk landed, keep going. ureq reports it as an error
            // because it is not 2xx, which it very much is not — it is Drive
            // asking for the rest.
            Err(ureq::Error::StatusCode(308)) => {
                sent += want as u64;
                progress(sent, total);
            }
            Err(e) => return Err(format!("the upload failed at {sent} of {total} bytes: {e}")),
        }
    }

    Err("the upload finished without Drive confirming it".into())
}

/// Percent-encode a Drive query.
fn urlencoding(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

/// Upload a capture to Drive, share it, and hand back the link.
///
/// The whole of what "send this to someone" means, in one command: no backup
/// required, no Drive for desktop required, and nothing of yours visible to
/// Shotly but the file you chose to send.
#[tauri::command]
pub async fn drive_share(app: AppHandle, path: String) -> Result<Link, String> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err("That capture is not on this disk any more.".into());
    }

    let reporter = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let token = crate::gauth::token()?;
        let parent = folder(&token)?;

        let id = upload(&token, &source, &parent, |sent, total| {
            let _ = reporter.emit(
                "drive:progress",
                serde_json::json!({ "sent": sent, "total": total }),
            );
        })?;

        share(&id)?;
        Ok(Link {
            url: format!("https://drive.google.com/file/d/{id}/view?usp=sharing"),
            shared: true,
        })
    })
    .await
    .map_err(|e| format!("the upload failed: {e}"))?
}

// ------------------------------------------------------------ the account

/// Whether an OAuth client has been set up at all.
///
/// Shotly ships without one — see `gauth::Client` — so the Settings pane has to
/// ask for it before it can offer to connect anything.
#[tauri::command]
pub fn drive_has_client() -> bool {
    crate::gauth::client().is_some()
}

#[tauri::command]
pub fn drive_set_client(id: String, secret: String) -> Result<(), String> {
    let (id, secret) = (id.trim().to_string(), secret.trim().to_string());
    if id.is_empty() || secret.is_empty() {
        return Err("Both the client ID and the client secret are needed.".into());
    }
    if !id.ends_with(".apps.googleusercontent.com") {
        return Err("That does not look like a Google client ID — they end in \
                    .apps.googleusercontent.com".into());
    }
    crate::gauth::set_client(&crate::gauth::Client { id, secret })
}

/// Run the consent flow, and report whether an account is connected after it.
#[tauri::command]
pub async fn drive_connect(app: AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::gauth::connect(|url| {
            use tauri_plugin_opener::OpenerExt;
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|e| format!("could not open your browser: {e}"))
        })?;
        Ok(crate::gauth::connected())
    })
    .await
    .map_err(|e| format!("connecting failed: {e}"))?
}

#[tauri::command]
pub fn drive_disconnect() {
    crate::gauth::disconnect();
}

/// Whether this build carries its own OAuth client, and so needs no setting up.
#[tauri::command]
pub fn drive_built_in_client() -> bool {
    crate::gauth::built_in()
}
