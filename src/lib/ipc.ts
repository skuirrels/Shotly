import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { CaptureMode, CaptureResult, LibraryItem, WindowInfo } from "./types";

/** Turn a Frame's absolute path into something an <img> can load. */
export function assetUrl(path: string): string {
  return convertFileSrc(path);
}

export const capturePermissionStatus = () => invoke<boolean>("capture_permission_status");
export const requestCapturePermission = () => invoke<boolean>("request_capture_permission");
export const openScreenRecordingSettings = () => invoke<void>("open_screen_recording_settings");
export const restartApp = () => invoke<void>("restart_app");

export const beginCapture = (mode: CaptureMode) => invoke<void>("begin_capture", { mode });
export const cancelCapture = () => invoke<void>("cancel_capture");

export const captureFullscreen = (displayId?: number) =>
  invoke<CaptureResult>("capture_fullscreen", { displayId: displayId ?? null });

export const listWindows = () => invoke<WindowInfo[]>("list_windows");

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

export const hideEditor = () => invoke<void>("hide_editor");

/** Toggle the live screen-annotation layer. */
export const annotateToggle = () => invoke<void>("annotate_toggle");
