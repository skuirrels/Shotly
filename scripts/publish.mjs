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
const existing = probe.status === 0 ? JSON.parse(probe.stdout) : null;
if (existing && !existing.isDraft) {
  die(
    `${tag} is already published:\n    ${existing.url}\n\n` +
      `  Bump the version instead: npm run bump -- <next>`,
  );
}

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

if (existing) {
  // Finish a draft left over from an interrupted run.
  run("gh", ["release", "upload", tag, ...assets, "--clobber"]);
  run("gh", ["release", "edit", tag, "--draft=false", "--latest"]);
} else {
  run("gh", [
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
    "--latest",
  ]);
}

writeFileSync(stampPath, `${authority}\n`);

console.log(`\n✓ Published https://github.com/skuirrels/shotly/releases/tag/${tag}`);
console.log(`  signed by ${authority}\n`);
