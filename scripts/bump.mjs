#!/usr/bin/env node
// Set the release version in the three places that carry it.
//
// They have to agree. `tauri.conf.json` is what gets stamped into the built
// bundle and therefore what the updater compares against the manifest, so a
// stale value there means the app either never sees an update or downloads one
// it already has, forever. Cargo.toml and package.json drifting is merely
// confusing, but this is cheap enough to just keep all three honest.
//
// Edits are textual rather than a JSON round-trip, which would reformat these
// files wholesale and bury the one line that actually changed.
//
// usage: npm run bump -- 0.2.0

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("usage: npm run bump -- <major.minor.patch>");
  process.exit(1);
}

/**
 * Replace the first match of `pattern`, whose groups 1 and 2 bracket the
 * version. Failing to match is fatal — a silent miss here is exactly the
 * mismatch this script exists to prevent — but a file already at the target
 * version is fine, so that the command can be re-run.
 */
function edit(relative, pattern) {
  const path = join(root, relative);
  const before = readFileSync(path, "utf8");
  const match = before.match(pattern);
  if (!match) {
    console.error(`could not find a version to set in ${relative}`);
    process.exit(1);
  }
  writeFileSync(path, before.replace(pattern, `$1${version}$2`));
  console.log(`  ${relative}`);
}

edit("package.json", /("version":\s*")[^"]*(")/);
edit("src-tauri/tauri.conf.json", /("version":\s*")[^"]*(")/);
// Anchored on [package] so a dependency's version is never the one that moves.
edit("src-tauri/Cargo.toml", /(\[package\][^[]*?\nversion = ")[^"]*(")/);

console.log(`\nShotly is now ${version}. Next: npm run publish`);
