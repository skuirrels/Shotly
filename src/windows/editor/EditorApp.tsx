import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  confirm as confirmDialog,
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  IconCamera,
  IconCheck,
  IconCommand,
  IconCopy,
  IconCrop,
  IconFolder,
  IconGrid,
  IconImage,
  IconLayers,
  IconPen,
  IconRedo,
  IconRefresh,
  IconSave,
  IconTrash,
  IconUndo,
} from "@/components/icons";
import { useKeymap } from "@/lib/keys/useKeymap";
import type { Command } from "@/lib/keys/types";
import { renderToPng } from "@/lib/export";
import * as ipc from "@/lib/ipc";
import { serialize as serializeMarkup } from "@/lib/markup";
import { useUpdates } from "@/lib/updater";
import type { CaptureMode, CaptureResult } from "@/lib/types";
import { useEditor } from "@/state/editorStore";
import { Canvas } from "./Canvas";
import { CommandPalette } from "./CommandPalette";
import { EmptyLibrary, PermissionNotice } from "./EmptyState";
import { Library } from "./Library";
import { ShortcutSheet } from "./ShortcutSheet";
import { Toolbar } from "./Toolbar";
import { TopBar } from "./TopBar";
import { UpdateNotice } from "./UpdateNotice";
import { SWATCHES, TOOLS } from "./tools";
import type { View } from "./view";

/** Consecutive nudges within this window collapse into one undo step. */
const NUDGE_COALESCE_MS = 600;

export function EditorApp() {
  const doc = useEditor((s) => s.doc);
  const [palette, setPalette] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  /** Path of the most recent save, so the toast can offer to reveal it. */
  const [saved, setSaved] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  /** Bumped whenever the library's contents change on disk. */
  const [libraryKey, setLibraryKey] = useState(0);
  const [view, setView] = useState<View>("library");
  /** Library captures picked for a bulk action, by path. */
  const [picked, setPicked] = useState<string[]>([]);
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
      const call = mode === "fullscreen" ? ipc.captureFullscreen() : ipc.beginCapture(mode);
      void call.catch((err) => notify(describe(err), "error"));
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
        const path = await ipc.saveToLibrary(original, defaultStem());
        useEditor.getState().setLibraryPath(path);
        setLibraryKey((k) => k + 1);
      } catch (err) {
        notify(`Could not add this capture to the library: ${err}`, "error");
      }
    });

    const errorUnlisten = listen<string>("capture:error", (event) =>
      notify(describe(event.payload), "error"),
    );

    return () => {
      void openUnlisten.then((fn) => fn());
      void errorUnlisten.then((fn) => fn());
    };
  }, [notify, describe]);

  // ----------------------------------------------------------------- export

  const exportPng = useCallback(async () => {
    const state = useEditor.getState();
    if (!state.doc) return null;
    return renderToPng(state.doc, state.annotations);
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
  const showView = useCallback((next: View) => {
    if (next === "editor" && !useEditor.getState().doc) return;
    if (next === "library") setLibraryKey((k) => k + 1);
    setView(next);
  }, []);

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

  const openFile = useCallback(async () => {
    const picked = await openDialog({
      title: "Open image",
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
    });
    if (typeof picked === "string") openPath(picked);
  }, [openPath]);

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
        setLibraryKey((k) => k + 1);
        notify(paths.length === 1 ? "Moved to Trash" : `Moved ${paths.length} captures to Trash`);
      } catch (e) {
        notify(`Delete failed: ${e}`, "error");
      } finally {
        setBusy(null);
      }
    },
    [busy, notify],
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

  /** macOS-style capture filename: "Shotly 2026-08-14 at 18.33.21". */
  const defaultStem = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const time = `${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
    return `Shotly ${date} at ${time}`;
  };

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
      const scale = state.doc?.scale;

      // Saved captures stay editable: the file holds flattened pixels for
      // everyone else, plus the original and these shapes for Shotly. ⌘E
      // writes the flat version when a plain PNG is what's wanted.
      const editable = {
        source: state.doc!.path,
        doc: serializeMarkup({
          crop: state.doc!.crop,
          stepCounter: state.stepCounter,
          annotations: state.annotations,
        }),
      };

      let path: string;
      if (existing) {
        await ipc.saveEditablePng(existing, png, editable.source, editable.doc, scale);
        path = existing;
      } else {
        path = await ipc.saveToLibrary(png, defaultStem(), scale, editable);
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
  }, [busy, exportPng, notify]);

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
      defaultPath: `${defaultStem()}.png`,
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    if (!path) return;

    setBusy("save");
    try {
      const png = await exportPng();
      if (!png) return;
      const state = useEditor.getState();
      await ipc.saveEditablePng(
        path,
        png,
        state.doc!.path,
        serializeMarkup({
          crop: state.doc!.crop,
          stepCounter: state.stepCounter,
          annotations: state.annotations,
        }),
        state.doc?.scale,
      );
      state.markSaved();
      setSaved(path);
      notify("Saved");
    } catch (e) {
      notify(`Save failed: ${e}`, "error");
    } finally {
      setBusy(null);
    }
  }, [busy, exportPng, notify]);

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
      defaultPath: `${defaultStem()}.png`,
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    if (!path) return;

    setBusy("save");
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

  // --------------------------------------------------------------- commands

  const commands = useMemo<Command[]>(() => {
    const s = () => useEditor.getState();
    const hasSelection = () => s().selectedIds.length > 0;
    const hasDoc = () => s().doc !== null;

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
        id: "style.thinner",
        title: "Thinner stroke",
        group: "Style",
        shortcut: "[",
        enabled: hasDoc,
        run: () => s().setStyle({ strokeWidth: Math.max(1, s().style.strokeWidth - 1) }),
      },
      {
        id: "style.thicker",
        title: "Thicker stroke",
        group: "Style",
        shortcut: "]",
        enabled: hasDoc,
        run: () => s().setStyle({ strokeWidth: Math.min(40, s().style.strokeWidth + 1) }),
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
        id: "capture.openFile",
        title: "Open image…",
        group: "Capture",
        shortcut: "Mod+O",
        icon: <IconFolder />,
        keywords: "load import png jpeg file existing",
        run: () => void openFile(),
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
    save,
    saveAs,
    exportFlat,
    saved,
    startCapture,
    openFile,
    closeDoc,
    showView,
    view,
    copyPicked,
    deleteCaptures,
    picked,
    updates.check,
  ]);

  // Modals own the keyboard while they're up.
  useKeymap(commands, !palette && !sheet);

  // The editor pane needs something to show; without a document the library is
  // the only thing there is, whatever the last explicit choice was.
  const activeView: View = doc ? view : "library";

  return (
    <div className="flex h-full flex-col bg-canvas">
      <TopBar
        view={activeView}
        canEdit={doc !== null}
        onView={showView}
        onCapture={startCapture}
        onOpenFile={() => void openFile()}
        onCopy={() => void (activeView === "library" ? copyPicked() : copy())}
        onDelete={() => void deleteCaptures(picked)}
        onSave={() => void save()}
        pickedCount={picked.length}
        busy={busy}
      />

      <main className="relative flex flex-1 overflow-hidden">
        {activeView === "editor" ? (
          <Canvas />
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
              onCopy={(paths) => void copyPaths(paths)}
              onDelete={(paths) => void deleteCaptures(paths)}
              onError={reportError}
              empty={<EmptyLibrary />}
              selected={picked}
              onSelect={setPicked}
              onItems={onLibraryItems}
            />
          </div>
        )}
        {activeView === "editor" && <Toolbar />}

        {dropping && (
          <div className="animate-in-fade pointer-events-none absolute inset-3 z-50 grid place-items-center rounded-2xl border-2 border-dashed border-accent bg-canvas/80">
            <div className="text-center">
              <p className="text-[15px] font-semibold text-ink">Drop to open</p>
              <p className="mt-1 text-[12.5px] text-ink-3">PNG or JPEG</p>
            </div>
          </div>
        )}
      </main>

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
      {sheet && <ShortcutSheet commands={commands} onClose={() => setSheet(false)} />}
    </div>
  );
}
