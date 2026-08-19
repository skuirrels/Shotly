# Releasing Shotly

Shotly updates itself. This document is the contract that makes that safe: get
it wrong and the failure lands on machines you cannot reach.

## The short version

```bash
npm run bump -- 0.2.0
$EDITOR CHANGELOG.md          # bump opened the section; say what changed
git commit -am "Shotly 0.2.0"
git push
npm run publish
```

`publish` builds, then refuses to upload anything that would break an existing
install. Read [What can go wrong](#what-can-go-wrong) before overriding it.

## The changelog

`CHANGELOG.md` is not a courtesy — it is where the release notes come from.
`bump` opens a section for the new version, pre-filled with the commit subjects
since the last tag; you edit it into something a user would want to read.
`publish` then puts that section into two places: the GitHub release's notes,
and `notes` in `latest.json`, which is the "what's new" list the in-app update
notice shows when the download lands.

Publishing a version with nothing written under its heading is refused, for the
same reason the other checks exist — a changelog kept up to date when somebody
remembers is one that stops three releases in. `--notes "…"` is the way past it
for a release that genuinely has nothing to say.

## How updating works

There are three moving parts and no server.

1. **The manifest.** `scripts/publish.mjs` writes a `latest.json` describing the
   newest version and uploads it as a release asset. The app fetches it from
   `https://github.com/skuirrels/shotly/releases/latest/download/latest.json` —
   a URL that never changes, because GitHub redirects `releases/latest` to
   whichever release is currently marked latest.

2. **The payload.** `createUpdaterArtifacts` in `tauri.conf.json` makes the
   bundler emit `Shotly.app.tar.gz` next to the `.app`, and sign it with a
   [minisign](https://jedisct1.github.io/minisign/) key. The public half is
   baked into `tauri.conf.json`; the app will not install a tarball that does
   not verify against it. Someone who compromised the GitHub release still
   could not push code to Shotly users.

3. **The client.** `src-tauri/src/update.rs` checks twenty seconds after launch
   and every six hours after that, downloads and installs anything newer, and
   tells the editor window so it can offer a relaunch. The tray's
   **Check for Updates…** runs the same code and reports its result either way.

The update is applied to the bundle on disk immediately; it takes effect on the
next launch. Nothing restarts without the user clicking **Relaunch now**.

## The signing key

The minisign keypair lives outside the repository, at `~/.tauri/shotly.key`,
mode `600`. `npm run release` passes it via `TAURI_SIGNING_PRIVATE_KEY_PATH`.

It has **no passphrase**. For a single maintainer building on one machine, the
passphrase would have to be stored next to the key or typed into every build,
and neither buys anything against an attacker who can already read the file.
If releases ever move to CI, generate a fresh key *with* a passphrase and keep
both halves in the runner's secret store.

**Back this file up.** Losing it means no existing installation can ever be
updated again — every user has the old public key compiled in, and would have
to download a new build by hand. Recreating it is not possible; you can only
generate a different one:

```bash
npx tauri signer generate -w ~/.tauri/shotly.key -p ''
# then paste the .pub contents into tauri.conf.json → plugins.updater.pubkey
```

## Code signing and the Screen Recording grant

macOS ties the Screen Recording permission to the app's **designated
requirement**, which includes the signing certificate. An update signed by a
different identity is, as far as TCC is concerned, a different app: it loses
the grant, and capture silently stops working until the user re-authorises it
in System Settings.

So the identity must stay stable across releases. `npm run release` defaults to
the self-signed `Shotly Local Signing` certificate (see the README for how to
recreate it), and `publish.mjs` records which identity each release used in
`scripts/.last-signing-authority`. If the next release does not match, it stops.

Switching to a Developer ID certificate is worth doing — it is what removes the
Gatekeeper warning on first download — but it is a one-time break for existing
users and should be announced in the release notes:

```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" npm run release
node scripts/publish.mjs --allow-identity-change --notes "..."
```

## The Google client

Sharing to Drive needs an OAuth client, and a release build carries one so that
nobody who installs Shotly ever sees a Google Cloud console. It is **not in the
repository**: it comes from the environment at compile time, through
`option_env!` in `share/gauth.rs`.

`npm run publish` will not proceed until Google itself confirms the client
exists — `scripts/check-google-client.mjs` redeems a deliberately nonsense
authorization code and requires the answer to be `invalid_grant` ("your code is
rubbish") rather than `invalid_client` ("who are you?"). That check exists
because **0.9.3 shipped with placeholder credentials**: they were the right
shape, a format check passed them, and the release looked healthy until the
first person pressed Copy link. Only Google can tell an invented client from a
real one, so only Google is asked.

Put them in `.env.release`, which `npm run release` and `npm run bundle` source
and `.gitignore` excludes:

```bash
cp .env.release.example .env.release   # then fill in the two values
npm run publish
```

A build without it falls back to a client left in the keychain by an older
version of Shotly, which is why the machine this is developed on needs nothing
done to it. Failing both, Settings says there is nothing to connect to.

There is deliberately **no way to enter a client from inside the app** any more.
That was the previous design and it meant every user making a Google Cloud
project before they could send one link — the developer's job, handed to
everyone who installed it.

The client is a **Desktop app** client, and the scope Shotly requests is
`drive.file` — non-sensitive, so the consent screen is the ordinary one and the
project needs no security assessment. Two things have to be true of it:

* The consent screen is **published**, not in Testing. Two separate failures
  follow from leaving it in Testing, and the second one is the nastier:
  1. Only accounts on the test-user list can connect; everyone else gets
     `Error 403: access_denied`.
  2. **Refresh tokens issued by a Testing client are revoked after seven days.**
     Sharing works all week and then everybody is silently signed out, with
     `invalid_grant` on the next refresh. Nothing in the app can prevent this —
     it is Google protecting users from unverified apps — and no amount of
     reconnecting fixes it for longer than another week. Publishing does.
* Brand details are filled in — app name, icon, homepage, privacy policy —
  because that name and icon are what the consent screen shows the user.

Rotating the client is a rebuild: the secret is compiled in. Anyone already
connected stays connected until they disconnect, since their refresh token
belongs to the old client and will fail on the next refresh with
`invalid_grant`, which `gauth` handles by disconnecting them cleanly.

## What can go wrong

**Publishing a version that is already out.** `publish.mjs` refuses to
overwrite a published release, because anyone who had already updated would be
left running a different binary under a version number they think they have.
Bump instead.

**Publishing an unpushed commit.** Refused, so the tag always names a commit
GitHub can show, and the source at that tag is the source the binary was built
from.

**Forgetting the changelog.** Refused: `publish` will not ship a version whose
section in `CHANGELOG.md` is missing or still holds nothing but the empty
bullet `bump` left. Whoever gets the update sees that section, so an empty one
would ship as an empty "what's new".

**Forgetting `npm run bump`.** The updater compares the manifest's version to
the version compiled into the running app. Ship 0.2.0's code under 0.1.0's
version number and no one is ever offered it.

**An Intel Mac.** The manifest only carries `darwin-aarch64`, matching what we
build. An Intel Mac finds no entry and is told it is up to date — which is
correct, in that there is nothing it could install.

**A read-only install location.** The updater writes over `Shotly.app` in
place. Running from a disk image, or from a directory the user cannot write to,
fails — the editor shows the error rather than swallowing it.

## Verifying a release actually works

The one test that matters cannot be done from the build machine alone, because
the running app must be *older* than the release:

1. Publish version N.
2. `npm run bump -- <N-1>` locally and `npm run bundle` to install an older
   build into `/Applications`. (Then bump back — do not commit it.)
3. Launch it, and use **Check for Updates…** from the tray.
4. Expect: download progress, then "Shotly N is installed". Click **Relaunch
   now**, then confirm the version in the About panel — and press ⌃⇧4 to
   confirm the Screen Recording grant survived.
