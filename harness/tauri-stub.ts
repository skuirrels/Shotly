/** Stands in for the Tauri calls the harnessed pages make. See vite.harness.config.ts. */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (cmd === "read_capture_bytes") {
    const response = await fetch("/source.png");
    const buffer = await response.arrayBuffer();
    return Array.from(new Uint8Array(buffer)) as T;
  }

  // Settings. Held in memory so a rebind in the harness behaves the way it
  // does in the app: the list is re-read afterwards and shows the new key.
  // Copies, because Rust hands back a fresh list every time and React would
  // otherwise see the same array and skip the render.
  if (cmd === "hotkeys_list") return hotkeys.map((b) => ({ ...b })) as T;
  if (cmd === "hotkeys_set") {
    const row = hotkeys.find((b) => b.action === args?.action);
    if (!row) throw new Error("no such action");
    row.accelerator = (args?.accelerator as string | null) ?? null;
    return undefined as T;
  }
  if (cmd === "hotkeys_reset") {
    hotkeys.forEach((b) => (b.accelerator = b.defaultAccelerator));
    return undefined as T;
  }
  if (cmd === "backup_settings") return { enabled: false, destination: null } as T;
  if (cmd === "backup_targets") {
    return [
      { label: "Google Drive", path: "/Users/harness/Google Drive/My Drive/Shotly" },
      { label: "Dropbox", path: "/Users/harness/Dropbox/Shotly" },
    ] as T;
  }
  if (cmd === "open_keyboard_settings") return undefined as T;

  // Screen recording. The overlay and the panel are pure UI over these; what
  // they cannot exercise here is the recorder itself, which is a child process.
  if (cmd === "record_ready" || cmd === "record_beat") return undefined as T;
  if (cmd === "record_layout") return { x: 0, y: 0, width: 1440, height: 900 } as T;
  if (cmd === "record_windows") {
    return [
      { id: 1, x: 80, y: 60, width: 520, height: 380 },
      { id: 2, x: 420, y: 260, width: 600, height: 420 },
    ] as T;
  }
  if (cmd === "record_running") return { what: "1280 × 720", seconds: 42 } as T;
  if (cmd === "record_region" || cmd === "record_window" || cmd === "record_screen") {
    (window as any).EMIT("record:phase", "hud");
    return undefined as T;
  }
  if (cmd === "record_stop" || cmd === "record_cancel") return undefined as T;

  throw new Error(`harness has no stub for ${cmd}`);
}

const hotkeys = [
  ["region", "Capture region", "Drag out the part of the screen to keep.", "Ctrl+Shift+4"],
  ["window", "Capture window", "Pick a window; Shotly takes it whole.", "Ctrl+Shift+5"],
  ["fullscreen", "Capture full screen", "The whole display, straight to the library.", "Ctrl+Shift+3"],
  ["scroll", "Scrolling capture", "Pick a region, scroll the page yourself; Shotly stitches it.", "Ctrl+Shift+6"],
  ["annotate", "Annotate the screen", "Draw over the live screen. Also the way out.", "Ctrl+Shift+A"],
  ["interact", "Click through / back to drawing", "Hand the mouse back to the desktop, drawings and all.", "Ctrl+Shift+D"],
].map(([action, label, hint, accel]) => ({
  action,
  label,
  hint,
  accelerator: accel as string | null,
  defaultAccelerator: accel,
}));

export function convertFileSrc(path: string): string {
  return path;
}
