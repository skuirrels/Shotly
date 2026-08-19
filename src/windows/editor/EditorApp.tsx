import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  confirm as confirmDialog,
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { downloadDir, join } from "@tauri-apps/api/path";
import {
  IconCamera,
  IconCanvas,
  IconCheck,
  IconCommand,
  IconCopy,
  IconCrop,
  IconFolder,
  IconGrid,
  IconImage,
  IconLayers,
  IconMeasure,
  IconOverlay,
  IconPen,
  IconGear,
  IconPin,
  IconPlay,
  IconRecord,
  IconRedo,
  IconRefresh,
  IconSave,
  IconTrash,
  IconUndo,
} from "@/components/icons";
import { useKeymap } from "@/lib/keys/useKeymap";
import { isEditingText } from "@/lib/keys/keys";
import type { Command } from "@/lib/keys/types";
import { renderToPng } from "@/lib/export";
import * as ipc from "@/lib/ipc";
import { serialize as serializeMarkup } from "@/lib/markup";
import { measureText } from "@/lib/shapes";
import { captureStem } from "@/lib/naming";
import { overlayFromClipboard } from "@/lib/overlay";
import { useUpdates } from "@/lib/updater";
import type { CaptureMode, CaptureResult, Rect, Scan, Trimmed } from "@/lib/types";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { MAX_STROKE, MIN_STROKE, useEditor } from "@/state/editorStore";
import { Canvas } from "./Canvas";
import { CommandPalette } from "./CommandPalette";
import { EmptyLibrary, PermissionNotice } from "./EmptyState";
import { Library } from "./Library";
import { Player, type Movie } from "./Player";
import { formatDuration } from "./format";
import { RecentStrip } from "./RecentStrip";
import { Settings, type SettingsTab } from "./Settings";
import { WindowPicker } from "./WindowPicker";
import { ShortcutSheet } from "./ShortcutSheet";
import { ScanResult } from "./ScanResult";
import { Toolbar } from "./Toolbar";
import { TopBar } from "./TopBar";
import { UpdateNotice } from "./UpdateNotice";
import { SWATCHES, TOOLS, styleControlsFor } from "./tools";
import type { View } from "./view";

/** Consecutive nudges within this window collapse into one undo step. */
const NUDGE_COALESCE_MS = 600;

/** Whether a saved path is a recording, and so has a player to offer. */
const isMovie = (path: string) => /\.(mov|mp4|m4v)$/i.test(path);

/**
 * `name` inside the user's Downloads folder.
 *
 * Falls back to the bare name if the folder can't be resolved, which puts the
 * dialog wherever it would have opened anyway — a worse default, but never a
 * failed export.
 */
async function downloadsPath(name: string): Promise<string> {
  try {
    return await join(await downloadDir(), name);
  } catch {
    return name;
  }
}

export function EditorApp() {
  const doc = useEditor((s) => s.doc);
  const [palette, setPalette] = useState(false);
  const [sheet, setSheet] = useState(false);
  /** Which Settings tab is showing, or `null` while the dialog is closed. */
  const [settings, setSettings] = useState<SettingsTab | null>(null);
  /**
   * The window picker, opened by window capture.
   *
   * A counter rather than a flag, and used as the component's key: asking for
   * window capture while the picker is already up has to re-read the window
   * list, or it goes on offering the windows that existed a minute ago.
   */
  const [picking, setPicking] = useState(0);
  /** Lines the recogniser found, shown until dismissed. */
  const [scan, setScan] = useState<Scan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  /** Path of the most recent save, so the toast can offer to reveal it. */
  const [saved, setSaved] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  /** Bumped whenever the library's contents change on disk. */
  const [libraryKey, setLibraryKey] = useState(0);
  const [view, setView] = useState<View>("library");
  /**
   * The recording the player is holding.
   *
   * Kept here rather than inside the player so that switching to the library
   * and back doesn't reload the movie — and so the Player tab has something to
   * offer at all.
   */
  const [movie, setMovie] = useState<Movie | null>(null);
  /** How far an upload to the cloud has got, while one is running. */
  const [upload, setUpload] = useState<{ sent: number; total: number } | null>(null);
  /** How far into that recording you had got, so the Player tab holds a place. */
  const resume = useRef<{ path: string; at: number } | null>(null);
  /** Library captures picked for a bulk action, by path. */
  const [picked, setPicked] = useState<string[]>([]);
  /**
   * The same thing for the recents rail, kept apart from `picked`.
   *
   * Two views, two selections: what is picked in the library grid has nothing
   * to do with what is picked in the rail beside the editor, and sharing one
   * list would mean a delete in one view acting on captures chosen in the
   * other — while looking at neither.
   */
  const [recentPicked, setRecentPicked] = useState<string[]>([]);
  /** Everything the library is currently showing, for select-all. */
  const libraryPaths = useRef<string[]>([]);
  const onLibraryItems = useCallback((paths: string[]) => {
    libraryPaths.current = paths;
  }, []);
  /** Timestamp of a close request awaiting confirmation. */
  const pendingClose = useRef(0);
  /**
   * Path of a file the user explicitly opened, if the next incoming document
   * came from Open rather than from the camera. Opening a file must not add a
   * second copy of it to the library.
   */
  const openedFrom = useRef<string | null>(null);
  const libraryDir = useRef<string | null>(null);
  const updates = useUpdates();

  useEffect(() => {
    void ipc.saveLibraryPath().then((p) => (libraryDir.current = p));
  }, []);

  const lastNudge = useRef(0);

  const notify = useCallback((text: string, tone: "ok" | "error" = "ok", ms?: number) => {
    setToast({ text, tone });
    window.setTimeout(() => setToast(null), ms ?? (tone === "error" ? 4200 : 1800));
  }, []);

  /**
   * Stable identity matters here: the library rebuilds its loader from this
   * callback, so an inline arrow made it re-read the whole directory from disk
   * on every render of this component — including every click of a selection.
   */
  const reportError = useCallback((message: string) => notify(message, "error"), [notify]);

  const describe = useCallback(
    (err: unknown) =>
      String(err) === "permission-denied"
        ? "Shotly needs Screen Recording permission. Enable it in System Settings, then relaunch Shotly."
        : `Capture failed: ${err}`,
    [],
  );

  /**
   * Every capture entry point goes through here.
   *
   * These commands reject when permission is missing, and an unhandled
   * rejection is invisible — the button appears to do nothing at all.
   */
  const startCapture = useCallback(
    (mode: CaptureMode) => {
      // Every mode, window included, goes to Rust and is answered in one place
      // there. This used to divert window capture straight to the thumbnail
      // grid without asking Rust at all, which meant the toolbar button and the
      // hotkey did entirely different things: the key drew an outline that
      // followed the pointer, the button photographed every open window first
      // and then offered a contact sheet. Fixing the Rust side left the button
      // untouched and the drift invisible — the grid is still reachable, from
      // the tray, through `editor:pick-window` below.
      const call = mode === "fullscreen" ? ipc.captureFullscreen() : ipc.beginCapture(mode);
      void call.catch((err) => notify(describe(err), "error"));
    },
    [notify, describe],
  );

  /** Capture the chosen window and let the usual open path take it from there. */
  const takeWindow = useCallback(
    (windowId: number) => {
      setPicking(0);
      void ipc.captureWindow(windowId).catch((err) => notify(describe(err), "error"));
    },
    [notify, describe],
  );

  // -------------------------------------------------------------- capture in

  useEffect(() => {
    const openUnlisten = listen<CaptureResult>("editor:open", async (event) => {
      const result = event.payload;
      setSaved(null);
      useEditor.getState().open(result, ipc.assetUrl(result.frame.path));
      // A new capture — or one opened from the library — is always something
      // the user wants to look at, so bring the editor forward.
      setView("editor");

      // An opened file is already on disk — adopt it if it lives in the
      // library so ⌘S edits it in place, but never copy it in again.
      const source = openedFrom.current;
      openedFrom.current = null;
      if (source) {
        const dir = libraryDir.current;
        if (dir && source.startsWith(dir)) useEditor.getState().setLibraryPath(source);
        return;
      }

      // Persist immediately.
      //
      // A capture otherwise lives only in a temp directory until someone
      // remembers ⌘S, so going back to the library discarded it silently — the
      // shot was simply gone. Saving on arrival means the library really is
      // everything you've captured, and ⌘S becomes "update this with my
      // annotations" rather than "or else lose it".
      try {
        const original = await ipc.readCaptureBytes(result.frame.path);
        const path = await ipc.saveToLibrary(original, captureStem());
        useEditor.getState().setLibraryPath(path);
        setLibraryKey((k) => k + 1);
      } catch (err) {
        notify(`Could not add this capture to the library: ${err}`, "error");
      }
    });

    const errorUnlisten = listen<string>("capture:error", (event) =>
      notify(describe(event.payload), "error"),
    );

    // The hotkey and the tray both ask for window capture through Rust, which
    // brings this window forward and hands the choosing back to us.
    const pickUnlisten = listen("editor:pick-window", () => setPicking((n) => n + 1));

    // The menu bar and the app menu both ask for Settings this way, having
    // first brought this window back from wherever it was hidden.
    const settingsUnlisten = listen<SettingsTab>("editor:settings", (event) =>
      setSettings(event.payload ?? "hotkeys"),
    );

    // A recording is filed straight in the library — there is nothing to open
    // in an image editor — so the only thing owed to the user is the news, and
    // a way to the file. The toast offers Show in Finder when `saved` is set.
    const uploadUnlisten = listen<{ sent: number; total: number }>("share:progress", (event) =>
      setUpload(event.payload),
    );

    const recordedUnlisten = listen<string>("record:saved", (event) => {
      setSaved(event.payload);
      notify("Recording saved to your Shotly folder", "ok", 5000);
    });

    // ⌘Z and ⇧⌘Z arrive as menu events, never as keydowns: the Edit menu owns
    // those accelerators at the native level, so the keymap's own Undo entry
    // had never once fired — the key went menu → `undo:` selector → the
    // webview's *text* undo manager → nowhere. Found by pressing ⌘Z over a
    // fresh crop and watching nothing happen.
    //
    // While a text box is being edited, the keys mean the *typing*: the
    // TextEditor under the caret keeps its own burst-coalesced history and
    // answers the same event itself. Everywhere else they mean the canvas.
    const editUnlisten = listen<"undo" | "redo">("editor:edit", (event) => {
      // App-wide accelerator, one listener: ignore it unless this window is
      // the one the user is looking at.
      if (!document.hasFocus()) return;
      if (isEditingText(document.activeElement)) return;
      const state = useEditor.getState();
      if (event.payload === "redo") state.redo();
      else state.undo();
    });

    return () => {
      void openUnlisten.then((fn) => fn());
      void errorUnlisten.then((fn) => fn());
      void pickUnlisten.then((fn) => fn());
      void settingsUnlisten.then((fn) => fn());
      void recordedUnlisten.then((fn) => fn());
      void uploadUnlisten.then((fn) => fn());
      void editUnlisten.then((fn) => fn());
    };
  }, [notify, describe]);

  // ----------------------------------------------------------------- export

  const exportPng = useCallback(async () => {
    const state = useEditor.getState();
    if (!state.doc) return null;
    return renderToPng(state.doc, state.annotations, state.backdrop);
  }, []);

  /**
   * What a save needs alongside the pixels: the markup, and the DPI to stamp.
   *
   * The two save paths had drifted apart once already, so they share this
   * rather than each assembling their own. Only call it with a document open.
   */
  const savePayload = useCallback(() => {
    const state = useEditor.getState();
    const doc = state.doc!;
    return {
      source: doc.path,
      doc: serializeMarkup({
        crop: doc.crop,
        stepCounter: state.stepCounter,
        annotations: state.annotations,
        backdrop: state.backdrop,
        outputScale: doc.outputScale,
      }),
      // A halved @2x capture is a @1x image. Stamping it @2x anyway would make
      // every app that reads the tag display it at half size all over again —
      // so the resize has to come off the claimed density too.
      scale: doc.scale * doc.outputScale,
    };
  }, []);

  /**
   * Discard the open capture and return to the library.
   *
   * Distinct from simply switching to the library view, which keeps the
   * document loaded. Annotations live only in memory, so discarding them
   * silently would lose work: a dirty document asks once and closes on a
   * second press.
   */
  const closeDoc = useCallback(() => {
    const state = useEditor.getState();
    if (!state.doc) return;

    if (state.dirty && Date.now() - pendingClose.current > 4000) {
      pendingClose.current = Date.now();
      notify("Unsaved annotations — ⌘S to save, or close again to discard", "error", 4000);
      return;
    }

    pendingClose.current = 0;
    state.reset();
    setSaved(null);
    setView("library");
    setLibraryKey((k) => k + 1);
  }, [notify]);

  /**
   * Switch panes.
   *
   * Leaving the editor refreshes the library, because the capture on screen
   * has very likely just been saved into it.
   */
  const showView = useCallback(
    (next: View) => {
      if (next === "editor" && !useEditor.getState().doc) return;
      if (next === "player" && !movie) return;
      if (next === "library") setLibraryKey((k) => k + 1);
      setView(next);
    },
    [movie],
  );

  /**
   * Put a link to a capture on the clipboard.
   *
   * The point of it is the recordings: a seven-minute one is three hundred
   * megabytes, which is a link's worth of thing and not an attachment's. One
   * path, whichever cloud is connected — the file goes up from wherever it sits
   * in the library, and comes back as a link that already works. Every way that
   * can fail comes back as something worth reading. See `src-tauri/src/share/`.
   */
  const shareLink = useCallback(
    async (path: string) => {
      setBusy("link");
      try {
        const link = await ipc.shareLink(path);
        await writeText(link.url);
        setSaved(null);
        // `shared` is not decoration: a link that is correct but opens for
        // nobody looks like success on the clipboard and fails at the far end.
        // Google sets the permission as part of the upload, so it is true
        // there; a service that could not would have to be said out loud.
        notify(
          link.shared
            ? "Link copied — anyone with it can view"
            : "Link copied — but it does not open for anyone else yet",
          link.shared ? "ok" : "error",
          link.shared ? 4000 : 5200,
        );
      } catch (e) {
        notify(String(e), "error", 5200);
      } finally {
        setBusy(null);
        setUpload(null);
      }
    },
    [notify],
  );

  /**
   * Watch a recording.
   *
   * The player is a pane like the editor, not a window: a recording is part of
   * the same library as everything else, and sending it out to another app was
   * a strange place for Shotly to stop.
   */
  const playMovie = useCallback((next: Movie) => {
    setMovie(next);
    setView("player");
  }, []);

  /**
   * A trim landed. Watch the short one instead.
   *
   * The trim is a new capture beside the original rather than an edit of it
   * (`src-tauri/src/trim.rs` says why), so there are two things to do: point
   * the player at the file that was just written, and forget where the old one
   * had got to — resuming a thirty-second recording at 0:28 in its eight-second
   * trim would leave you looking at the end of it.
   */
  const onTrimmed = useCallback(
    (trimmed: Trimmed) => {
      resume.current = null;
      setMovie({
        path: trimmed.path,
        name: trimmed.name,
        modified: Date.now(),
        seconds: trimmed.seconds,
      });
      setLibraryKey((k) => k + 1);
      notify(`Trimmed to ${formatDuration(trimmed.seconds)}`);
    },
    [notify],
  );


  /** Load an image from disk — the same entry point for ⌘O and for drag-drop. */
  const openPath = useCallback(
    (path: string) => {
      openedFrom.current = path;
      void ipc.openImage(path).catch((err) => {
        openedFrom.current = null;
        notify(String(err), "error");
      });
    },
    [notify],
  );

  /**
   * Open a capture from the recents rail.
   *
   * Same bargain as ⌘W: annotations live only in memory, so switching away
   * from a dirty document asks once and goes on the second click. The rail is
   * a click away from the canvas at all times, which makes it much easier to
   * hit by accident than a menu command.
   */
  const openRecent = useCallback(
    (path: string) => {
      const state = useEditor.getState();
      if (state.doc?.libraryPath === path) return;

      if (state.dirty && Date.now() - pendingClose.current > 4000) {
        pendingClose.current = Date.now();
        notify("Unsaved annotations — ⌘S to save, or click again to discard", "error", 4000);
        return;
      }

      pendingClose.current = 0;
      openPath(path);
    },
    [notify, openPath],
  );

  const openFile = useCallback(async () => {
    const picked = await openDialog({
      title: "Open image",
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
    });
    if (typeof picked === "string") openPath(picked);
  }, [openPath]);

  /**
   * A blank page, opened like any other document.
   *
   * Deliberately not a mode or a dialog: what arrives is an ordinary capture
   * that happens to be empty, so pasting, the canvas control and every
   * annotation tool work on it without knowing where it came from.
   */
  const newCanvas = useCallback(async () => {
    try {
      await ipc.newCanvas();
      notify("Blank canvas — ⌘V to paste an image onto it", "ok", 2600);
    } catch (e) {
      notify(`Could not make a canvas: ${e}`, "error");
    }
  }, [notify]);

  /**
   * The clipboard's image as a document of its own.
   *
   * The near neighbour of ⌘V, and the difference is what you already have
   * open: ⌘V lays the image over the current capture, this one makes the
   * image the capture. Says so when the clipboard holds text, unlike ⌘V —
   * this was asked for explicitly, so silence would read as a dead command.
   */
  const newFromClipboard = useCallback(async () => {
    try {
      const made = await ipc.newFromClipboard();
      if (!made) notify("No image on the clipboard", "error");
    } catch (e) {
      notify(`Could not open that image: ${e}`, "error");
    }
  }, [notify]);

  // Dropping a file anywhere on the editor opens it.
  useEffect(() => {
    const pending = getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (event.payload.type === "over" || event.payload.type === "enter") {
        setDropping(true);
      } else if (event.payload.type === "drop") {
        setDropping(false);
        const [first] = event.payload.paths;
        if (first) openPath(first);
      } else {
        setDropping(false);
      }
    });

    return () => {
      void pending.then((fn) => fn());
    };
  }, [openPath]);

  /**
   * Guard the export actions.
   *
   * These stay *enabled* with no capture open rather than going inert: a ⌘S
   * that does absolutely nothing is indistinguishable from a broken app, so it
   * says why instead.
   */
  const requireDoc = useCallback(() => {
    if (useEditor.getState().doc) return true;
    notify("Nothing to save yet — press ⌃⇧4 to capture a region", "error", 2600);
    return false;
  }, [notify]);

  /**
   * Copy captures — images and files both, see `ipc`.
   *
   * Takes its paths explicitly rather than reading the selection, because the
   * library's right-click menu can target a capture that was never selected.
   */
  const copyPaths = useCallback(
    async (paths: string[]) => {
      if (busy) return;
      if (paths.length === 0) {
        notify("Select a capture first — click one, or ⌘-click several", "error", 2600);
        return;
      }
      setBusy("copy");
      try {
        await ipc.copyFilesToClipboard(paths);
        notify(paths.length === 1 ? "Copied to clipboard" : `Copied ${paths.length} captures`);
      } catch (e) {
        notify(`Copy failed: ${e}`, "error");
      } finally {
        setBusy(null);
      }
    },
    [busy, notify],
  );

  const copyPicked = useCallback(() => copyPaths(picked), [copyPaths, picked]);

  /**
   * Move captures to the Trash, after asking.
   *
   * Uses the system dialog rather than an in-app modal on purpose: it gets
   * Return and Escape right, and this webview never delivers Escape to the
   * page — a custom sheet would be a confirmation you couldn't back out of
   * with the key everyone reaches for.
   */
  const deleteCaptures = useCallback(
    async (paths: string[]) => {
      // The toolbar button disables itself, but the shortcut doesn't — without
      // this, a second ⌫ stacks another confirmation dialog behind the first.
      if (busy) return;
      if (paths.length === 0) {
        notify("Select a capture first — click one, or ⌘-click several", "error", 2600);
        return;
      }

      const name = paths[0].split("/").pop() ?? "this capture";
      const ok = await confirmDialog(
        paths.length === 1
          ? `Move “${name}” to the Trash?`
          : `Move ${paths.length} captures to the Trash?`,
        {
          title: "Delete captures",
          kind: "warning",
          okLabel: "Move to Trash",
          cancelLabel: "Cancel",
        },
      );
      if (!ok) return;

      setBusy("delete");
      try {
        await ipc.trashCaptures(paths);
        setPicked((prev) => prev.filter((p) => !paths.includes(p)));
        setRecentPicked((prev) => prev.filter((p) => !paths.includes(p)));
        setLibraryKey((k) => k + 1);
        // The player can't go on showing a file that is now in the Trash —
        // and the Player tab can't go on offering it.
        if (movie && paths.includes(movie.path)) {
          setMovie(null);
          setView("library");
        }
        notify(paths.length === 1 ? "Moved to Trash" : `Moved ${paths.length} captures to Trash`);
      } catch (e) {
        notify(`Delete failed: ${e}`, "error");
      } finally {
        setBusy(null);
      }
    },
    [busy, notify, movie],
  );

  const copy = useCallback(async () => {
    if (busy) return;
    if (!requireDoc()) return;
    setBusy("copy");
    try {
      const png = await exportPng();
      if (png) {
        await ipc.copyPngToClipboard(png);
        notify("Copied to clipboard");
      }
    } catch (e) {
      notify(`Copy failed: ${e}`, "error");
    } finally {
      setBusy(null);
    }
  }, [busy, exportPng, notify]);

  /**
   * ⌘V: lay whatever image is on the clipboard over the capture.
   *
   * Silent on text — ⌘V is a general-purpose key, and saying "no image on the
   * clipboard" every time someone pastes out of habit would be nagging. The
   * picker's own button says it, because there the ask was explicit.
   */
  const pasteOverlay = useCallback(async () => {
    if (!requireDoc()) return;
    try {
      const source = await overlayFromClipboard();
      if (!source) return;
      useEditor.getState().addOverlay(source);
      notify("Image overlaid — drag a corner to resize");
    } catch (e) {
      notify(`Could not paste that image: ${e}`, "error");
    }
  }, [notify, requireDoc]);

  /**
   * ⌘S saves straight into ~/Documents/Shotly with no dialog — the whole point
   * of a capture tool is that saving is one keystroke. ⌘⇧S is the escape hatch
   * for putting a capture somewhere else.
   */
  const save = useCallback(async () => {
    if (busy) return;
    if (!requireDoc()) return;

    setBusy("save");
    try {
      const png = await exportPng();
      if (!png) return;

      // Overwrite the copy made when this capture arrived, rather than leaving
      // an un-annotated duplicate behind next to the annotated one.
      const state = useEditor.getState();
      const existing = state.doc?.libraryPath;

      // Saved captures stay editable: the file holds flattened pixels for
      // everyone else, plus the original and these shapes for Shotly. ⌘E
      // writes the flat version when a plain PNG is what's wanted.
      const { source, doc: markup, scale } = savePayload();

      let path: string;
      if (existing) {
        await ipc.saveEditablePng(existing, png, source, markup, scale);
        path = existing;
      } else {
        path = await ipc.saveToLibrary(png, captureStem(), scale, { source, doc: markup });
        state.setLibraryPath(path);
      }

      state.markSaved();
      setSaved(path);
      setLibraryKey((k) => k + 1);
      // Longer than a normal toast: it carries a button worth clicking.
      notify(`Saved to Documents/Shotly/${path.split("/").pop()}`, "ok", 5000);
    } catch (e) {
      notify(`Save failed: ${e}`, "error");
    } finally {
      setBusy(null);
    }
  }, [busy, exportPng, notify, savePayload]);

  /**
   * Save As — the same editable file, somewhere else.
   *
   * Deliberately not the flat one: "save" should mean the same thing wherever
   * it lands, or a capture filed away in a project folder would quietly be the
   * one copy you can no longer edit. Export is the verb for flattening.
   */
  const saveAs = useCallback(async () => {
    if (busy) return;
    if (!requireDoc()) return;

    const path = await saveDialog({
      title: "Save capture",
      defaultPath: `${captureStem()}.png`,
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    if (!path) return;

    setBusy("save");
    try {
      const png = await exportPng();
      if (!png) return;
      const state = useEditor.getState();
      const { source, doc: markup, scale } = savePayload();
      await ipc.saveEditablePng(path, png, source, markup, scale);
      state.markSaved();
      setSaved(path);
      notify("Saved");
    } catch (e) {
      notify(`Save failed: ${e}`, "error");
    } finally {
      setBusy(null);
    }
  }, [busy, exportPng, notify, savePayload]);

  /**
   * Export — flattened pixels and nothing else.
   *
   * The saved-capture format carries the original image alongside the visible
   * one so the markup stays movable, which roughly doubles the file. That is a
   * fine trade for your own library and a poor one for something you are about
   * to attach to an email, so this writes the plain PNG.
   */
  const exportFlat = useCallback(async () => {
    if (busy) return;
    if (!requireDoc()) return;

    const path = await saveDialog({
      title: "Export flattened PNG",
      // Downloads, not the capture library. An export is a copy on its way out
      // of Shotly — into an email, a ticket, a chat — and Downloads is where
      // the rest of the machine already looks for things like that. A bare
      // filename would have reopened wherever the sheet was left last, which
      // for most people is ~/Documents/Shotly: the one folder this file
      // deliberately does not belong in.
      defaultPath: await downloadsPath(`${captureStem()}.png`),
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    if (!path) return;

    // Its own busy id, so the Export button is the one that says what it is
    // doing rather than Save silently claiming to be mid-save.
    setBusy("export");
    try {
      const png = await exportPng();
      if (!png) return;
      await ipc.savePng(path, png, useEditor.getState().doc?.scale);
      setSaved(path);
      notify(`Exported ${path.split("/").pop()}`, "ok", 5000);
    } catch (e) {
      notify(`Export failed: ${e}`, "error");
    } finally {
      setBusy(null);
    }
  }, [busy, exportPng, notify]);

  /**
   * Stick what the editor is showing onto the front of the screen.
   *
   * The flattened view rather than the file underneath, so the annotations
   * come with it: a pin of a screenshot you have just marked up, without the
   * marks, would be the wrong picture.
   */
  const pin = useCallback(async () => {
    if (busy) return;
    if (!requireDoc()) return;

    setBusy("pin");
    try {
      const png = await exportPng();
      if (!png) return;
      await ipc.pinPng(png);
    } catch (e) {
      notify(`Could not pin: ${e}`, "error");
    } finally {
      setBusy(null);
    }
  }, [busy, exportPng, notify, requireDoc]);

  /**
   * Pin a capture straight from the library.
   *
   * Its own path rather than the editor's: nothing has been opened, so there
   * is nothing to flatten — the file on disk is already the picture.
   */
  const pinFile = useCallback(
    (path: string) => void ipc.pinOpen(path).catch((e) => notify(`Could not pin: ${e}`, "error")),
    [notify],
  );

  /**
   * What the canvas's right-click menu can reach.
   *
   * Memoised because it is a prop object: rebuilt every render, it would make
   * the canvas — the most expensive thing on screen — re-render on every
   * keystroke of a text annotation.
   */
  /**
   * Read what the capture says — its text and any code in it — or one box of it.
   *
   * Straight to the clipboard as well as onto the screen: the reason to lift
   * text out of a screenshot is almost always to paste it somewhere, and
   * making that a second gesture would be one too many.
   *
   * A code found in the box wins the clipboard over any text found beside it.
   * Dragging a box around a QR code is an unambiguous request for the link in
   * it, and the caption printed underneath is not what anyone wanted to paste.
   */
  const scanArea = useCallback(
    (area: Rect | null) => {
      const current = useEditor.getState().doc;
      if (!current) return;
      const crop = current.crop;
      const region = area
        ? {
            // Document coordinates are relative to the crop; Rust reads the
            // file underneath it, which still has the whole capture in it.
            x: Math.round(crop.x + area.x),
            y: Math.round(crop.y + area.y),
            width: Math.round(area.width),
            height: Math.round(area.height),
          }
        : {
            x: Math.round(crop.x),
            y: Math.round(crop.y),
            width: Math.round(crop.width),
            height: Math.round(crop.height),
          };

      setBusy("text");
      ipc
        .scanImage(current.path, region)
        .then(async (result) => {
          const copyable =
            result.codes.length > 0
              ? result.codes.map((c) => c.payload).join("\n")
              : result.lines.map((l) => l.text).join("\n");
          if (copyable.length > 0) await writeText(copyable);
          setScan(result);
        })
        .catch((err) => notify(`Could not read that area: ${err}`, "error"))
        .finally(() => setBusy(null));
    },
    [notify],
  );

  /**
   * Lay several library captures out on one canvas.
   *
   * The result arrives back through the usual `editor:open` path, so it is a
   * capture like any other from that point on — annotate it, expand the canvas
   * further, save it into the library.
   */
  const combineFiles = useCallback(
    (paths: string[], layout: "row" | "column" | "grid") => {
      setBusy("combine");
      ipc
        .combineCaptures(paths, layout, "#FFFFFF")
        .catch((e) => notify(`Could not combine those: ${e}`, "error"))
        .finally(() => setBusy(null));
    },
    [notify],
  );

  const canvasActions = useMemo(
    () => ({
      pasteImage: () => void pasteOverlay(),
      copy: () => void copy(),
      exportFlat: () => void exportFlat(),
    }),
    [pasteOverlay, copy, exportFlat],
  );

  // --------------------------------------------------------------- commands

  const commands = useMemo<Command[]>(() => {
    const s = () => useEditor.getState();
    const hasSelection = () => s().selectedIds.length > 0;
    const hasDoc = () => s().doc !== null;

    /**
     * `[` and `]` adjust whichever size the tool in hand actually has.
     *
     * Every size popover has always advertised these keys, but they only ever
     * moved the stroke width — so on the text or blur tool they did nothing at
     * all. Reading the same table the toolbar builds itself from means the
     * keys reach whichever control is on screen.
     */
    const stepSize = (delta: number) => {
      const st = s();
      const kind =
        st.selectedIds.length > 0
          ? st.annotations.find((a) => a.id === st.selectedIds[0])?.kind
          : undefined;
      const controls = styleControlsFor(kind ?? st.tool);
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

      if (controls.font) {
        // Callouts remember their text size separately; the keys have to write
        // whichever slot the popover beside them is reading.
        if ((kind ?? st.tool) === "callout") {
          st.setCalloutFontSize(clamp(st.calloutFontSize + delta * 2, 10, 120));
        } else {
          st.setStyle({ fontSize: clamp(st.style.fontSize + delta * 2, 10, 120) });
        }
      } else if (controls.blur) {
        st.setStyle({ blurRadius: clamp(st.style.blurRadius + delta * 2, 2, 60) });
      } else if (controls.dim) {
        st.setStyle({ dim: clamp(st.style.dim + delta * 0.05, 0.1, 0.95) });
      } else {
        st.setStyle({ strokeWidth: clamp(st.style.strokeWidth + delta, MIN_STROKE, MAX_STROKE) });
      }
    };

    const nudge = (dx: number, dy: number) => {
      const now = Date.now();
      if (now - lastNudge.current > NUDGE_COALESCE_MS) s().snapshot();
      lastNudge.current = now;
      s().nudge(dx, dy);
    };

    const toolCommands: Command[] = TOOLS.map((t) => ({
      id: `tool.${t.id}`,
      title: t.label,
      group: "Tools",
      shortcut: t.shortcut,
      icon: <t.icon />,
      keywords: "tool draw",
      enabled: hasDoc,
      run: () => s().setTool(t.id),
    }));

    const colorCommands: Command[] = SWATCHES.map((sw, i) => ({
      id: `style.color.${sw.value}`,
      title: `Colour: ${sw.name}`,
      group: "Style",
      shortcut: i < 9 ? String(i + 1) : undefined,
      keywords: "colour color ink",
      enabled: hasDoc,
      run: () => s().setStyle({ color: sw.value }),
    }));

    const nudgeCommands: Command[] = (
      [
        ["ArrowUp", 0, -1],
        ["ArrowDown", 0, 1],
        ["ArrowLeft", -1, 0],
        ["ArrowRight", 1, 0],
      ] as const
    ).flatMap(([key, dx, dy]) => [
      {
        id: `edit.nudge.${key}`,
        title: `Nudge ${key.replace("Arrow", "").toLowerCase()}`,
        group: "Edit" as const,
        shortcut: key,
        hidden: true,
        enabled: hasSelection,
        run: () => nudge(dx, dy),
      },
      {
        id: `edit.nudge.${key}.big`,
        title: `Nudge ${key.replace("Arrow", "").toLowerCase()} by 10`,
        group: "Edit" as const,
        shortcut: `Shift+${key}`,
        hidden: true,
        enabled: hasSelection,
        run: () => nudge(dx * 10, dy * 10),
      },
    ]);

    return [
      ...toolCommands,
      ...colorCommands,
      ...nudgeCommands,
      // Note: colour swatches own the bare digits, so digit-based commands
      // must stay behind a modifier to avoid shadowing them.

      // ------------------------------------------------------------- edit
      {
        id: "edit.undo",
        title: "Undo",
        group: "Edit",
        shortcut: "Mod+Z",
        icon: <IconUndo />,
        allowWhileTyping: true,
        enabled: () => s().past.length > 0,
        run: () => s().undo(),
      },
      {
        id: "edit.redo",
        title: "Redo",
        group: "Edit",
        shortcut: "Mod+Shift+Z",
        icon: <IconRedo />,
        allowWhileTyping: true,
        enabled: () => s().future.length > 0,
        run: () => s().redo(),
      },
      {
        id: "edit.delete",
        title: view === "library" ? "Move selected captures to Trash" : "Delete selection",
        group: "Edit",
        shortcut: "Backspace",
        altShortcut: "Delete",
        icon: <IconTrash />,
        enabled: () => (view === "library" ? picked.length > 0 : hasSelection()),
        run: () => (view === "library" ? void deleteCaptures(picked) : s().deleteSelection()),
      },
      {
        id: "edit.trashPicked",
        title: "Move picked captures to Trash",
        group: "Edit",
        // ⌘⌫ rather than the library's bare Backspace, because in the editor
        // that key already belongs to the annotation you have selected. This is
        // Finder's shortcut for the same act, on the rail's own selection.
        shortcut: "Mod+Backspace",
        altShortcut: "Mod+Delete",
        icon: <IconTrash />,
        enabled: () => (view === "library" ? picked.length > 0 : recentPicked.length > 0),
        run: () =>
          void deleteCaptures(view === "library" ? picked : recentPicked),
      },
      {
        id: "edit.duplicate",
        title: "Duplicate",
        group: "Edit",
        shortcut: "Mod+D",
        enabled: hasSelection,
        run: () => s().duplicateSelection(),
      },
      {
        id: "edit.selectAll",
        title: view === "library" ? "Select all captures" : "Select all annotations",
        group: "Edit",
        shortcut: "Mod+A",
        enabled: () =>
          view === "library" ? libraryPaths.current.length > 0 : s().annotations.length > 0,
        run: () =>
          view === "library" ? setPicked([...libraryPaths.current]) : s().selectAll(),
      },
      {
        id: "edit.deselect",
        title: "Deselect",
        group: "Edit",
        shortcut: "Escape",
        hidden: true,
        enabled: () => (view === "library" ? picked.length > 0 : hasDoc()),
        run: () => {
          if (view === "library") {
            setPicked([]);
            return;
          }
          const state = s();
          if (state.pendingCrop) state.setPendingCrop(null);
          else if (state.selectedIds.length > 0) state.clearSelection();
          else state.setTool("select");
        },
      },
      {
        id: "edit.selectNext",
        title: "Select next annotation",
        group: "Edit",
        shortcut: "Tab",
        enabled: () => s().annotations.length > 0,
        run: () => s().selectNext(1),
      },
      {
        id: "edit.selectPrev",
        title: "Select previous annotation",
        group: "Edit",
        shortcut: "Shift+Tab",
        enabled: () => s().annotations.length > 0,
        run: () => s().selectNext(-1),
      },

      // ------------------------------------------------------------ style
      {
        id: "style.smaller",
        title: "Smaller",
        group: "Style",
        shortcut: "[",
        keywords: "thinner stroke font size blur dim",
        enabled: hasDoc,
        run: () => stepSize(-1),
      },
      {
        id: "style.larger",
        title: "Larger",
        group: "Style",
        shortcut: "]",
        keywords: "thicker stroke font size blur dim",
        enabled: hasDoc,
        run: () => stepSize(1),
      },
      {
        id: "style.fill",
        title: "Toggle fill",
        group: "Style",
        shortcut: "F",
        enabled: hasDoc,
        run: () => s().setStyle({ fillOpacity: s().style.fillOpacity > 0 ? 0 : 0.25 }),
      },
      {
        id: "style.shadow",
        title: "Toggle shadow",
        group: "Style",
        shortcut: "Shift+S",
        enabled: hasDoc,
        run: () => s().setStyle({ shadow: !s().style.shadow }),
      },
      {
        id: "style.neon",
        title: "Toggle neon",
        group: "Style",
        shortcut: "Shift+N",
        keywords: "glow lit sign bright border callout box label",
        enabled: hasDoc,
        run: () => s().setStyle({ neon: !s().style.neon }),
      },

      // ---------------------------------------------------------- arrange
      {
        id: "arrange.forward",
        title: "Bring forward",
        group: "Arrange",
        shortcut: "Mod+]",
        icon: <IconLayers />,
        enabled: hasSelection,
        run: () => s().reorder("forward"),
      },
      {
        id: "arrange.backward",
        title: "Send backward",
        group: "Arrange",
        shortcut: "Mod+[",
        icon: <IconLayers />,
        enabled: hasSelection,
        run: () => s().reorder("backward"),
      },
      {
        id: "arrange.front",
        title: "Bring to front",
        group: "Arrange",
        shortcut: "Mod+Shift+]",
        enabled: hasSelection,
        run: () => s().reorder("front"),
      },
      {
        id: "arrange.back",
        title: "Send to back",
        group: "Arrange",
        shortcut: "Mod+Shift+[",
        enabled: hasSelection,
        run: () => s().reorder("back"),
      },
      {
        id: "arrange.applyCrop",
        title: "Apply crop",
        group: "Arrange",
        shortcut: "Enter",
        icon: <IconCrop />,
        enabled: () => s().pendingCrop !== null,
        run: () => {
          const crop = s().pendingCrop;
          if (crop && crop.width > 1 && crop.height > 1) s().applyCrop(crop);
        },
      },

      /**
       * Write the capture's own size onto it.
       *
       * A plain text annotation rather than a fixed stamp, so it can be
       * dragged, recoloured, resized or deleted like anything else — and so
       * the number is baked at the moment you asked, which is what makes it
       * meaningful after a later crop.
       */
      {
        id: "arrange.imprintSize",
        title: "Imprint dimensions",
        group: "Arrange",
        icon: <IconMeasure />,
        enabled: hasDoc,
        run: () => {
          const st = s();
          const doc = st.doc;
          if (!doc) return;

          const retina = doc.scale > 1;
          const points = retina && st.style.measureUnits === "pt";
          const w = points ? doc.crop.width / doc.scale : doc.crop.width;
          const h = points ? doc.crop.height / doc.scale : doc.crop.height;
          const label = `${Math.round(w)} × ${Math.round(h)}${points ? "pt" : "px"}`;

          const fontSize = st.style.fontSize;
          const m = measureText(label, fontSize);
          const inset = Math.round(Math.min(doc.crop.width, doc.crop.height) * 0.02);

          st.add({
            id: crypto.randomUUID(),
            kind: "text",
            // Bottom-right, out of the way of whatever the capture is of.
            x: Math.max(0, doc.crop.width - m.width - inset),
            y: Math.max(0, doc.crop.height - m.height - inset),
            width: m.width,
            height: m.height,
            text: label,
            style: { ...st.style },
          });
        },
      },

      // ------------------------------------------------------------- view
      {
        id: "view.zoomIn",
        title: "Zoom in",
        group: "View",
        shortcut: "Mod+=",
        enabled: hasDoc,
        run: () => s().setZoom(s().zoom * 1.25),
      },
      {
        id: "view.zoomOut",
        title: "Zoom out",
        group: "View",
        shortcut: "Mod+-",
        enabled: hasDoc,
        run: () => s().setZoom(s().zoom / 1.25),
      },
      {
        id: "view.fit",
        title: "Zoom to fit",
        group: "View",
        shortcut: "Mod+0",
        enabled: hasDoc,
        run: () => s().setFitToWindow(true),
      },
      {
        id: "view.actual",
        title: "Actual size",
        group: "View",
        shortcut: "Mod+1",
        enabled: hasDoc,
        run: () => s().setZoom(1),
      },
      {
        id: "view.palette",
        title: "Command palette",
        group: "View",
        shortcut: "Mod+K",
        icon: <IconCommand />,
        allowWhileTyping: true,
        run: () => setPalette(true),
      },
      {
        id: "view.shortcuts",
        title: "Keyboard shortcuts",
        group: "View",
        shortcut: "Mod+/",
        // `?` as well: it's the near-universal convention for this panel, and
        // it survives keyboard layouts where ⌘/ is awkward to reach.
        altShortcut: "Shift+/",
        allowWhileTyping: true,
        run: () => setSheet((v) => !v),
      },

      // ---------------------------------------------------------- capture
      {
        id: "capture.region",
        title: "Capture region",
        group: "Capture",
        shortcut: "Mod+Shift+4",
        icon: <IconCamera />,
        run: () => startCapture("region"),
      },
      {
        id: "capture.window",
        title: "Capture window",
        group: "Capture",
        shortcut: "Mod+Shift+5",
        icon: <IconCamera />,
        run: () => startCapture("window"),
      },
      {
        id: "capture.screen",
        title: "Capture full screen",
        group: "Capture",
        shortcut: "Mod+Shift+3",
        icon: <IconCamera />,
        run: () => startCapture("fullscreen"),
      },

      {
        id: "capture.record",
        title: "Record area or window…",
        group: "Capture",
        shortcut: "Mod+Shift+R",
        icon: <IconRecord />,
        keywords: "video movie screen recording capture mov film",
        run: () =>
          void ipc.recordBegin().catch((err) => notify(describe(err), "error")),
      },
      {
        id: "capture.recordScreen",
        title: "Record whole screen",
        group: "Capture",
        icon: <IconRecord />,
        keywords: "video movie screen recording display mov film",
        run: () =>
          void ipc.recordScreen().catch((err) => notify(describe(err), "error")),
      },

      {
        id: "capture.annotate",
        title: "Annotate screen (live)",
        group: "Capture",
        shortcut: "Mod+Shift+A",
        icon: <IconPen />,
        keywords: "draw over screen share presentation live markup",
        run: () =>
          void ipc.annotateToggle().catch((err) => notify(`Annotation failed: ${err}`, "error")),
      },
      {
        id: "app.settings",
        title: "Settings",
        group: "View",
        shortcut: "Mod+,",
        icon: <IconGear />,
        keywords: "preferences hotkeys shortcuts keys backup google drive dropbox copy folder",
        allowWhileTyping: true,
        run: () => setSettings("hotkeys"),
      },
      {
        id: "capture.pin",
        title: "Pin to screen",
        group: "Capture",
        shortcut: "Mod+Shift+P",
        icon: <IconPin />,
        keywords: "float always on top reference overlay stick",
        enabled: hasDoc,
        run: () => void pin(),
      },
      {
        id: "capture.openFile",
        title: "Open image…",
        group: "Capture",
        shortcut: "Mod+O",
        icon: <IconFolder />,
        keywords: "load import png jpeg file existing",
        run: () => void openFile(),
      },
      {
        id: "capture.newCanvas",
        title: "New blank image",
        group: "Capture",
        shortcut: "Mod+N",
        icon: <IconCanvas />,
        keywords: "blank canvas empty page compose arrange collage new document",
        run: () => void newCanvas(),
      },
      {
        id: "capture.newFromClipboard",
        title: "New image from clipboard",
        group: "Capture",
        shortcut: "Mod+Shift+V",
        icon: <IconImage />,
        keywords: "paste clipboard copied screenshot new document open",
        run: () => void newFromClipboard(),
      },

      {
        id: "edit.overlayPaste",
        title: "Overlay image from clipboard",
        group: "Edit",
        shortcut: "Mod+V",
        icon: <IconOverlay />,
        keywords: "paste image picture on top composite",
        run: () => void pasteOverlay(),
      },

      // ----------------------------------------------------------- export
      {
        id: "export.copy",
        title: view === "library" ? "Copy selected captures" : "Copy to clipboard",
        group: "Export",
        shortcut: "Mod+C",
        icon: <IconCopy />,
        // Deliberately not gated on `hasDoc` — see `requireDoc`.
        run: () => void (view === "library" ? copyPicked() : copy()),
      },
      {
        id: "export.save",
        title: "Save to Documents/Shotly",
        group: "Export",
        shortcut: "Mod+S",
        icon: <IconSave />,
        keywords: "export png library",
        run: () => void save(),
      },
      {
        id: "export.saveAs",
        title: "Save as…",
        group: "Export",
        shortcut: "Mod+Shift+S",
        icon: <IconSave />,
        keywords: "export png elsewhere location editable",
        run: () => void saveAs(),
      },
      {
        id: "export.flatten",
        title: "Export flattened PNG…",
        group: "Export",
        shortcut: "Mod+E",
        icon: <IconImage />,
        keywords: "flatten share paste attach plain smaller no markup",
        run: () => void exportFlat(),
      },
      {
        id: "export.reveal",
        title: "Show last save in Finder",
        group: "Export",
        shortcut: "Mod+Shift+R",
        enabled: () => saved !== null,
        run: () => saved && void ipc.revealInFinder(saved),
      },
      {
        id: "view.toggleLibrary",
        title: view === "editor" ? "Library" : "Back to the editor",
        group: "View",
        shortcut: "Mod+L",
        icon: view === "editor" ? <IconGrid /> : <IconImage />,
        keywords: "library browse captures recent switch editor",
        // With nothing open there is only one pane, so there is nothing to
        // toggle between.
        enabled: hasDoc,
        run: () => showView(view === "editor" ? "library" : "editor"),
      },
      {
        id: "app.checkUpdates",
        title: "Check for updates",
        group: "View",
        icon: <IconRefresh />,
        keywords: "update upgrade version new release install",
        run: updates.check,
      },
      {
        id: "export.close",
        title: "Close",
        group: "Export",
        shortcut: "Mod+W",
        keywords: "close window dismiss",
        // ⌘W closes the *document* first, matching every other macOS app;
        // only from the library does it put the window away.
        run: () => (useEditor.getState().doc ? closeDoc() : void ipc.hideEditor()),
      },
    ];
  }, [
    copy,
    pasteOverlay,
    save,
    saveAs,
    exportFlat,
    saved,
    startCapture,
    openFile,
    newCanvas,
    newFromClipboard,
    closeDoc,
    showView,
    view,
    copyPicked,
    deleteCaptures,
    picked,
    recentPicked,
    updates.check,
  ]);

  // The editor pane needs something to show; without a document the library is
  // the only thing there is, whatever the last explicit choice was. Same rule
  // for the player and its movie.
  const activeView: View =
    view === "player" ? (movie ? "player" : "library") : doc ? view : "library";

  // Modals own the keyboard while they're up — and so does the player, which
  // binds Space, the arrows and the rest of a transport for itself. Leaving
  // the editor's map live underneath would mean an arrow key both seeking the
  // movie and nudging an annotation in the pane behind it.
  useKeymap(commands, !palette && !sheet && !settings && activeView !== "player");

  return (
    <div className="flex h-full flex-col bg-canvas">
      <TopBar
        view={activeView}
        canEdit={doc !== null}
        player={
          movie && {
            name: movie.name,
            onReveal: () => void ipc.revealInFinder(movie.path),
            onExternal: () =>
              void ipc
                .openExternally(movie.path)
                .catch((e) => notify(`Could not open that recording: ${e}`, "error")),
            onDelete: () => void deleteCaptures([movie.path]),
            onCopyLink: () => void shareLink(movie.path),
          }
        }
        onView={showView}
        onCapture={startCapture}
        onOpenFile={() => void openFile()}
        onNewCanvas={() => void newCanvas()}
        onNewFromClipboard={() => void newFromClipboard()}
        onCopy={() => void (activeView === "library" ? copyPicked() : copy())}
        onDelete={() => void deleteCaptures(picked)}
        onSave={() => void save()}
        onExportFlat={() => void exportFlat()}
        pickedCount={picked.length}
        busy={busy}
      />

      <main className="relative flex flex-1 overflow-hidden">
        {activeView === "editor" ? (
          <>
            <RecentStrip
              refreshKey={libraryKey}
              currentPath={doc?.libraryPath}
              selected={recentPicked}
              onSelect={setRecentPicked}
              onOpen={openRecent}
              onCopy={copyPaths}
              onDelete={(paths) => void deleteCaptures(paths)}
              onError={reportError}
            />
            <Canvas onNotify={notify} actions={canvasActions} onScan={scanArea} />
          </>
        ) : activeView === "player" && movie ? (
          <Player
            movie={movie}
            startAt={resume.current?.path === movie.path ? resume.current.at : 0}
            onLeave={(at) => (resume.current = { path: movie.path, at })}
            onClose={() => showView("library")}
            onTrimmed={onTrimmed}
            onError={reportError}
          />
        ) : (
          // Clicking anywhere that isn't a capture clears the selection, the
          // way it does in Finder. On the whole pane rather than the grid, so
          // the empty space below a short library counts too.
          <div
            className="flex flex-1 flex-col items-center overflow-y-auto bg-inset px-8 pt-7 pb-7"
            // The context menu is portalled to <body>, but React still bubbles
            // its clicks through the React tree — so it has to be excluded
            // here, or choosing "Copy 3 captures" would clear the selection
            // out from under the action.
            onClick={(e) => {
              const el = e.target as HTMLElement;
              if (!el.closest("[data-capture-card]") && !el.closest("[data-context-menu]")) {
                setPicked([]);
              }
            }}
          >
            <div className="w-full max-w-[1100px]">
              <PermissionNotice />
            </div>
            <Library
              refreshKey={libraryKey}
              onOpen={openPath}
              onPlay={playMovie}
              onCopy={(paths) => void copyPaths(paths)}
              onDelete={(paths) => void deleteCaptures(paths)}
              onError={reportError}
              empty={<EmptyLibrary />}
              selected={picked}
              onSelect={setPicked}
              onItems={onLibraryItems}
              onPin={pinFile}
              onCombine={combineFiles}
              onShareLink={(path) => void shareLink(path)}
            />
          </div>
        )}
        {activeView === "editor" && (
          <Toolbar currentPath={doc?.libraryPath} onNotify={notify} />
        )}

        {dropping && (
          <div className="animate-in-fade pointer-events-none absolute inset-3 z-50 grid place-items-center rounded-2xl border-2 border-dashed border-accent bg-canvas/80">
            <div className="text-center">
              <p className="text-[15px] font-semibold text-ink">Drop to open</p>
              <p className="mt-1 text-[12.5px] text-ink-3">PNG or JPEG</p>
            </div>
          </div>
        )}
      </main>

      {/* A recording is hundreds of megabytes; an upload with no progress is
          indistinguishable from one that has stalled. */}
      {upload && upload.total > 0 && (
        <div className="surface-pop fixed bottom-24 left-1/2 z-[9600] w-[280px] -translate-x-1/2 rounded-xl px-3.5 py-2.5">
          <p className="flex items-center justify-between text-[12px] text-ink">
            <span>Uploading to Drive…</span>
            <span className="font-mono text-[11px] tabular-nums text-ink-3">
              {Math.round((upload.sent / upload.total) * 100)}%
            </span>
          </p>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-200"
              style={{ width: `${Math.min(100, (upload.sent / upload.total) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {toast && (
        <div
          className={[
            "surface-pop animate-in-pop fixed bottom-24 left-1/2 z-[9500] flex -translate-x-1/2",
            "items-center gap-2 rounded-xl px-3.5 py-2 text-[12.5px]",
            toast.tone === "error" ? "text-danger" : "text-ink",
          ].join(" ")}
          role="status"
        >
          {toast.tone === "ok" && <IconCheck className="text-success" />}
          <span className="max-w-[420px]">{toast.text}</span>

          {/* A recording that has just been filed is one you almost certainly
              want to watch — that is what you stopped it for. */}
          {toast.tone === "ok" && saved && isMovie(saved) && (
            <button
              type="button"
              onClick={() =>
                playMovie({
                  path: saved,
                  name: saved.split("/").pop() ?? "Recording",
                  modified: Date.now(),
                  seconds: 0,
                })
              }
              className="ml-1 flex items-center gap-1 rounded-md bg-accent/20 px-2 py-0.5 text-[11.5px] text-accent hover:bg-accent/30"
            >
              <IconPlay />
              Play
            </button>
          )}

          {toast.tone === "ok" && saved && (
            <button
              type="button"
              onClick={() => void ipc.revealInFinder(saved)}
              className="ml-1 rounded-md bg-white/[0.08] px-2 py-0.5 text-[11.5px] text-ink-2 hover:bg-white/[0.14] hover:text-ink"
            >
              Show in Finder
            </button>
          )}
        </div>
      )}

      <UpdateNotice status={updates.status} onCheck={updates.check} onDismiss={updates.dismiss} />

      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
      {sheet && (
        <ShortcutSheet
          commands={commands}
          onEditHotkeys={() => {
            setSheet(false);
            setSettings("hotkeys");
          }}
          onClose={() => setSheet(false)}
        />
      )}

      {settings && <Settings tab={settings} onClose={() => setSettings(null)} />}

      {picking > 0 && (
        <WindowPicker
          key={picking}
          onCapture={takeWindow}
          onClose={() => setPicking(0)}
          onError={reportError}
        />
      )}

      {scan && (
        <ScanResult
          scan={scan}
          onCopy={(text) => {
            void writeText(text);
            notify(text.includes("\n") ? "Text copied" : `Copied “${text}”`);
          }}
          onClose={() => setScan(null)}
        />
      )}
    </div>
  );
}
