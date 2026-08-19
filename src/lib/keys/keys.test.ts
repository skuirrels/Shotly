/**
 * Pins the shortcut grammar before it learns about platforms.
 *
 * Written as the safety net for the Phase 0 refactor (docs/WINDOWS.md): the
 * `Mod` modifier is about to stop meaning "always ⌘", and every behaviour
 * asserted here is one that must not change on macOS when it does.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { formatShortcut, matchesChord, parseShortcut } from "./keys";

/** The fields of a KeyboardEvent that the matcher consults. */
function press(init: {
  key?: string;
  code?: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}): KeyboardEvent {
  return {
    key: init.key ?? "",
    code: init.code ?? "",
    metaKey: init.meta ?? false,
    ctrlKey: init.ctrl ?? false,
    shiftKey: init.shift ?? false,
    altKey: init.alt ?? false,
  } as KeyboardEvent;
}

describe("parseShortcut", () => {
  test("a bare letter is a physical key with no modifiers", () => {
    expect(parseShortcut("V")).toEqual({
      code: "KeyV",
      mod: false,
      shift: false,
      alt: false,
      ctrl: false,
    });
  });

  test("Mod+Shift+Z carries both modifiers", () => {
    const chord = parseShortcut("Mod+Shift+Z");
    expect(chord.mod).toBe(true);
    expect(chord.shift).toBe(true);
    expect(chord.code).toBe("KeyZ");
  });

  test("named keys resolve by key, punctuation by physical code", () => {
    expect(parseShortcut("Escape").key).toBe("Escape");
    expect(parseShortcut("Enter").key).toBe("Enter");
    expect(parseShortcut("[").code).toBe("BracketLeft");
    expect(parseShortcut("Mod+,").code).toBe("Comma");
  });
});

describe("matchesChord on macOS", () => {
  test("Mod means the Command key", () => {
    const chord = parseShortcut("Mod+S");
    expect(matchesChord(press({ code: "KeyS", meta: true }), chord)).toBe(true);
    expect(matchesChord(press({ code: "KeyS", ctrl: true }), chord)).toBe(false);
  });

  test("extra modifiers disqualify a match", () => {
    const chord = parseShortcut("Mod+Z");
    expect(matchesChord(press({ code: "KeyZ", meta: true, shift: true }), chord)).toBe(false);
  });

  test("physical matching survives what Option does to the glyph", () => {
    // Option+A arrives as key "å"; the chord matches on code and must not care.
    const chord = parseShortcut("Alt+A");
    expect(matchesChord(press({ code: "KeyA", key: "å", alt: true }), chord)).toBe(true);
  });

  test("Ctrl is matched as itself, apart from Mod", () => {
    const chord = parseShortcut("Ctrl+Shift+4");
    expect(matchesChord(press({ code: "Digit4", ctrl: true, shift: true }), chord)).toBe(true);
    expect(matchesChord(press({ code: "Digit4", meta: true, shift: true }), chord)).toBe(false);
  });
});

describe("formatShortcut on macOS", () => {
  test("renders macOS glyphs in the fixed ⌃⌥⇧⌘ order", () => {
    expect(formatShortcut("Mod+S")).toBe("⌘S");
    expect(formatShortcut("Mod+Shift+Z")).toBe("⇧⌘Z");
    expect(formatShortcut("Ctrl+Shift+4")).toBe("⌃⇧4");
    expect(formatShortcut("Alt+Mod+I")).toBe("⌥⌘I");
  });

  test("named keys keep their glyphs", () => {
    expect(formatShortcut("Escape")).toBe("esc");
    expect(formatShortcut("Mod+Enter")).toBe("⌘↩");
    expect(formatShortcut("Space")).toBe("space");
  });
});

/**
 * The Windows half of the same grammar.
 *
 * `platform.ts` reads the user agent once, at module load, so these reload the
 * modules under a Windows-shaped navigator rather than trying to change the
 * answer afterwards. That is the same thing the real build does — the OS does
 * not change while the app is running.
 */
describe("on Windows", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function windowsKeys() {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    vi.resetModules();
    return await import("./keys");
  }

  test("Mod is the Control key", async () => {
    const keys = await windowsKeys();
    const chord = keys.parseShortcut("Mod+S");
    expect(keys.matchesChord(press({ code: "KeyS", ctrl: true }), chord)).toBe(true);
    expect(keys.matchesChord(press({ code: "KeyS", meta: true }), chord)).toBe(false);
  });

  test("the Windows key is never mistaken for Mod", async () => {
    const keys = await windowsKeys();
    const chord = keys.parseShortcut("Mod+S");
    expect(keys.matchesChord(press({ code: "KeyS", ctrl: true, meta: true }), chord)).toBe(false);
  });

  test("shortcuts are spelled out rather than drawn", async () => {
    const keys = await windowsKeys();
    expect(keys.formatShortcut("Mod+S")).toBe("Ctrl+S");
    expect(keys.formatShortcut("Mod+Shift+Z")).toBe("Ctrl+Shift+Z");
    expect(keys.formatShortcut("Alt+Mod+I")).toBe("Ctrl+Alt+I");
    expect(keys.formatShortcut("Escape")).toBe("Esc");
    expect(keys.formatShortcut("Mod+Enter")).toBe("Ctrl+Enter");
  });

  test("a Ctrl-authored chord still says Ctrl once", async () => {
    const keys = await windowsKeys();
    expect(keys.formatShortcut("Ctrl+Shift+4")).toBe("Ctrl+Shift+4");
    const chord = keys.parseShortcut("Ctrl+Shift+4");
    expect(keys.matchesChord(press({ code: "Digit4", ctrl: true, shift: true }), chord)).toBe(true);
  });

  test("a Mac is not mistaken for Windows by the word Darwin", async () => {
    // "Darwin" contains "win". Anything that put the kernel name in the user
    // agent would, under a looser test, turn every ⌘ shortcut off.
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Shotly/1.0 (Darwin arm64)",
    });
    vi.resetModules();
    const keys = await import("./keys");
    expect(keys.formatShortcut("Mod+S")).toBe("⌘S");
    expect(keys.matchesChord(press({ code: "KeyS", meta: true }), keys.parseShortcut("Mod+S"))).toBe(true);
  });

  test("the key grammar itself does not change", async () => {
    const keys = await windowsKeys();
    expect(keys.parseShortcut("Mod+Shift+Z").code).toBe("KeyZ");
    expect(keys.parseShortcut("[").code).toBe("BracketLeft");
    expect(keys.parseShortcut("Escape").key).toBe("Escape");
  });
});
