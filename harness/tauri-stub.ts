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

  // Start at login. Held in memory so the switch behaves as it does in the
  // app: set it, and the answer that comes back is what the system reports.
  if (cmd === "drive_link") {
    const name = String(args?.path ?? "").split("/").pop() ?? "";
    if (!name.endsWith(".mov")) throw new Error("That capture hasn't been backed up yet.");
    return "https://drive.google.com/file/d/HARNESSFILEID/view?usp=sharing" as T;
  }
  if (cmd === "launch_at_login") return atLogin as T;
  if (cmd === "set_launch_at_login") {
    atLogin = Boolean(args?.enabled);
    return atLogin as T;
  }

  // The library grid: one recording among the stills, so the play badge, the
  // running time and the actions a movie cannot do are all on screen at once.
  if (cmd === "library_thumbnail") return "/source.png" as T;
  if (cmd === "open_externally" || cmd === "reveal_in_finder") {
    (window as any).LAST_OPEN = args?.path;
    return undefined as T;
  }
  if (cmd === "list_library") {
    const day = 86_400_000;
    const now = Date.now();
    return [
      { path: "/lib/Recording 2026-08-17 at 13.58.12.mov", name: "Recording 2026-08-17 at 13.58.12.mov", modified: now - 120_000, size: 12_848_576, width: 4096, height: 2304, video: true, seconds: 386.4, cloud: false },
      { path: "/lib/Shotly 2026-08-17 at 10.19.37.png", name: "Shotly 2026-08-17 at 10.19.37.png", modified: now - 3 * 3600_000, size: 39_325, width: 1512, height: 982, video: false, seconds: 0, cloud: false },
      { path: "/lib/Recording 2026-08-16 at 09.02.00.mov", name: "Recording 2026-08-16 at 09.02.00.mov", modified: now - day, size: 3_204_000, width: 0, height: 0, video: true, seconds: 0, cloud: true },
      { path: "/lib/Shotly 2026-08-16 at 23.41.09.png", name: "Shotly 2026-08-16 at 23.41.09.png", modified: now - day - 7200_000, size: 752_026, width: 2048, height: 1152, video: false, seconds: 0, cloud: false },
    ] as T;
  }

  // Screen recording. The overlay and the panel are pure UI over these; what
  // they cannot exercise here is the recorder itself, which is a child process.
  if (cmd === "record_ready" || cmd === "record_beat") return undefined as T;
  // `#hud` stands in for a window that Rust opened as a panel: the page has to
  // find that out by asking, since the event came and went before it loaded.
  if (cmd === "record_phase") return (location.hash === "#hud" ? "hud" : "select") as T;
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

  // The live annotation layer. Its watchdog and its screen list are Rust's;
  // everything the harness is for — the tools, the callout, the toolbar —
  // sits above them.
  if (cmd === "annotate_ready" || cmd === "annotate_beat") return undefined as T;
  if (cmd === "annotate_stop" || cmd === "annotate_pass_through") return undefined as T;
  if (cmd === "annotate_move") return undefined as T;
  if (cmd === "annotate_layout") {
    return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight } as T;
  }
  if (cmd === "annotate_screens") {
    return [{ id: 1, label: "Screen 1", current: true }] as T;
  }
  if (cmd === "annotate_save") return "/tmp/annotated.png" as T;

  throw new Error(`harness has no stub for ${cmd}`);
}

let atLogin = false;

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

export function convertFileSrc(path: string, _protocol?: string): string {
  return path;
}
