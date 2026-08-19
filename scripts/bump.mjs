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

import { execFileSync } from "node:child_process";
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
// Cargo would fix this itself on the next build — but that build happens
// inside `npm run publish`, long after the version commit, leaving the lock
// file dirty behind the release it belongs to.
edit("src-tauri/Cargo.lock", /(name = "shotly"\nversion = ")[^"]*(")/);

openChangelog();

console.log(`\nShotly is now ${version}. Next: write CHANGELOG.md, then npm run publish`);

/**
 * Start this version's changelog section, pre-filled with what has landed
 * since the last tag.
 *
 * Pre-filled rather than blank because a blank section is one nobody fills in:
 * the commit subjects are already written for a reader, and turning them into
 * an entry is editing rather than remembering. `npm run publish` refuses to
 * ship a version whose section is still empty, so the two halves hold each
 * other up.
 */
function openChangelog() {
  const path = join(root, "CHANGELOG.md");
  const before = readFileSync(path, "utf8");
  const heading = `## ${version} — `;

  if (before.includes(heading)) {
    console.log(`  CHANGELOG.md already has ${version}`);
    return;
  }

  let subjects = [];
  try {
    const last = execFileSync("git", ["describe", "--tags", "--abbrev=0"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    subjects = execFileSync("git", ["log", "--format=%s", `${last}..HEAD`], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !/^Shotly \d/.test(line));
  } catch {
    // No tags yet, or no git: an empty section is still better than none.
  }

  const date = new Date().toISOString().slice(0, 10);
  const body = subjects.length
    ? subjects.map((s) => `- ${s}`).join("\n")
    : "- ";
  const section = `${heading}${date}\n\n${body}\n\n`;

  // Above the newest existing version, and below the file's own preamble.
  const at = before.indexOf("## ");
  const next = at === -1 ? before + section : before.slice(0, at) + section + before.slice(at);
  writeFileSync(path, next);
  console.log(`  CHANGELOG.md (${subjects.length || "no"} commits since the last tag)`);
}
