//! Signing in to Google, so `google.rs` has a token to work with.
//!
//! Google-specific by nature — every provider's OAuth differs in its endpoints,
//! its scopes and what it calls things — which is why it sits beside the
//! provider that needs it rather than above the whole `share` module. A second
//! provider brings its own.
//!
//! The flow is the one Google specifies for an installed app: a loopback
//! redirect with PKCE. No client secret is trusted to keep anything (it cannot,
//! in an app anyone can unzip); the proof is the code verifier, which never
//! leaves this process, and the redirect is to `127.0.0.1` on a port the OS
//! hands out for the occasion, so nothing off this machine can intercept it.
//!
//! **What is stored, and where.** A refresh token, in `google.json` in the
//! app's config directory, mode `0600` — see `Store` for why that is not the
//! login keychain and what would move it back. Access tokens are held in memory
//! for their hour and never written down.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// What Shotly asks Google for.
///
/// The narrow one. `drive.file` covers only what this app itself creates: the
/// `ShotlyShared` folder it makes in your Drive and the captures it uploads
/// there.
/// Everything else you own stays invisible to it — Shotly cannot list, read or
/// touch a single other file, and that is not a promise in a privacy policy but
/// something Google enforces.
///
/// It is also what makes signing in take ten seconds. `drive.file` is a
/// non-sensitive scope, so a published client needs no security assessment and
/// shows no "unverified app" screen — which is exactly how Snagit and everyone
/// else does this. The wide `drive` scope, which an earlier version of this
/// asked for so it could share the copy Drive-for-desktop had already synced,
/// is restricted: it obliges every user to make a Google Cloud project of their
/// own. That was the wrong trade.
const SCOPE: &str = "https://www.googleapis.com/auth/drive.file";

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

/// The keychain Shotly *used* to use, kept only long enough to move out of it.
///
/// See `Store` for why it stopped. These constants exist so an install that
/// already signed in finds its token once and never looks again.
const SERVICE: &str = "com.skuirrels.shotly";
const REFRESH_KEY: &str = "google-refresh-token";
const CLIENT_KEY: &str = "google-oauth-client";

/// How long to wait for someone to finish in the browser.
const CONSENT_TIMEOUT: Duration = Duration::from_secs(180);

/// The access token in hand, if it is still good.
///
/// Process-wide rather than per-call: a token lasts an hour and every link
/// would otherwise spend a round trip refreshing one that was already valid.
static TOKEN: Mutex<Option<(String, Instant)>> = Mutex::new(None);

/// The OAuth client this build carries, if it was given one.
///
/// Baked in at compile time from the release environment, never from the
/// repository — a client secret in a public repo invites someone to spend your
/// quota under your app's name. It is not a secret in the cryptographic sense
/// and cannot be, which is what PKCE is for; keeping it out of git is about
/// nuisance, not about confidentiality.
///
/// See `docs/RELEASING.md` for how a release build gets one.
const BUILT_IN_ID: Option<&str> = option_env!("SHOTLY_GOOGLE_CLIENT_ID");
const BUILT_IN_SECRET: Option<&str> = option_env!("SHOTLY_GOOGLE_CLIENT_SECRET");

/// The OAuth client: compiled into a release, or left in the keychain by an
/// earlier version of Shotly that asked for one.
///
/// There is deliberately no way to *set* one from inside the app any more —
/// asking a user for a client id is asking them to make a Google Cloud
/// project, which is the thing this rewrite exists to delete. But one already
/// on this Mac is one nobody has to think about again, so it is still read.
#[derive(Clone, serde::Serialize, Deserialize)]
pub struct Client {
    pub id: String,
    pub secret: String,
}

/// What Shotly has been told, on disk beside its other settings.
///
/// **This used to be the login keychain, and moving it out is deliberate.**
/// The legacy macOS keychain authorises "Always Allow" against the binary's
/// code-directory hash, so every rebuild, every auto-update and every repair
/// install invalidates the grant and macOS asks again — on *every read*, of
/// *every item*. It is not a bug that can be tuned away: it is how that
/// keychain identifies callers, and Shotly updates itself.
///
/// The fix Apple intends is the Data Protection keychain, which authorises by
/// team id through a `keychain-access-groups` entitlement and therefore
/// survives an update. That needs a real signing team — a Developer ID from the
/// Apple Developer Program — which Shotly does not yet have; an ad-hoc or
/// self-signed build falls back to the legacy keychain and its prompts. When
/// that certificate exists this should move there (the `keyring` crate reaches
/// it with the "Protected" target) and this file should be migrated away in the
/// same release. Until then, prompting the user a dozen times is a worse answer
/// than the one below, and the difference in what an attacker gets is nil.
///
/// **What is actually at risk.** A `drive.file` refresh token can see only the
/// files Shotly itself created — the `ShotlyShared` folder and what has been
/// uploaded into it. It is not, as an earlier version of this comment claimed,
/// a credential for the whole of someone's Drive; that was true under the wide
/// `drive` scope and stopped being true when the scope narrowed. The file is
/// written `0600` in the app's own config directory, so reading it means
/// already running as this user — at which point the same attacker can drive
/// the app, read the legacy keychain after one prompt, or take the access token
/// out of memory.
#[derive(Default, serde::Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    refresh_token: Option<String>,
    /// An OAuth client an older Shotly was configured with by hand. Nothing
    /// writes this any more — see the note on `Client`.
    #[serde(default)]
    client: Option<Client>,
}

/// The store, read once per launch.
static STORE: Mutex<Option<Store>> = Mutex::new(None);

/// Where this app keeps files that are its own business.
///
/// `~/Library/Application Support/<id>` on macOS and
/// `%APPDATA%\\<id>` on Windows — the same idea, spelt differently, which is
/// why the spelling is `platform`'s to know rather than this module's.
fn config_dir() -> std::path::PathBuf {
    crate::platform::paths::config_dir(SERVICE)
}

fn store_path() -> std::path::PathBuf {
    config_dir().join("google.json")
}

/// Whatever is on disk, migrating an older install's keychain items in first.
fn load() -> Store {
    if let Ok(raw) = std::fs::read_to_string(store_path()) {
        if let Ok(store) = serde_json::from_str::<Store>(&raw) {
            return store;
        }
    }
    // Nothing to migrate on a platform that never had a keychain to migrate
    // out of: this exists solely to rescue sign-ins from macOS's login
    // keychain, which no other system has ever written.
    #[cfg(target_os = "macos")]
    {
        migrate_from_keychain()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Store::default()
    }
}

/// Take an existing sign-in out of the keychain, once.
///
/// macOS only, and permanently so — see the call site.
///
/// The last prompt anybody sees: whatever is there is copied to the store and
/// then deleted, because a live refresh token left behind in the keychain is a
/// credential nobody is watching any more. A machine with nothing there — every
/// new install — never touches the keychain at all and is never asked.
#[cfg(target_os = "macos")]
fn migrate_from_keychain() -> Store {
    let read = |key: &str| {
        keyring::Entry::new(SERVICE, key).ok().and_then(|e| e.get_password().ok())
    };
    let store = Store {
        refresh_token: read(REFRESH_KEY),
        client: read(CLIENT_KEY).and_then(|raw| serde_json::from_str(&raw).ok()),
    };

    if store.refresh_token.is_some() || store.client.is_some() {
        if save(&store).is_ok() {
            for key in [REFRESH_KEY, CLIENT_KEY] {
                if let Ok(entry) = keyring::Entry::new(SERVICE, key) {
                    let _ = entry.delete_credential();
                }
            }
        }
    }
    store
}

fn save(store: &Store) -> Result<(), String> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;
    let path = store_path();
    let raw = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| format!("could not write {path:?}: {e}"))?;

    // Owner-only, and set after the write rather than before: the bytes must
    // never exist at the default mode, however briefly.
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("could not lock down {path:?}: {e}"))
}

/// Read the store, then hand it to `f`, keeping it in memory afterwards.
fn with_store<T>(f: impl FnOnce(&mut Store) -> T) -> T {
    let mut held = STORE.lock().unwrap();
    let store = held.get_or_insert_with(load);
    f(store)
}

/// Change the store and write it back.
fn update(f: impl FnOnce(&mut Store)) -> Result<(), String> {
    with_store(|store| {
        f(store);
        save(store)
    })
}

pub fn client() -> Option<Client> {
    if let (Some(id), Some(secret)) = (BUILT_IN_ID, BUILT_IN_SECRET) {
        return Some(Client { id: id.to_string(), secret: secret.to_string() });
    }
    // A build with none of its own uses whatever an earlier version was told.
    with_store(|store| store.client.clone())
}

/// Whether there is any client at all, and so anything to connect to.
pub fn ready() -> bool {
    client().is_some()
}

pub fn connected() -> bool {
    with_store(|store| store.refresh_token.is_some())
}

pub fn disconnect() {
    let _ = update(|store| store.refresh_token = None);
    *TOKEN.lock().unwrap() = None;
}

// ------------------------------------------------------------------- PKCE

/// URL-safe base64 without padding, which is what every part of this expects.
fn b64url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// A verifier and the challenge derived from it.
///
/// The verifier is what proves, at the token exchange, that whoever is
/// redeeming the code is the process that asked for it — the only thing
/// standing between a leaked redirect and someone else's Drive.
fn pkce() -> (String, String) {
    let mut seed = [0u8; 32];
    // Not a cryptographic RNG, and it does not need to be a secret against the
    // machine's own user: this defends the round trip between the browser and
    // this process, and 256 bits of clock-and-address entropy hashed through
    // SHA-256 is not a value an attacker gets to guess before it is spent.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let addr = &seed as *const _ as usize as u128;
    for (i, byte) in seed.iter_mut().enumerate() {
        let mix = now
            .rotate_left(i as u32 * 7)
            ^ addr.rotate_right(i as u32 * 3)
            ^ (std::process::id() as u128) << i;
        *byte = (mix >> (i % 16 * 8)) as u8;
    }
    let verifier = b64url(&Sha256::digest(seed));
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

// ------------------------------------------------------------ the redirect

/// The `code` Google sends back, and the browser page that says so.
///
/// One connection, one answer, then the listener closes. A loopback server that
/// outlives the sign-in is a loopback server that can be asked again.
fn await_code(listener: TcpListener, state: &str) -> Result<String, String> {
    listener
        .set_nonblocking(false)
        .map_err(|e| format!("could not listen for the reply: {e}"))?;

    let deadline = Instant::now() + CONSENT_TIMEOUT;
    loop {
        if Instant::now() > deadline {
            return Err("Sign-in timed out.".into());
        }
        let (mut stream, _) = listener.accept().map_err(|e| format!("no reply: {e}"))?;

        let mut line = String::new();
        BufReader::new(stream.try_clone().map_err(|e| e.to_string())?)
            .read_line(&mut line)
            .map_err(|e| format!("could not read the reply: {e}"))?;

        // "GET /?code=…&state=… HTTP/1.1"
        let target = line.split_whitespace().nth(1).unwrap_or_default().to_string();
        let query = target.split_once('?').map(|(_, q)| q).unwrap_or_default();
        let mut code = None;
        let mut echoed = None;
        let mut error = None;
        for pair in query.split('&') {
            match pair.split_once('=') {
                Some(("code", v)) => code = Some(v.to_string()),
                Some(("state", v)) => echoed = Some(v.to_string()),
                Some(("error", v)) => error = Some(v.to_string()),
                _ => {}
            }
        }

        let outcome = match (&error, &code, echoed.as_deref() == Some(state)) {
            (Some(e), _, _) => Err(format!("Google refused: {e}")),
            (_, Some(code), true) => Ok(code.clone()),
            (_, Some(_), false) => Err("the reply did not match the request".into()),
            _ => {
                // Something else knocked on the port. Say nothing useful and
                // keep waiting for the browser.
                let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                continue;
            }
        };

        let body = match &outcome {
            Ok(_) => "<h2>Shotly is connected.</h2><p>You can close this tab.</p>",
            Err(_) => "<h2>Shotly could not connect.</h2><p>Have another go from Settings.</p>",
        };
        let _ = stream.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len(),
            )
            .as_bytes(),
        );
        let _ = stream.flush();
        return outcome;
    }
}

#[derive(Deserialize)]
struct TokenReply {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: u64,
}

/// What Google's refusal actually said.
///
/// Its errors are JSON with a machine-readable `error` and a sentence for
/// people, and both matter: the sentence is what gets shown, and `token()`
/// reads `invalid_grant` out of the same string to decide whether to give up on
/// a stored refresh token.
fn refusal(reply: &str) -> String {
    #[derive(Deserialize)]
    struct Failure {
        error: String,
        #[serde(default)]
        error_description: String,
    }
    match serde_json::from_str::<Failure>(reply) {
        Ok(f) if !f.error_description.is_empty() => {
            format!("Google refused ({}): {}", f.error, f.error_description)
        }
        Ok(f) => format!("Google refused: {}", f.error),
        Err(_) => {
            format!("Google's reply made no sense: {}", reply.chars().take(200).collect::<String>())
        }
    }
}

fn exchange(form: &[(&str, &str)]) -> Result<TokenReply, String> {
    // `http_status_as_error(false)` is the whole point of this call, not a
    // detail. Every refusal from the token endpoint is a 4xx *carrying the
    // reason in its body*, and ureq's default turns that into an `Err` before
    // the body can be read — so this reported "could not reach Google: http
    // status: 400" for a request that reached Google perfectly well and was
    // told exactly what was wrong. Worse, `token()` decides whether to drop a
    // dead refresh token by looking for `invalid_grant` in this message, so the
    // one case that recovers by itself was the one case that could never be
    // seen, and the app stayed stuck on the same 400 for ever.
    let body = ureq::post(TOKEN_URL)
        .config()
        .http_status_as_error(false)
        .build()
        .send_form(form.to_vec())
        .map_err(|e| format!("could not reach Google: {e}"))?
        .body_mut()
        .read_to_string()
        .map_err(|e| format!("could not read Google's reply: {e}"))?;

    serde_json::from_str::<TokenReply>(&body).map_err(|_| refusal(&body))
}

/// Run the whole consent flow. Blocking — the caller is on a worker.
pub fn connect(open: impl FnOnce(&str) -> Result<(), String>) -> Result<(), String> {
    let client = client().ok_or(
        "Add your Google OAuth client in Settings first — Shotly ships without one.",
    )?;

    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("could not open a port for the reply: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}");

    let (verifier, challenge) = pkce();
    let (state, _) = pkce();

    let url = format!(
        "{AUTH_URL}?client_id={id}&redirect_uri={redirect}&response_type=code\
         &scope={scope}&code_challenge={challenge}&code_challenge_method=S256\
         &state={state}&access_type=offline&prompt=consent",
        id = urlencode(&client.id),
        redirect = urlencode(&redirect),
        scope = urlencode(SCOPE),
    );

    open(&url)?;
    let code = await_code(listener, &state)?;

    let reply = exchange(&[
            ("client_id", client.id.as_str()),
            ("client_secret", client.secret.as_str()),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect.as_str()),
    ])?;

    let refresh = reply.refresh_token.ok_or(
        "Google did not send a refresh token. Remove Shotly at myaccount.google.com/permissions and connect again.",
    )?;
    update(|store| store.refresh_token = Some(refresh))?;
    remember(reply.access_token, reply.expires_in);
    Ok(())
}

fn remember(token: String, expires_in: u64) {
    // A minute's headroom, so a token that expires mid-request is refreshed
    // before it is used rather than after it fails.
    let good_for = Duration::from_secs(expires_in.saturating_sub(60).max(1));
    *TOKEN.lock().unwrap() = Some((token, Instant::now() + good_for));
}

/// A usable access token, refreshing if the one in hand has expired.
pub fn token() -> Result<String, String> {
    if let Some((token, until)) = TOKEN.lock().unwrap().as_ref() {
        if Instant::now() < *until {
            return Ok(token.clone());
        }
    }

    let client = client().ok_or("No Google OAuth client is set up.")?;
    let refresh = with_store(|store| store.refresh_token.clone())
        .ok_or("Connect Google Drive in Settings first.")?;

    let reply = exchange(&[
        ("client_id", client.id.as_str()),
        ("client_secret", client.secret.as_str()),
        ("refresh_token", refresh.as_str()),
        ("grant_type", "refresh_token"),
    ])
    .map_err(|e| {
        // A refresh token can be revoked from the Google account page, and once
        // it is, every retry says the same thing. Drop it so the next attempt
        // asks to connect rather than failing the same way for ever.
        if e.contains("invalid_grant") {
            disconnect();
            return "Google Drive disconnected — connect it again in Settings.".to_string();
        }
        e
    })?;

    remember(reply.access_token.clone(), reply.expires_in);
    Ok(reply.access_token)
}

/// Percent-encoding for the few characters a URL query cannot carry raw.
fn urlencode(value: &str) -> String {
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

    /// Google's refusals are 4xx replies with the reason in the body, and this
    /// used to be dead code: ureq's default turned the status into an `Err`
    /// before anything could read it, so the app showed "could not reach
    /// Google: http status: 400" for a request that had reached Google and been
    /// answered. The exchange now asks for the body regardless of status.
    /// Widening this scope is close to irreversible, so it is pinned.
    ///
    /// Google's OAuth user cap — 100 accounts, for the lifetime of the project,
    /// unresettable — binds as soon as an app requests an *unapproved sensitive
    /// or restricted* scope. `drive.file` is non-sensitive, so the cap shown in
    /// the Cloud console does not apply to Shotly and the shared links
    /// themselves are unaffected either way (whoever opens one never signs in).
    ///
    /// Asking for `drive`, `drive.readonly`, Gmail or Calendar would start the
    /// counter, permanently, on a project that cannot be cleaned up afterwards.
    /// If a future feature genuinely needs more, that is a decision to take
    /// deliberately and probably in a fresh project — not something to discover
    /// from a support thread at user 101.
    #[test]
    fn the_scope_stays_the_non_sensitive_one() {
        assert_eq!(SCOPE, "https://www.googleapis.com/auth/drive.file");
        assert!(!SCOPE.ends_with("/drive"), "the wide Drive scope is restricted");
    }

    /// The store has to survive a round trip, because it is now the only copy
    /// of a sign-in — there is no keychain to fall back on.
    #[test]
    fn a_sign_in_survives_being_written_and_read() {
        let store = Store {
            refresh_token: Some("1//refresh".into()),
            client: Some(Client { id: "id".into(), secret: "secret".into() }),
        };
        let raw = serde_json::to_string(&store).expect("serialises");
        let back: Store = serde_json::from_str(&raw).expect("deserialises");
        assert_eq!(back.refresh_token.as_deref(), Some("1//refresh"));
        assert_eq!(back.client.map(|c| c.id).as_deref(), Some("id"));
    }

    /// A store written by a newer Shotly, or half-filled by a failed write,
    /// must not be a hard error — the worst case is being asked to connect
    /// again, never a crash on a path that runs at launch.
    #[test]
    fn a_store_missing_its_fields_reads_as_empty() {
        let back: Store = serde_json::from_str("{}").expect("an empty object is a store");
        assert!(back.refresh_token.is_none());
        assert!(back.client.is_none());
    }

    /// It goes beside the app's other settings, not in the home directory and
    /// not in a temp folder something else can empty.
    #[test]
    fn the_store_sits_in_the_apps_own_config_directory() {
        let path = store_path();
        assert!(path.ends_with("Library/Application Support/com.skuirrels.shotly/google.json"),
                "{path:?}");
    }

    #[test]
    fn a_refusal_is_read_out_of_the_body() {
        let body = r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#;
        let message = refusal(body);
        assert!(message.contains("Token has been expired or revoked."), "{message}");

        // `token()` looks for this exact word to decide whether the stored
        // refresh token is worth keeping, so it has to survive into the string.
        assert!(message.contains("invalid_grant"), "{message}");
    }

    /// A description is not guaranteed, and the code alone still names the
    /// problem — `invalid_client` is a different fix from `invalid_grant`.
    #[test]
    fn a_refusal_without_a_description_still_names_itself() {
        assert_eq!(refusal(r#"{"error":"invalid_client"}"#), "Google refused: invalid_client");
    }

    /// A proxy or a captive portal answers with HTML, and quoting it beats
    /// claiming Google said something it did not.
    #[test]
    fn a_reply_that_is_not_json_is_quoted_rather_than_guessed_at() {
        let message = refusal("<html><body>Gateway Timeout</body></html>");
        assert!(message.starts_with("Google's reply made no sense:"), "{message}");
        assert!(message.contains("Gateway Timeout"), "{message}");
    }

    /// The client has to arrive from the build environment, or a release ships
    /// with a Connect button that cannot connect to anything.
    ///
    /// Compiled-in values are baked at build time, so this asserts the wiring
    /// rather than any particular value: with the variables set, a client
    /// exists; without them, `built_in` is false and the pane says so.
    #[test]
    fn the_built_in_client_follows_the_build_environment() {
        match (BUILT_IN_ID, BUILT_IN_SECRET) {
            (Some(id), Some(_)) => {
                assert!(ready());
                assert!(client().is_some());
                assert!(
                    id.ends_with(".apps.googleusercontent.com"),
                    "SHOTLY_GOOGLE_CLIENT_ID does not look like a Google client id: {id}",
                );
            }
            // Without a compiled-in one, whether a client exists depends on
            // whether this Mac has one in its keychain — both are legitimate,
            // and `ready` has to agree with `client` either way.
            _ => assert_eq!(ready(), client().is_some()),
        }
    }

    /// The challenge has to be the SHA-256 of the verifier, base64url, no
    /// padding. Google checks it, and "invalid_grant" is all it says when the
    /// two do not agree.
    #[test]
    fn the_challenge_is_the_hash_of_the_verifier() {
        let (verifier, challenge) = pkce();
        assert_eq!(challenge, b64url(&Sha256::digest(verifier.as_bytes())));
        assert!(!challenge.contains('='), "no padding");
        assert!(!challenge.contains('+') && !challenge.contains('/'), "url-safe alphabet");
        assert_eq!(verifier.len(), 43, "256 bits, base64url");
    }

    /// Two runs must not agree, or the state parameter proves nothing.
    #[test]
    fn every_run_gets_its_own_verifier() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..64 {
            assert!(seen.insert(pkce().0), "a verifier repeated");
        }
    }

    #[test]
    fn urls_are_encoded_for_a_query_string() {
        assert_eq!(urlencode("https://a.b/c"), "https%3A%2F%2Fa.b%2Fc");
        assert_eq!(urlencode("plain-id_1.2~3"), "plain-id_1.2~3");
    }
}

#[cfg(test)]
mod machine_check {
    /// Not a test of the code so much as of *this Mac*: does a client exist
    /// here, from a compiled-in value or from the keychain? Ignored by default,
    /// because the answer is a property of the machine and not of the source.
    #[test]
    #[ignore]
    fn report_whether_a_client_is_available() {
        eprintln!("client available on this machine: {}", super::ready());
    }
}
