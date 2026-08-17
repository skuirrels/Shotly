import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type {
  BackupReport,
  BackupSettings,
  BackupTarget,
  CaptureMode,
  CaptureResult,
  HotkeyAction,
  HotkeyBinding,
  DriveLink,
  LibraryItem,
  Scan,
  WindowInfo,
} from "./types";

/** Turn a Frame's absolute path into something an <img> can load. */
export function assetUrl(path: string): string {
  return convertFileSrc(path);
}

/**
 * The same for a recording, through Shotly's own scheme rather than `asset:`.
 *
 * Not interchangeable with the above, and the difference is the whole point:
 * Tauri's asset protocol reads the file on the **main thread**, so streaming a
 * movie through it does every seek on the thread that draws the interface. The
 * `media` scheme answers from a worker instead — see `src-tauri/src/media.rs`.
 * It serves the capture folder and nothing else.
 */
export function mediaUrl(path: string): string {
  return convertFileSrc(path, "media");
}

export const capturePermissionStatus = () => invoke<boolean>("capture_permission_status");
export const requestCapturePermission = () => invoke<boolean>("request_capture_permission");
export const openScreenRecordingSettings = () => invoke<void>("open_screen_recording_settings");
/** System Settings → Keyboard → Keyboard Shortcuts, where macOS's own screenshot keys live. */
export const openKeyboardSettings = () => invoke<void>("open_keyboard_settings");
export const restartApp = () => invoke<void>("restart_app");

export const beginCapture = (mode: CaptureMode) => invoke<void>("begin_capture", { mode });
export const cancelCapture = () => invoke<void>("cancel_capture");

export const captureFullscreen = (displayId?: number) =>
  invoke<CaptureResult>("capture_fullscreen", { displayId: displayId ?? null });

export const listWindows = () => invoke<WindowInfo[]>("list_windows");

/**
 * A small picture of one window, as a data URL.
 *
 * Taken from the window's own backing store, so it works for windows that are
 * behind others or not on screen at all — which is exactly what makes the
 * picker able to show you what you're choosing.
 */
export const windowThumbnail = (windowId: number, max = 320) =>
  invoke<string>("window_thumbnail", { windowId, max });

/** Capture one window by id and open it in the editor. */
export const captureWindow = (windowId: number) =>
  invoke<CaptureResult>("capture_window", { windowId });

/** Load an existing PNG/JPEG from disk into the editor. */
export const openImage = (path: string) => invoke<CaptureResult>("open_image", { path });

/** Raw bytes of a capture still sitting in the scratch directory. */
export const readCaptureBytes = (path: string) =>
  invoke<number[]>("read_capture_bytes", { path }).then((b) => new Uint8Array(b));

/**
 * `scale` stamps the PNG's DPI so a re-annotated capture still reports @2x when
 * reopened — canvas exports carry no such tag of their own.
 */
export const savePng = (path: string, bytes: Uint8Array, scale?: number) =>
  invoke<void>("save_png", { path, bytes: Array.from(bytes), scale: scale ?? null });

/**
 * Save flattened pixels that Shotly can still take apart later.
 *
 * `source` is the unannotated capture's path — Rust reads it directly rather
 * than having megabytes of original marshalled through the IPC bridge as JSON
 * numbers. `doc` is the serialised markup; see `lib/markup`.
 */
export const saveEditablePng = (
  path: string,
  bytes: Uint8Array,
  source: string,
  doc: string,
  scale?: number,
) =>
  invoke<void>("save_editable_png", {
    path,
    bytes: Array.from(bytes),
    source,
    doc,
    scale: scale ?? null,
  });

/** Save into ~/Documents/Shotly without a dialog. Resolves to the final path. */
export const saveToLibrary = (
  bytes: Uint8Array,
  stem: string,
  scale?: number,
  editable?: { source: string; doc: string },
) =>
  invoke<string>("save_to_library", {
    bytes: Array.from(bytes),
    stem,
    scale: scale ?? null,
    source: editable?.source ?? null,
    doc: editable?.doc ?? null,
  });

export const saveLibraryPath = () => invoke<string>("save_library_path");

export const revealInFinder = (path: string) => invoke<void>("reveal_in_finder", { path });

/**
 * Hand a file to whatever the system opens it with.
 *
 * Recordings, in practice: a movie has nothing to annotate, so the library
 * sends it to QuickTime Player rather than into an editor built for pictures.
 */
export const openExternally = (path: string) => invoke<void>("open_externally", { path });

/**
 * A shareable Google Drive link to the backed-up copy of a capture.
 *
 * Rejects with something worth showing the user: backup off, not copied yet,
 * or Drive still uploading. See `src-tauri/src/drive.rs`.
 */
export const driveLink = (path: string) => invoke<DriveLink>("drive_link", { path });

/**
 * A link to the Drive folder the backup writes into.
 *
 * Where you go to set "anyone with the link can view" — the one part of this
 * Shotly cannot do for you without a connected Google account.
 */
export const driveFolderLink = () => invoke<string>("drive_folder_link");

/** Whether an OAuth client has been set up — Shotly ships without one. */
export const driveHasClient = () => invoke<boolean>("drive_has_client");
/** Whether this build ships its own client, so nothing needs setting up. */
export const driveBuiltInClient = () => invoke<boolean>("drive_built_in_client");
/**
 * Upload a capture to your Drive and share it. The way to send a big one.
 *
 * Emits `drive:progress` as it goes — see `Shared` in `EditorApp`.
 */
export const driveShare = (path: string) => invoke<DriveLink>("drive_share", { path });
export const driveSetClient = (id: string, secret: string) =>
  invoke<void>("drive_set_client", { id, secret });
/** Whether an account is connected, so links can be made to work by themselves. */
export const driveConnected = () => invoke<boolean>("drive_connected");
export const driveConnect = () => invoke<boolean>("drive_connect");
export const driveDisconnect = () => invoke<void>("drive_disconnect");

export const launchAtLogin = () => invoke<boolean>("launch_at_login");
export const setLaunchAtLogin = (enabled: boolean) =>
  invoke<boolean>("set_launch_at_login", { enabled });

export const listLibrary = () => invoke<LibraryItem[]>("list_library");

export const libraryThumbnail = (path: string, max = 480) =>
  invoke<string>("library_thumbnail", { path, max });

/** Move captures to the Trash. All-or-nothing: nothing goes if any path is bad. */
export const trashCaptures = (paths: string[]) => invoke<void>("trash_captures", { paths });

export const copyPngToClipboard = (bytes: Uint8Array) =>
  invoke<void>("copy_png_to_clipboard", { bytes: Array.from(bytes) });

/**
 * Copy saved captures straight from the library.
 *
 * Each one lands on the clipboard as both an image and a file, so the same
 * copy pastes as pixels into a document and as attachments into Finder or Mail.
 */
export const copyFilesToClipboard = (paths: string[]) =>
  invoke<void>("copy_files_to_clipboard", { paths });

/** The clipboard's image as a PNG data URL, or null if it holds something else. */
export const readClipboardImage = () => invoke<string | null>("read_clipboard_image");

/** A saved capture as a PNG data URL, for embedding as an overlay. */
export const imageDataUrl = (path: string) => invoke<string>("image_data_url", { path });

export const hideEditor = () => invoke<void>("hide_editor");

/** Toggle the live screen-annotation layer. */
export const annotateToggle = () => invoke<void>("annotate_toggle");

/**
 * Start a scrolling capture: pick a region, scroll the page yourself, and the
 * stitched whole opens in the editor when you say you're done.
 */
export const scrollBegin = () => invoke<void>("scroll_begin");

/**
 * Record the screen: an area, a window, or a whole display.
 *
 * `recordBegin` opens the picker — and stops a running recording, so the one
 * command answers the hotkey, the tray item and the button. The finished movie
 * is filed in the Shotly folder and announced on `record:saved`.
 */
export const recordBegin = () => invoke<void>("record_begin");
export const recordScreen = () => invoke<void>("record_screen");
export const recordStop = () => invoke<void>("record_stop");

/** The system-wide hotkeys, as they are registered right now. */
export const hotkeysList = () => invoke<HotkeyBinding[]>("hotkeys_list");

/**
 * Rebind one hotkey, or pass `null` to switch it off.
 *
 * Takes effect immediately — no restart. Rejects if the combination cannot be
 * parsed, is already another action's, or the system refuses it outright.
 */
export const hotkeysSet = (action: HotkeyAction, accelerator: string | null) =>
  invoke<void>("hotkeys_set", { action, accelerator });

export const hotkeysReset = () => invoke<void>("hotkeys_reset");

/**
 * Read what a capture says — its text and any code in it — or one rectangle of it.
 *
 * `region` is in source-image pixels, so a cropped document has to add its
 * own crop offset back on before calling. Both kinds of recognition run on one
 * pass, so this never has to be asked twice for the same pixels.
 */
export const scanImage = (
  path: string,
  region: { x: number; y: number; width: number; height: number } | null,
) => invoke<Scan>("scan_image", { path, region });

/**
 * Stick an image to the front of the screen.
 *
 * Two ways in, because there are two things worth pinning: a capture that is
 * already a file, and whatever the editor is showing right now — which only
 * exists as pixels until someone saves it.
 */
export const pinOpen = (path: string) => invoke<string>("pin_open", { path });

export const pinPng = (bytes: Uint8Array) =>
  invoke<string>("pin_png", { bytes: Array.from(bytes) });

export const pinCloseAll = () => invoke<void>("pin_close_all");

/**
 * Lay several captures out on one canvas and open the result in the editor.
 *
 * Composed in Rust: the pieces are already files there, and doing it in the
 * webview would mean carrying every source image across the IPC bridge first.
 */
export const combineCaptures = (
  paths: string[],
  layout: "row" | "column" | "grid",
  background: string,
) => invoke<void>("combine_captures", { paths, layout, background });

/** Cloud sync folders this Mac has, to offer as one-click backup choices. */
export const backupTargets = () => invoke<BackupTarget[]>("backup_targets");

export const backupSettings = () => invoke<BackupSettings>("backup_settings");

export const backupConfigure = (enabled: boolean, destination: string | null) =>
  invoke<BackupSettings>("backup_configure", { enabled, destination });

/** Copy everything in the library that isn't already at the destination. */
export const backupNow = () => invoke<BackupReport>("backup_now");
