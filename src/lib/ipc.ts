import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type {
  BackupReport,
  BackupSettings,
  BackupTarget,
  CaptureMode,
  CaptureResult,
  HotkeyAction,
  HotkeyBinding,
  LibraryItem,
  Scan,
  ShareLink,
  TextIndexProgress,
  ShareProvider,
  Trimmed,
  TrimMode,
  TrimPrecision,
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

/** A blank page to arrange captures on, opened as a document of its own. */
export const newCanvas = () => invoke<CaptureResult>("new_canvas");

/**
 * The clipboard's image as a new document. `null` when the clipboard holds
 * something else, which is an ordinary answer rather than a failure.
 */
export const newFromClipboard = () => invoke<CaptureResult | null>("new_from_clipboard");

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
  redacted?: Uint8Array | null,
) =>
  invoke<void>("save_editable_png", {
    path,
    bytes: Array.from(bytes),
    source,
    doc,
    scale: scale ?? null,
    redacted: redacted ? Array.from(redacted) : null,
  });

/** Save into ~/Documents/Shotly without a dialog. Resolves to the final path. */
export const saveToLibrary = (
  bytes: Uint8Array,
  stem: string,
  scale?: number,
  editable?: { source: string; doc: string; redacted?: Uint8Array | null },
) =>
  invoke<string>("save_to_library", {
    bytes: Array.from(bytes),
    stem,
    scale: scale ?? null,
    source: editable?.source ?? null,
    doc: editable?.doc ?? null,
    redacted: editable?.redacted ? Array.from(editable.redacted) : null,
  });

export const saveLibraryPath = () => invoke<string>("save_library_path");

export const revealInFinder = (path: string) => invoke<void>("reveal_in_finder", { path });

/**
 * Which captures have this text written in them.
 *
 * Answered from the index rather than by reading pictures, so it is a map
 * lookup — a capture the reader has not got to yet simply isn't in the answer
 * yet. See `src-tauri/src/textindex.rs`.
 */
export const searchText = (query: string) => invoke<string[]>("search_text", { query });

/** Read up to `budget` captures that haven't been read yet. */
export const textIndexStep = (budget: number) =>
  invoke<TextIndexProgress>("text_index_step", { budget });

export const textIndexProgress = () => invoke<TextIndexProgress>("text_index_progress");

/** Forget the lot and read the library again. */
export const textIndexReset = () => invoke<void>("text_index_reset");

/**
 * Start a native drag of these files, out of the window and into another app.
 *
 * Resolves as soon as the drag is running rather than when it is dropped: from
 * that moment it belongs to the window server, and where it lands is between
 * the user and whatever they let go over. See `lib/dragout` for the gesture and
 * `src-tauri/src/platform/macos/dragout.rs` for why the web view can't do it.
 */
export const dragOut = (paths: string[]) => invoke<void>("drag_out", { paths });

/**
 * Does a fresh capture land in the corner instead of opening the editor?
 *
 * Off unless someone has said otherwise: it changes what the capture key does,
 * and that is not a habit to rearrange under anybody. See
 * `src-tauri/src/shelf.rs`.
 */
export const shelfEnabled = () => invoke<boolean>("shelf_enabled");
export const setShelfEnabled = (enabled: boolean) =>
  invoke<void>("set_shelf_enabled", { enabled });

/**
 * Hand a file to whatever the system opens it with.
 *
 * Recordings, in practice: a movie has nothing to annotate, so the library
 * sends it to QuickTime Player rather than into an editor built for pictures.
 */
export const openExternally = (path: string) => invoke<void>("open_externally", { path });

/**
 * Upload one capture to the connected cloud, share it, and hand back the link.
 *
 * The way to send a recording: a seven-minute one is three hundred megabytes,
 * which is a link's worth of thing and not an attachment's. It sends the file
 * where it actually is — the Shotly folder — and nothing else goes with it.
 *
 * Emits `share:progress` as it goes; rejects with something worth showing when
 * nothing is connected. See `src-tauri/src/share/`.
 */
export const shareLink = (path: string) => invoke<ShareLink>("share_link", { path });

/** Where a capture can be sent, and what is connected right now. */
export const shareProviders = () => invoke<ShareProvider[]>("share_providers");
/** Whether anything at all is connected — what the share button asks. */
export const shareConnected = () => invoke<boolean>("share_connected");
export const shareConnect = (id: string) => invoke<boolean>("share_connect", { id });
export const shareDisconnect = (id: string) => invoke<void>("share_disconnect", { id });

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

/**
 * Shorten a recording about two marks, and file the result in the library.
 *
 * Marks are in seconds; `mode` says which side of them to throw away. The
 * original is never touched — the answer is a new capture beside it, which is
 * what the player switches to. Lossless, and about as quick as copying the
 * file. Reports `trim:progress` (0..1) while it runs. See
 * `src-tauri/src/trim.rs`.
 */
export const videoTrim = (
  path: string,
  start: number,
  end: number,
  mode: TrimMode,
  precision: TrimPrecision,
) => invoke<Trimmed>("video_trim", { path, start, end, mode, precision });

/**
 * The instants a trim mark may sit on: the recording's keyframes, in seconds.
 *
 * A cut can only begin where a frame decodes on its own, so the player snaps
 * its handles to these — which is what keeps the mark you can see and the mark
 * that gets used the same number. See `src-tauri/src/trim.rs`.
 */
export const videoSyncPoints = (path: string) => invoke<number[]>("video_sync_points", { path });

/** Cloud sync folders this Mac has, to offer as one-click backup choices. */
export const backupTargets = () => invoke<BackupTarget[]>("backup_targets");

export const backupSettings = () => invoke<BackupSettings>("backup_settings");

export const backupConfigure = (enabled: boolean, destination: string | null) =>
  invoke<BackupSettings>("backup_configure", { enabled, destination });

/** Copy everything in the library that isn't already at the destination. */
export const backupNow = () => invoke<BackupReport>("backup_now");
