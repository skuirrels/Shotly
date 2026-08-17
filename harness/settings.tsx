import { useState } from "react";
import { createRoot } from "react-dom/client";
import "./harness.css";
import { Settings } from "@/windows/editor/Settings";
import { ShortcutSheet } from "@/windows/editor/ShortcutSheet";
import type { Command } from "@/lib/keys/types";

/**
 * The Settings dialog and the shortcut sheet, in a plain browser.
 *
 * Both are pure panels over stubbed IPC, so this is the whole of them —
 * including the hotkey recorder, which really does rebind against the stub.
 * `#sheet` shows the keymap instead.
 */

const COMMANDS: Command[] = [
  { id: "tool.select", title: "Select", group: "Tools", shortcut: "V", run: () => {} },
  { id: "tool.arrow", title: "Arrow", group: "Tools", shortcut: "A", run: () => {} },
  { id: "edit.undo", title: "Undo", group: "Edit", shortcut: "Mod+Z", run: () => {} },
  {
    id: "edit.trashPicked",
    title: "Delete selected",
    group: "Edit",
    shortcut: "Mod+Backspace",
    altShortcut: "Mod+Delete",
    run: () => {},
  },
  { id: "view.zoomIn", title: "Zoom in", group: "View", shortcut: "Mod+=", run: () => {} },
  { id: "export.copy", title: "Copy to clipboard", group: "Export", shortcut: "Mod+C", run: () => {} },
];

const sheet = location.hash === "#sheet";

/** Closing really closes, so "esc closes it" is a thing this can show. */
function Harness() {
  const [open, setOpen] = useState(true);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="m-8 rounded-lg bg-white/10 px-3 py-2 text-[12.5px] text-ink"
      >
        Closed — open it again
      </button>
    );
  }
  return sheet ? (
    <ShortcutSheet
      commands={COMMANDS}
      onEditHotkeys={() => (location.hash = "")}
      onClose={() => setOpen(false)}
    />
  ) : (
    <Settings onClose={() => setOpen(false)} />
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);

// The hash decides which panel mounts, so following the link has to remount.
window.addEventListener("hashchange", () => location.reload());
