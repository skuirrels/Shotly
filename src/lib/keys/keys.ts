/**
 * Keyboard shortcut parsing, matching and display.
 *
 * Shortcuts are authored as strings ("Mod+Shift+Z", "V", "Escape") and become
 * the single source of truth for the key handler, the tooltips, the command
 * palette and the cheat sheet — so a rebind can never leave a stale hint
 * somewhere in the UI.
 *
 * `Mod` is the platform's own primary modifier — ⌘ on macOS, Ctrl on Windows
 * — which is the whole reason shortcuts are authored as `Mod+` rather than as
 * the key itself. Everything else about the grammar is identical on both.
 */
import { isWindows } from "../platform";

export interface Chord {
  /** `KeyboardEvent.code` for physical keys, else a `KeyboardEvent.key` name. */
  code?: string;
  key?: string;
  /** The platform's primary modifier: ⌘ on macOS, Ctrl on Windows. */
  mod: boolean;
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
  // On Windows `Mod` *is* Ctrl, so the two flags read the same key and a chord
  // asking for both is unsatisfiable — deliberately. Nothing authors one: the
  // capture hotkeys that use Ctrl are registered by Rust and never reach here,
  // and every in-app binding is written `Mod+…`.
  if (isWindows) {
    if (e.ctrlKey !== (chord.mod || chord.ctrl)) return false;
    if (e.metaKey) return false;
  } else {
    if (e.metaKey !== chord.mod) return false;
    if (e.ctrlKey !== chord.ctrl) return false;
  }
  if (e.shiftKey !== chord.shift) return false;
  if (e.altKey !== chord.alt) return false;

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

/**
 * Render a chord the way this platform writes one.
 *
 * macOS stacks glyphs in the fixed order ⌃⌥⇧⌘; Windows spells the modifiers
 * out and joins them with `+`. Both end in the same key name, which is why
 * only the prefix differs.
 */
export function formatShortcut(spec: string): string {
  const chord = parseShortcut(spec);

  const token = chord.code ?? chord.key ?? "";
  const key = GLYPHS[token]
    ?? (token.startsWith("Key") ? token.slice(3)
      : token.startsWith("Digit") ? token.slice(5)
        : token);

  if (isWindows) {
    const parts: string[] = [];
    // `Mod` and `Ctrl` are the same key here, so a chord carrying either says
    // "Ctrl" once rather than twice.
    if (chord.mod || chord.ctrl) parts.push("Ctrl");
    if (chord.alt) parts.push("Alt");
    if (chord.shift) parts.push("Shift");
    parts.push(WINDOWS_NAMES[token] ?? key);
    return parts.join("+");
  }

  let out = "";
  if (chord.ctrl) out += "⌃";
  if (chord.alt) out += "⌥";
  if (chord.shift) out += "⇧";
  if (chord.mod) out += "⌘";
  return out + key;
}

/** The keys Windows names rather than draws. */
const WINDOWS_NAMES: Record<string, string> = {
  Escape: "Esc",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Del",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Space: "Space",
};

/**
 * Does this shortcut need ⌘?
 *
 * The question a view asks when it takes the keyboard for itself: the player
 * claims the bare keys — space, the arrows, a handful of letters — and leaves
 * everything with ⌘ on it to the app, which is the same division macOS makes
 * between a view's keys and the menu bar's.
 */
export function needsMod(spec: string): boolean {
  return parseShortcut(spec).mod;
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
