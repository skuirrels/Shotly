/**
 * Keyboard shortcut parsing, matching and display.
 *
 * Shortcuts are authored as strings ("Mod+Shift+Z", "V", "Escape") and become
 * the single source of truth for the key handler, the tooltips, the command
 * palette and the cheat sheet — so a rebind can never leave a stale hint
 * somewhere in the UI.
 */

export interface Chord {
  /** `KeyboardEvent.code` for physical keys, else a `KeyboardEvent.key` name. */
  code?: string;
  key?: string;
  mod: boolean; // Cmd on macOS
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

const NAMED: Record<string, string> = {
  escape: "Escape",
  esc: "Escape",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
};

/**
 * Physical-key aliases. Matching on `code` rather than `key` matters on macOS:
 * Option+A emits "å", and Shift+1 emits "!", either of which would break a
 * `key`-based comparison.
 */
const CODES: Record<string, string> = {
  space: "Space",
  "[": "BracketLeft",
  "]": "BracketRight",
  "/": "Slash",
  ",": "Comma",
  ".": "Period",
  ";": "Semicolon",
  "'": "Quote",
  "\\": "Backslash",
  "`": "Backquote",
  "-": "Minus",
  "=": "Equal",
  "+": "Equal",
};

export function parseShortcut(spec: string): Chord {
  const parts = spec.split("+").map((p) => p.trim()).filter(Boolean);
  const chord: Chord = { mod: false, shift: false, alt: false, ctrl: false };

  for (const raw of parts) {
    const p = raw.toLowerCase();
    switch (p) {
      case "mod":
      case "cmd":
      case "command":
        chord.mod = true;
        continue;
      case "shift":
        chord.shift = true;
        continue;
      case "alt":
      case "opt":
      case "option":
        chord.alt = true;
        continue;
      case "ctrl":
      case "control":
        chord.ctrl = true;
        continue;
    }

    if (NAMED[p]) chord.key = NAMED[p];
    else if (CODES[p]) chord.code = CODES[p];
    else if (/^[a-z]$/.test(p)) chord.code = `Key${p.toUpperCase()}`;
    else if (/^[0-9]$/.test(p)) chord.code = `Digit${p}`;
    else chord.key = raw;
  }

  return chord;
}

export function matchesChord(e: KeyboardEvent, chord: Chord): boolean {
  if (e.metaKey !== chord.mod) return false;
  if (e.shiftKey !== chord.shift) return false;
  if (e.altKey !== chord.alt) return false;
  if (e.ctrlKey !== chord.ctrl) return false;

  if (chord.code) return e.code === chord.code;
  if (chord.key) return e.key === chord.key;
  return false;
}

const GLYPHS: Record<string, string> = {
  Escape: "esc",
  Enter: "↩",
  Tab: "⇥",
  Backspace: "⌫",
  Delete: "⌦",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Space: "space",
  BracketLeft: "[",
  BracketRight: "]",
  Slash: "/",
  Comma: ",",
  Period: ".",
  Semicolon: ";",
  Quote: "'",
  Backslash: "\\",
  Backquote: "`",
  Minus: "−",
  Equal: "=",
};

/** Render a chord the way macOS does — ⌃⌥⇧⌘ in that fixed order. */
export function formatShortcut(spec: string): string {
  const chord = parseShortcut(spec);
  let out = "";
  if (chord.ctrl) out += "⌃";
  if (chord.alt) out += "⌥";
  if (chord.shift) out += "⇧";
  if (chord.mod) out += "⌘";

  const token = chord.code ?? chord.key ?? "";
  if (GLYPHS[token]) return out + GLYPHS[token];
  if (token.startsWith("Key")) return out + token.slice(3);
  if (token.startsWith("Digit")) return out + token.slice(5);
  return out + token;
}

/**
 * Is the user typing into a field right now?
 *
 * Bare-letter shortcuts (V for select, A for arrow) must not fire while an
 * annotation's text is being edited — but ⌘Z still should.
 */
export function isEditingText(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || el.isContentEditable;
}
