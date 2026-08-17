//! Signing in to Google, for the one thing a file copy cannot do.
//!
//! `drive.rs` can find a capture's Drive id without any of this. What it cannot
//! do is *share* it — permissions live on Google's servers, and only the API
//! can set them. So this module exists to get an access token and nothing else.
//!
//! The flow is the one Google specifies for an installed app: a loopback
//! redirect with PKCE. No client secret is trusted to keep anything (it cannot,
//! in an app anyone can unzip); the proof is the code verifier, which never
//! leaves this process, and the redirect is to `127.0.0.1` on a port the OS
//! hands out for the occasion, so nothing off this machine can intercept it.
//!
//! **What is stored, and where.** A refresh token, in the login keychain. It is
//! a long-lived credential for the user's whole Drive, which is exactly why it
//! does not go in a JSON file next to the settings. Access tokens are held in
//! memory for their hour and never written down.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// What Shotly asks Google for.
///
/// The narrow one. `drive.file` covers only what this app itself creates: the
/// Shotly folder it makes in your Drive and the captures it uploads there.
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

/// The keychain entry: one service, two accounts.
const SERVICE: &str = "com.skuirrels.shotly";
const REFRESH_KEY: &str = "google-refresh-token";

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

/// The OAuth client, which a released build always has.
///
/// There is deliberately no way to set one from inside the app. Asking a user
/// for a client id is asking them to make a Google Cloud project, and that is
/// the thing this whole rewrite exists to delete.
#[derive(Clone, serde::Serialize, Deserialize)]
pub struct Client {
    pub id: String,
    pub secret: String,
}

fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, key).map_err(|e| format!("no keychain access: {e}"))
}

fn read(key: &str) -> Option<String> {
    entry(key).ok()?.get_password().ok()
}

fn write(key: &str, value: &str) -> Result<(), String> {
    entry(key)?.set_password(value).map_err(|e| format!("could not use the keychain: {e}"))
}

fn forget(key: &str) {
    if let Ok(entry) = entry(key) {
        let _ = entry.delete_credential();
    }
}

pub fn client() -> Option<Client> {
    Some(Client {
        id: BUILT_IN_ID?.to_string(),
        secret: BUILT_IN_SECRET?.to_string(),
    })
}

/// Whether this build carries a client of its own, and so needs nothing set up.
pub fn built_in() -> bool {
    BUILT_IN_ID.is_some() && BUILT_IN_SECRET.is_some()
}

pub fn connected() -> bool {
    read(REFRESH_KEY).is_some()
}

pub fn disconnect() {
    forget(REFRESH_KEY);
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

fn exchange(client: &Client, form: &[(&str, &str)]) -> Result<TokenReply, String> {
    let reply = ureq::post(TOKEN_URL)
        .send_form(form.to_vec())
        .map_err(|e| format!("could not reach Google: {e}"))?
        .body_mut()
        .read_to_string()
        .map_err(|e| format!("could not read Google's reply: {e}"))?;

    serde_json::from_str::<TokenReply>(&reply).map_err(|_| {
        // Google's errors are JSON too, and the useful half is the description.
        #[derive(Deserialize)]
        struct Failure {
            error: String,
            #[serde(default)]
            error_description: String,
        }
        match serde_json::from_str::<Failure>(&reply) {
            Ok(f) if !f.error_description.is_empty() => {
                format!("Google refused: {}", f.error_description)
            }
            Ok(f) => format!("Google refused: {}", f.error),
            Err(_) => format!("Google's reply made no sense: {}", reply.chars().take(200).collect::<String>()),
        }
    })
    .inspect(|_| {
        let _ = client;
    })
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

    let reply = exchange(
        &client,
        &[
            ("client_id", client.id.as_str()),
            ("client_secret", client.secret.as_str()),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect.as_str()),
        ],
    )?;

    let refresh = reply.refresh_token.ok_or(
        "Google did not send a refresh token. Remove Shotly at myaccount.google.com/permissions and connect again.",
    )?;
    write(REFRESH_KEY, &refresh)?;
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
    let refresh = read(REFRESH_KEY).ok_or("Connect Google Drive in Settings first.")?;

    let reply = exchange(
        &client,
        &[
            ("client_id", client.id.as_str()),
            ("client_secret", client.secret.as_str()),
            ("refresh_token", refresh.as_str()),
            ("grant_type", "refresh_token"),
        ],
    )
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
                assert!(built_in());
                assert!(client().is_some());
                assert!(
                    id.ends_with(".apps.googleusercontent.com"),
                    "SHOTLY_GOOGLE_CLIENT_ID does not look like a Google client id: {id}",
                );
            }
            _ => {
                assert!(!built_in());
                assert!(client().is_none(), "no client should exist without the environment");
            }
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
