#!/usr/bin/env node
// Do the two platform backends still offer the same thing?
//
// `platform/macos/` and `platform/windows/` are two implementations of one
// surface, and shared code calls that surface without knowing which is
// underneath. Nothing in the type system enforces the pairing: only one side
// is ever compiled, so deleting a function from the *other* one is invisible
// until a build on that platform fails.
//
// Which has now happened twice, both times the same way — a block edit whose
// end boundary reached further than intended and took neighbouring functions
// with it. Both were caught by CI on Windows, minutes into a cargo build, on a
// commit already pushed. This catches the same thing in about 30ms, on the
// machine the edit was made on.
//
// It compares names and signatures, normalised so that `_path` and `path`
// count as the same parameter — the unused-argument underscore is a property
// of the stub, not of the contract.
//
// usage: node scripts/check-platform-parity.mjs

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = join(root, "src-tauri/src/platform");

/** Every `pub` item a module offers, as normalised signature strings. */
function surface(path) {
  const text = readFileSync(path, "utf8");
  const items = new Set();

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^\s*pub (fn|struct|enum|const|type)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (!m) continue;

    // Gather the whole signature, which rustfmt may have wrapped over several
    // lines, up to the body or the semicolon.
    let sig = lines[i];
    // Stop at the body or the semicolon *wherever* it appears — `pub fn reset()
    // {}` is a whole item on one line, and waiting for a line that ends in `{`
    // would swallow everything after it.
    while (!/[{;]/.test(sig) && i + 1 < lines.length) {
      i += 1;
      sig += " " + lines[i].trim();
    }

    const [, kind, name] = m;
    const tail = sig
      .replace(/^\s*pub (fn|struct|enum|const|type)\s+[A-Za-z_][A-Za-z0-9_]*/, "")
      .replace(/\s*[{;].*$/, "")
      .replace(/\s+/g, " ")
      // `_path` and `path` are the same parameter; the underscore belongs to
      // the stub, not to the contract.
      .replace(/\b_+/g, "")
      // rustfmt wraps long signatures and leaves a trailing comma; an argument
      // list means the same thing either way.
      .replace(/\(\s+/g, "(")
      .replace(/,?\s+\)/g, ")")
      .replace(/,\)/g, ")")
      .trim();
    items.add(`pub ${kind} ${name}${tail ? " " + tail : ""}`);
  }
  return items;
}

const modules = readdirSync(join(base, "macos"))
  .filter((f) => f.endsWith(".rs") && f !== "mod.rs")
  .sort();

let bad = 0;
for (const file of modules) {
  const mac = join(base, "macos", file);
  const win = join(base, "windows", file);

  if (!existsSync(win)) {
    console.error(`✗ platform/windows/${file} does not exist`);
    bad += 1;
    continue;
  }

  const a = surface(mac);
  const b = surface(win);
  const missing = [...a].filter((x) => !b.has(x));
  const extra = [...b].filter((x) => !a.has(x));

  for (const item of missing) console.error(`✗ ${file}: windows is missing  ${item}`);
  for (const item of extra) console.error(`✗ ${file}: windows has extra    ${item}`);
  bad += missing.length + extra.length;
}

// And the module lists themselves, so a whole concern cannot go missing.
const listed = (side) =>
  new Set(
    readFileSync(join(base, side, "mod.rs"), "utf8")
      .split("\n")
      .flatMap((l) => l.match(/^pub mod (\w+);/)?.slice(1) ?? []),
  );
const macMods = listed("macos");
const winMods = listed("windows");
for (const m of macMods) if (!winMods.has(m)) { console.error(`✗ windows/mod.rs does not declare ${m}`); bad += 1; }
for (const m of winMods) if (!macMods.has(m)) { console.error(`✗ macos/mod.rs does not declare ${m}`); bad += 1; }

if (bad) {
  console.error(
    `\n${bad} difference${bad === 1 ? "" : "s"} between the platform backends.\n\n` +
      `  Shared code calls one surface; only one side is ever compiled, so a\n` +
      `  gap here is invisible until a build on the other platform fails.\n`,
  );
  process.exit(1);
}

console.log(`✓ ${modules.length} platform modules match on both sides`);
