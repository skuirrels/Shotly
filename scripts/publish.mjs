#!/usr/bin/env node
// Publish a built release to GitHub, manifest included.
//
// The updater reads one file — `latest.json` at a fixed URL — and GitHub's
// `releases/latest/download/<asset>` redirect is what makes that URL fixed
// while its contents move with each release. Nothing else needs a server.
//
// Run `npm run publish`, which builds first. This script only uploads what is
// already sitting in the bundle directory, and refuses to upload the wrong
// thing rather than shipping an update nobody can install.
//
// usage: node scripts/publish.mjs [--notes "<markdown>"] [--dry-run]

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "skuirrels/shotly";
const bundle = join(root, "src-tauri/target/release/bundle");

/**
 * Signing identities a release may carry: the local self-signed certificate
 * today, an Apple Developer ID once there is one. See `docs/RELEASING.md`.
 *
 * Which of the two is used matters enormously and must not change quietly —
 * see the check below.
 */
const SIGNING_AUTHORITIES = ["Shotly Local Signing", "Developer ID Application"];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const notesFlag = args.indexOf("--notes");
const notes = notesFlag === -1 ? null : args[notesFlag + 1];

const die = (message) => {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
};

const run = (cmd, cmdArgs) =>
  execFileSync(cmd, cmdArgs, { cwd: root, encoding: "utf8" }).trim();

/** Block for `ms` without a timer, because everything here is synchronous. */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Run a `gh` call that must not be abandoned halfway.
 *
 * GitHub's API returns 503 often enough to have interrupted two releases in one
 * afternoon, both times on the very last call — the one that turns the finished
 * draft into a published release. Everything was uploaded and nothing was
 * visible, and the failure needed unpicking by hand.
 *
 * Only transport-level failures are retried: a 503, a 5xx, a timeout. A refusal
 * — "already exists", "not found", a bad token — is an answer, and repeating it
 * would only turn a clear error into a slow one.
 */
function ghWithRetry(args, { attempts = 8, what = "gh" } = {}) {
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync("gh", args, { cwd: root, encoding: "utf8" });
    if (result.status === 0) return (result.stdout ?? "").trim();

    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const retryable = /HTTP (5\d\d|429)|no server is currently available|timed out|connection reset/i;
    if (attempt >= attempts || !retryable.test(output)) {
      die(`${what} failed:\n\n${output.trim()}`);
    }

    // Linear rather than exponential: these outages last minutes, and the
    // useful thing is to keep asking for a couple of them, not to back off
    // until the next attempt is half an hour away.
    const wait = 15_000 * attempt;
    console.log(`  ${what}: ${output.trim().split("\n")[0]}`);
    console.log(`  retrying in ${wait / 1000}s (attempt ${attempt + 1} of ${attempts})…`);
    sleep(wait);
  }
}

// ------------------------------------------------------------------ inputs

const { version } = JSON.parse(
  readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"),
);
const tag = `v${version}`;

const app = join(bundle, "macos/Shotly.app");
const tarball = join(bundle, "macos/Shotly.app.tar.gz");
const signature = `${tarball}.sig`;
const dmg = join(bundle, `dmg/Shotly_${version}_aarch64.dmg`);

// The bundler stamps the version into the disk image's name, which makes every
// link to it go stale the moment the next one ships. Uploading a copy under a
// fixed name buys the same trick the updater already relies on: a permanent
// `releases/latest/download/Shotly.dmg` that the README can point straight at.
const dmgAsset = join(bundle, "dmg/Shotly.dmg");

for (const [what, path] of [
  ["the app bundle", app],
  ["the updater tarball", tarball],
  ["the updater signature", signature],
  ["the disk image", dmg],
]) {
  if (!existsSync(path)) {
    die(`Missing ${what}:\n    ${path}\n\n  Run \`npm run release\` first.`);
  }
}

// ----------------------------------------------------------------- guards

// The updater swaps this bundle in over the running one, and macOS keys the
// Screen Recording grant to the signing identity. Ship an update signed by
// anything else and every user of it silently loses screen capture until they
// re-authorise by hand — so this is a hard stop, not a warning.
// `codesign -d` reports on stderr, and exits non-zero on an unsigned bundle —
// both of which are answers, not crashes, so read the pair without throwing.
const codesign = spawnSync("codesign", ["-dvv", app], { encoding: "utf8" });
const signedBy = `${codesign.stdout ?? ""}${codesign.stderr ?? ""}`;

const authority = signedBy.match(/^Authority=(.+)$/m)?.[1];
if (!authority || !SIGNING_AUTHORITIES.some((a) => authority.startsWith(a))) {
  die(
    `The built app is signed by “${authority ?? "nobody"}”.\n\n` +
      `  Updates replace the installed bundle in place, and macOS ties the\n` +
      `  Screen Recording grant to the signing identity — publishing this\n` +
      `  would break screen capture for everyone who installs it.\n\n` +
      `  Expected one of: ${SIGNING_AUTHORITIES.join(", ")}\n` +
      `  Rebuild with \`npm run release\`, which sets APPLE_SIGNING_IDENTITY.`,
  );
}

// Moving between the two — self-signed to Developer ID, say — is a legitimate
// thing to do exactly once, and it does break the grant for everyone already
// running Shotly. It should be a decision, not a surprise from a stale shell
// variable, so it has to be said out loud.
const stampPath = join(root, "scripts/.last-signing-authority");
const previous = existsSync(stampPath) ? readFileSync(stampPath, "utf8").trim() : null;
if (previous && previous !== authority && !args.includes("--allow-identity-change")) {
  die(
    `The signing identity has changed since the last release.\n\n` +
      `    was: ${previous}\n    now: ${authority}\n\n` +
      `  Everyone already running Shotly will lose their Screen Recording\n` +
      `  grant when they take this update, and will have to re-authorise it\n` +
      `  by hand in System Settings.\n\n` +
      `  If that is intended, re-run with --allow-identity-change and say so\n` +
      `  in the release notes.`,
  );
}

// A tag that already exists on a *published* release means this version has
// shipped. Overwriting it would hand a different binary to anyone who has not
// updated yet, under a version number they may already be running.
// `gh release view` on a missing tag is the expected case, not an error, so
// swallow its output rather than letting "release not found" print on a run
// that is going perfectly well.
const probe = spawnSync("gh", ["release", "view", tag, "--json", "isDraft,url"], {
  cwd: root,
  encoding: "utf8",
});
const published = probe.status === 0 ? JSON.parse(probe.stdout) : null;
if (published && !published.isDraft) {
  die(
    `${tag} is already published:\n    ${published.url}\n\n` +
      `  Bump the version instead: npm run bump -- <next>`,
  );
}

/**
 * The id of a draft release for this tag, if an earlier run left one.
 *
 * `gh release view` cannot find one: it resolves by tag, and a draft has no tag
 * until it is published — the release object carries the name, but the git ref
 * does not exist yet. So this asks for the release list instead. Without it, a
 * re-run after an interrupted publish tries to *create* a second release under
 * the same tag.
 */
const findDraft = () =>
  ghWithRetry(
    [
      "api",
      `/repos/${REPO}/releases?per_page=100`,
      "--jq",
      `.[] | select(.draft == true and .tag_name == "${tag}") | .id`,
    ],
    { what: "looking for a leftover draft" },
  )
    .split("\n")
    .filter(Boolean)[0] ?? null;

// The release tag has to name a commit GitHub can see, and it should name the
// commit these artefacts were actually built from — otherwise the source at
// the tag and the binary under it are two different programs.
const head = run("git", ["rev-parse", "HEAD"]);
const onRemote = spawnSync("git", ["branch", "-r", "--contains", head], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim();
if (!onRemote) {
  die(`HEAD (${head.slice(0, 7)}) has not been pushed.\n\n  Push it, then publish.`);
}

// ---------------------------------------------------------------- manifest

const manifest = {
  version,
  notes: notes ?? `Shotly ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    // Apple Silicon only, matching what we build. An Intel Mac finds no entry
    // for its architecture and is simply told it is up to date, which is
    // better than handing it a binary it cannot run.
    "darwin-aarch64": {
      signature: readFileSync(signature, "utf8").trim(),
      url: `https://github.com/skuirrels/shotly/releases/download/${tag}/Shotly.app.tar.gz`,
    },
  },
};

const manifestPath = join(bundle, "latest.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

copyFileSync(dmg, dmgAsset);

const size = (path) => `${(statSync(path).size / 1_048_576).toFixed(1)} MB`;
const row = (name, detail) => console.log(`  ${name.padEnd(30)}${detail}`);
console.log(`\nShotly ${version} → ${tag}   (${authority})`);
row("Shotly.dmg", size(dmgAsset));
row("Shotly.app.tar.gz", size(tarball));
row("latest.json", manifest.platforms["darwin-aarch64"].url);

if (dryRun) {
  console.log(`\n(dry run — nothing uploaded)\n`);
  process.exit(0);
}

// ----------------------------------------------------------------- upload

const assets = [
  `${dmgAsset}#Shotly ${version} (Apple Silicon)`,
  tarball,
  signature,
  manifestPath,
];

// Anything left over from an interrupted run goes, rather than being patched
// up: a draft is this script's own debris — nobody could have downloaded it —
// and starting again is the one recovery that is the same at every failure
// point.
const leftover = findDraft();
if (leftover) {
  console.log(`\n  removing a draft left by an earlier run (${leftover})`);
  ghWithRetry(["api", "-X", "DELETE", `/repos/${REPO}/releases/${leftover}`], {
    what: "removing a leftover draft",
  });
}

// Deliberately in two steps. `gh release create` does this internally — upload
// to a draft, then publish it — and when GitHub answers 503 on that second call
// the assets are all there and the release is invisible, which is how two
// releases in one afternoon ended up being finished by hand. Split apart, the
// publish is a call of its own that can be retried until it lands.
ghWithRetry(
  [
    "release",
    "create",
    tag,
    ...assets,
    "--target",
    head,
    "--title",
    `Shotly ${version}`,
    "--notes",
    manifest.notes,
    "--draft",
  ],
  { what: "uploading the release" },
);

const draft = findDraft();
if (!draft) die(`${tag} was uploaded but no draft came back — check the releases page.`);

ghWithRetry(
  // `-f` and not `-F` for make_latest: it is a *string* enum in the API
  // ("true"/"false"/"legacy"), and sent as a boolean it is quietly ignored —
  // the release publishes, and the updater goes on being offered the old one.
  ["api", "-X", "PATCH", `/repos/${REPO}/releases/${draft}`, "-F", "draft=false", "-f", "make_latest=true"],
  { what: "publishing the release" },
);

// Say it landed only once GitHub agrees, on both counts that matter: the
// release is no longer a draft, and it is the one `releases/latest` resolves
// to — which is the URL the updater reads.
const state = JSON.parse(
  ghWithRetry(["api", `/repos/${REPO}/releases/${draft}`, "--jq", "{draft:.draft}"], {
    what: "checking the release",
  }),
);
const latest = ghWithRetry(["api", `/repos/${REPO}/releases/latest`, "--jq", ".tag_name"], {
  what: "checking which release is latest",
});
if (state.draft) die(`${tag} is still a draft. Publish it by hand, or re-run.`);
if (latest !== tag) die(`${tag} published, but GitHub still calls ${latest} the latest release.`);

writeFileSync(stampPath, `${authority}\n`);

console.log(`\n✓ Published https://github.com/skuirrels/shotly/releases/tag/${tag}`);
console.log(`  signed by ${authority}\n`);
