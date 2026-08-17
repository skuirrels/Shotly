//! Google Drive, as a [`Provider`].
//!
//! Three calls: find-or-make the folder, upload the file into it, set the file
//! to anyone-with-the-link. The scope is `drive.file`, which means Google
//! itself only ever shows this app the files it created — so "find the folder"
//! cannot stumble onto a folder of yours with the same name, and a bug here
//! cannot reach the rest of your Drive. That is enforced on their side, not by
//! care taken on ours, which is the only kind of limit worth relying on.

use std::path::Path;

use super::{Link, Provider};

/// How much is sent per request, and so how often progress moves.
///
/// Google requires resumable chunks to be a multiple of 256 KB. Eight megabytes
/// is large enough that the per-request overhead disappears on a fast line and
/// small enough that a 300 MB recording reports progress forty times rather
/// than twice.
const CHUNK: usize = 8 * 1024 * 1024;

pub struct Google;

/// The one instance, held by the registry in `mod.rs`.
pub static GOOGLE: Google = Google;

impl Provider for Google {
    fn id(&self) -> &'static str {
        "google"
    }

    fn name(&self) -> &'static str {
        "Google Drive"
    }

    fn available(&self) -> bool {
        super::gauth::ready()
    }

    fn connected(&self) -> bool {
        super::gauth::connected()
    }

    fn connect(&self, open: &dyn Fn(&str) -> Result<(), String>) -> Result<(), String> {
        super::gauth::connect(open)
    }

    fn disconnect(&self) {
        super::gauth::disconnect();
    }

    fn upload(&self, path: &Path, progress: &mut dyn FnMut(u64, u64)) -> Result<Link, String> {
        let token = super::gauth::token()?;
        let parent = folder(&token)?;
        let id = send(&token, path, &parent, progress)?;
        share(&token, &id)?;
        Ok(Link {
            url: format!("https://drive.google.com/file/d/{id}/view?usp=sharing"),
            shared: true,
        })
    }
}

fn api(token: &str, method: &str, url: &str) -> ureq::RequestBuilder<ureq::typestate::WithBody> {
    let request = match method {
        "POST" => ureq::post(url),
        "PATCH" => ureq::patch(url),
        _ => ureq::put(url),
    };
    request.header("Authorization", &format!("Bearer {token}"))
}

/// The id of Shotly's shared folder, making it if this is the first time.
fn folder(token: &str) -> Result<String, String> {
    let name = super::FOLDER;
    let query = urlencoding(&format!(
        "mimeType = 'application/vnd.google-apps.folder' and name = '{name}' and trashed = false"
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

    if let Some(entry) =
        serde_json::from_str::<Listing>(&found).ok().and_then(|l| l.files.into_iter().next())
    {
        return Ok(entry.id);
    }

    let made = api(token, "POST", "https://www.googleapis.com/drive/v3/files?fields=id")
        .send_json(serde_json::json!({
            "name": name,
            "mimeType": "application/vnd.google-apps.folder",
        }))
        .map_err(|e| format!("could not make the {name} folder: {e}"))?
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
fn send(
    token: &str,
    path: &Path,
    parent: &str,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<String, String> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let total = std::fs::metadata(path).map_err(|e| e.to_string())?.len();

    let start = api(
        token,
        "POST",
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id",
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

/// Make `id` readable by anyone who has the link.
///
/// The one thing that cannot be done from this Mac and the whole reason
/// `gauth.rs` exists: permissions live on Google's servers. Idempotent — asking
/// twice for the same permission is not an error, and Drive answers the second
/// one the same way it answered the first.
fn share(token: &str, id: &str) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A query is a string Google parses, and the folder name goes into it.
    #[test]
    fn queries_are_encoded() {
        assert_eq!(urlencoding("name = 'ShotlyShared'"), "name%20%3D%20%27ShotlyShared%27");
    }

    /// Google requires resumable chunks to be a multiple of 256 KB, and gets a
    /// 400 for anything else — a rule easy to break by tuning this constant.
    #[test]
    fn chunks_are_a_multiple_of_256k() {
        assert_eq!(CHUNK % (256 * 1024), 0);
    }
}
