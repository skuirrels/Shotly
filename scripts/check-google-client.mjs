/**
 * Refuse to ship a Google client that Google has never heard of.
 *
 * This exists because 0.9.3 went out with placeholder credentials compiled into
 * it. They were the right *shape* — the id ended `.apps.googleusercontent.com`,
 * the secret began `GOCSPX-` — and a shape check passed them, so the release
 * looked fine right up until the first person pressed Copy link and got
 * `invalid_client`. A format check cannot tell an invented client from a real
 * one. Only Google can, so this asks it.
 *
 * The trick is that the token endpoint distinguishes the two failures for us
 * without needing a browser, a code, or anybody's consent:
 *
 *   - `invalid_client`  the client id/secret pair does not exist. Fatal.
 *   - `invalid_grant`   the client is real; the authorization code we made up
 *                       is not. Exactly what we want to see.
 *
 * So it deliberately redeems a nonsense code and treats "your code is rubbish"
 * as success. Nothing is created, granted or spent.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";

const id = process.env.SHOTLY_GOOGLE_CLIENT_ID;
const secret = process.env.SHOTLY_GOOGLE_CLIENT_SECRET;

const die = (message) => {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
};

if (!id || !secret) {
  die(
    "No Google client in the environment.\n" +
      "    Fill in .env.release — see docs/RELEASING.md. Without it the release\n" +
      "    ships with nothing to connect to and Settings says so.",
  );
}

const reply = await fetch(TOKEN_URL, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: id,
    client_secret: secret,
    // Not a real code, and it does not need to be: reaching the point where
    // Google objects to the *code* means it has already accepted the client.
    code: "shotly-preflight-not-a-real-code",
    grant_type: "authorization_code",
    redirect_uri: "http://127.0.0.1",
  }),
}).catch((e) => die(`Could not reach Google to check the client: ${e.message}`));

const body = await reply.json().catch(() => ({}));

switch (body.error) {
  case "invalid_grant":
    // Google accepted the client and rejected the made-up code. Correct.
    console.log(`  ✓ Google client verified  (${id.slice(0, 12)}…)`);
    break;

  case "invalid_client":
    die(
      "Google does not recognise this OAuth client.\n" +
        `    id ends: …${id.slice(-34)}\n` +
        "    The id is probably truncated or from a deleted client. Copy both\n" +
        "    values again from console.cloud.google.com/auth/clients — the id's\n" +
        "    random middle section is 32 characters, not 16.",
    );
    break;

  case "unauthorized_client":
    die(
      "The client exists but is not allowed this grant type.\n" +
        "    It is probably not a Desktop app client. Check its type in the\n" +
        "    Cloud console; Shotly needs the loopback flow a Desktop client has.",
    );
    break;

  default:
    die(
      `Google answered something unexpected: ${JSON.stringify(body).slice(0, 300)}\n` +
        "    Not shipping a client that cannot be verified.",
    );
}
