/**
 * The one place that knows which operating system this is.
 *
 * Shotly is one application that happens to run in two places: the same
 * components, the same tokens, the same behaviour, with the syscalls
 * underneath differing and nothing else. That only stays true if the
 * differences are *collected* — a scattering of `if (isWindows)` at call sites
 * is how two builds quietly become two products.
 *
 * So every user-visible difference goes through this file, and the list is
 * deliberately short:
 *
 * | | macOS | Windows |
 * |---|---|---|
 * | Primary modifier | ⌘ | Ctrl |
 * | Shortcut display | ⌃⌥⇧⌘Z | Ctrl+Shift+Z |
 * | Shell nouns | Finder, Trash | Explorer, Recycle Bin |
 * | Window chrome inset | 86px for the traffic lights | none |
 *
 * Anything not on that list is the same on both, and adding to it should feel
 * like a decision rather than a convenience. See `docs/WINDOWS.md`.
 */

export type OS = "macos" | "windows";

/**
 * Which system this is.
 *
 * Read from the user agent rather than from Tauri's OS plugin, because this is
 * consulted while modules are still evaluating — `keys.ts` formats shortcuts at
 * import time — and an async answer would arrive after the first render.
 */
function detect(): OS {
  // `/Windows/` rather than `/Win/`: "Darwin" contains "win", so the looser
  // test would flip a Mac into Ctrl-for-⌘ mode the moment anything put the
  // kernel name in the user agent — every shortcut silently dead, every hint
  // mislabelled. Windows' own user agents always spell the word out.
  if (typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)) return "windows";
  return "macos";
}

export const os: OS = detect();
export const isMac = os === "macos";
export const isWindows = os === "windows";

/**
 * What this system calls the things Shotly does to files.
 *
 * Whole phrases rather than nouns to interpolate: "Show in Finder" and "Show in
 * Explorer" happen to share a shape, but "Move to Trash" and "Move to Recycle
 * Bin" would not survive being assembled from parts in a language that puts
 * them the other way round.
 */
export const nouns = isWindows
  ? {
      reveal: "Show in Explorer",
      revealLast: "Show last save in Explorer",
      trash: "Move to Recycle Bin",
      trashMany: (n: number) => `Move ${n} captures to Recycle Bin`,
      trashSelected: "Move selected captures to Recycle Bin",
      trashPicked: "Move picked captures to Recycle Bin",
      trashThisRecording: "Move this recording to the Recycle Bin",
      trashed: "Moved to Recycle Bin",
      trashedMany: (n: number) => `Moved ${n} captures to Recycle Bin`,
      settingsApp: "Settings",
      menuBar: "system tray",
    }
  : {
      reveal: "Show in Finder",
      revealLast: "Show last save in Finder",
      trash: "Move to Trash",
      trashMany: (n: number) => `Move ${n} captures to Trash`,
      trashSelected: "Move selected captures to Trash",
      trashPicked: "Move picked captures to Trash",
      trashThisRecording: "Move this recording to the Trash",
      trashed: "Moved to Trash",
      trashedMany: (n: number) => `Moved ${n} captures to Trash`,
      settingsApp: "System Settings",
      menuBar: "menu bar",
    };

/**
 * How much room the window's own controls need at the left of the title bar.
 *
 * macOS puts the traffic lights there and Tauri's `Overlay` title bar draws
 * them over the page. Windows puts its caption buttons at the *right*, so the
 * left inset is nothing — and the right inset becomes the interesting one if
 * Shotly ever draws its own.
 */
export const titlebarInsetLeft = isWindows ? 0 : 86;
