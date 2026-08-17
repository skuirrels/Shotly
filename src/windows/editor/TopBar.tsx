import { useState, type ReactNode } from "react";
import clsx from "clsx";
import {
  IconCamera,
  IconChevronDown,
  IconCopy,
  IconDisplay,
  IconExternal,
  IconFit,
  IconFolder,
  IconGrid,
  IconImage,
  IconLink,
  IconPlay,
  IconRedo,
  IconRegion,
  IconSave,
  IconScroll,
  IconTrash,
  IconUndo,
  IconWindow,
  IconZoomIn,
  IconZoomOut,
} from "@/components/icons";
import { IconButton } from "@/components/ui/IconButton";
import { Kbd } from "@/components/ui/Kbd";
import { Popover } from "@/components/ui/Popover";
import { BackdropPicker } from "./BackdropPicker";
import { CanvasPicker } from "./CanvasPicker";
import { ResizePicker } from "./ResizePicker";
import * as ipc from "@/lib/ipc";
import { Tooltip } from "@/components/ui/Tooltip";
import type { CaptureMode } from "@/lib/types";
import { useEditor } from "@/state/editorStore";
import type { View } from "./view";

/** What the bar shows in place of the editing controls while a movie is open. */
export interface PlayerBar {
  name: string;
  onReveal: () => void;
  onExternal: () => void;
  onDelete: () => void;
  /** Copy a share link to this recording — the way to send a big one. */
  onCopyLink: () => void;
}

interface Props {
  view: View;
  /** Whether there is a capture to switch back to. */
  canEdit: boolean;
  /** The recording the player is holding, if there is one. */
  player: PlayerBar | null;
  onView: (view: View) => void;
  onCapture: (mode: CaptureMode) => void;
  onOpenFile: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onSave: () => void;
  /** Write the annotations into the pixels, without the re-editable payload. */
  onExportFlat: () => void;
  /** How many library captures are selected. Only meaningful in the library. */
  pickedCount: number;
  busy: string | null;
}

const MODES: { mode: CaptureMode; label: string; hint: string; shortcut: string; icon: typeof IconRegion }[] = [
  { mode: "region", label: "Region", hint: "Drag any area", shortcut: "Mod+Shift+4", icon: IconRegion },
  { mode: "window", label: "Window", hint: "Pick a window", shortcut: "Mod+Shift+5", icon: IconWindow },
  { mode: "fullscreen", label: "Screen", hint: "Whole display", shortcut: "Mod+Shift+3", icon: IconDisplay },
];

/**
 * Window chrome. Doubles as the drag region for the frameless titlebar, with
 * a left inset reserving space for the macOS traffic lights.
 *
 * The editing controls — undo, zoom, copy, save — are hidden rather than
 * disabled in the library, where none of them mean anything. A toolbar of
 * greyed-out buttons reads as broken; a short one reads as the right tool for
 * what is on screen.
 */
export function TopBar({
  view,
  canEdit,
  player,
  onView,
  onCapture,
  onOpenFile,
  onCopy,
  onDelete,
  onSave,
  onExportFlat,
  pickedCount,
  busy,
}: Props) {
  const doc = useEditor((s) => s.doc);
  const zoom = useEditor((s) => s.zoom);
  const fitToWindow = useEditor((s) => s.fitToWindow);
  const setZoom = useEditor((s) => s.setZoom);
  const setFitToWindow = useEditor((s) => s.setFitToWindow);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);

  const editing = view === "editor";
  // Copy and Delete act on the library's selection, so they belong to the
  // library and not merely to "not the editor" — the player has a selection of
  // exactly one, and it is the movie on screen, which the player says itself.
  const browsing = view === "library";
  const watching = view === "player" && player !== null;

  return (
    // `data-tauri-drag-region` is what actually makes this a title bar: it
    // gives the window drag-to-move and double-click-to-zoom. The CSS
    // `-webkit-app-region` property does nothing here — that is Electron's
    // mechanism, and WKWebView does not implement it.
    //
    // Only the element carrying the attribute drags, so the buttons inside
    // stay clickable without any opt-out of their own.
    <header
      data-tauri-drag-region
      className="titlebar-drag relative z-30 flex h-12 shrink-0 items-center gap-1 border-b border-line-subtle bg-surface pr-2.5 pl-[86px]"
    >
      <ViewSwitch view={view} canEdit={canEdit} canPlay={player !== null} onView={onView} />

      {editing && (
        <>
          <span className="mx-1.5 h-5 w-px bg-line" />
          <IconButton
            icon={<IconUndo />}
            label="Undo"
            shortcut="Mod+Z"
            disabled={!canUndo}
            onClick={undo}
          />
          <IconButton
            icon={<IconRedo />}
            label="Redo"
            shortcut="Mod+Shift+Z"
            disabled={!canRedo}
            onClick={redo}
          />
        </>
      )}

      {/* Centred in the space between the two button groups rather than across
          the whole bar. Absolute centring kept it perfectly still as buttons
          changed width, but it also let a wider group run straight over it —
          which is what the Export button did to "@2x". A few pixels of drift
          while a button says "Saving…" is the cheaper of the two. */}
      <div className="pointer-events-none flex min-w-0 flex-1 justify-center px-2">
        {editing && doc && <ResizePicker />}
        {/* The player has no document, so the space the resize control would
            occupy carries the one thing it can't show elsewhere: which
            recording you are watching. */}
        {watching && (
          <p className="truncate text-[12.5px] font-medium text-ink-2" title={player.name}>
            {player.name.replace(/\.(mov|mp4|m4v)$/i, "")}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {/* Copying straight from the library skips a round trip through the
            editor when all you wanted was to paste a shot somewhere. */}
        {browsing && (
          <Tooltip
            label={pickedCount > 0 ? "Copy selected captures" : "Select a capture to copy"}
            shortcut="Mod+C"
          >
            <button
              type="button"
              onClick={onCopy}
              disabled={pickedCount === 0 || busy !== null}
              className="no-drag mr-1 flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.07] px-2.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-white/[0.11] active:bg-white/[0.14] disabled:opacity-40"
            >
              <IconCopy />
              {busy === "copy" ? "Copying…" : "Copy"}
              {pickedCount > 0 && (
                <span className="ml-0.5 rounded bg-black/30 px-1.5 font-mono text-[10.5px] tabular-nums text-ink-2">
                  {pickedCount}
                </span>
              )}
            </button>
          </Tooltip>
        )}

        {/* Destructive, so it stays quiet until hovered and always asks first. */}
        {browsing && (
          <Tooltip
            label={pickedCount > 0 ? "Move selected captures to Trash" : "Select a capture to delete"}
            shortcut="Backspace"
          >
            <button
              type="button"
              onClick={onDelete}
              disabled={pickedCount === 0 || busy !== null}
              className="no-drag mr-1 flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.07] px-2.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-danger/18 hover:text-danger active:bg-danger/25 disabled:opacity-40 disabled:hover:bg-white/[0.07] disabled:hover:text-ink"
            >
              <IconTrash />
              {busy === "delete" ? "Deleting…" : "Delete"}
            </button>
          </Tooltip>
        )}

        {/* Everything you might want to do to a recording that isn't playing
            it. Trashing one you have just watched is the common case — that is
            usually why you watched it — so it earns a button rather than a
            trip back to the grid. */}
        {watching && (
          <>
            <IconButton
              icon={<IconFolder />}
              label="Show in Finder"
              onClick={player.onReveal}
            />
            {/* A recording is far too big to send as a file, so the useful
                verb here is not "share" but "copy the link to it". */}
            <Tooltip label="Upload this recording and copy a link to it">
              <button
                type="button"
                onClick={player.onCopyLink}
                disabled={busy !== null}
                className="no-drag mr-1 flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.07] px-2.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-white/[0.11] active:bg-white/[0.14] disabled:opacity-40"
              >
                <IconLink />
                {busy === "link" ? "Linking…" : "Copy link"}
              </button>
            </Tooltip>
            <Tooltip label="Open in the system movie player">
              <button
                type="button"
                onClick={player.onExternal}
                className="no-drag mr-1 flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.07] px-2.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-white/[0.11] active:bg-white/[0.14]"
              >
                <IconExternal />
                Open in…
              </button>
            </Tooltip>
            <Tooltip label="Move this recording to the Trash">
              <button
                type="button"
                onClick={player.onDelete}
                className="no-drag mr-1 flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.07] px-2.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-danger/18 hover:text-danger active:bg-danger/25"
              >
                <IconTrash />
                Delete
              </button>
            </Tooltip>
          </>
        )}

        <CaptureMenu onCapture={onCapture} onOpenFile={onOpenFile} />

        {editing && (
          <>
            <div className="mx-1 flex items-center gap-0.5 rounded-lg bg-black/25 p-0.5">
              <IconButton
                icon={<IconZoomOut />}
                label="Zoom out"
                shortcut="Mod+-"
                onClick={() => setZoom(zoom / 1.25)}
              />
              <Tooltip label="Zoom to fit" shortcut="Mod+0">
                <button
                  type="button"
                  onClick={() => setFitToWindow(true)}
                  className={clsx(
                    "no-drag h-[30px] min-w-[54px] rounded-md px-1.5 font-mono text-[11px] tabular-nums transition-colors",
                    fitToWindow ? "text-accent" : "text-ink-2 hover:bg-hover hover:text-ink",
                  )}
                >
                  {fitToWindow ? "Fit" : `${Math.round(zoom * 100)}%`}
                </button>
              </Tooltip>
              <IconButton
                icon={<IconZoomIn />}
                label="Zoom in"
                shortcut="Mod+="
                onClick={() => setZoom(zoom * 1.25)}
              />
              <IconButton
                icon={<IconFit />}
                label="Actual size"
                shortcut="Mod+1"
                onClick={() => setZoom(1)}
              />
            </div>

            {/* Before Copy and Export, because framing is something you do
                *to* the capture, and those two are what you do with it. */}
            <CanvasPicker disabled={!doc || busy !== null} />
            <BackdropPicker disabled={!doc || busy !== null} />

            <button
              type="button"
              onClick={onCopy}
              disabled={!doc || busy !== null}
              className="no-drag flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.07] px-2.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-white/[0.11] active:bg-white/[0.14] disabled:opacity-40"
            >
              <IconCopy />
              {busy === "copy" ? "Copying…" : "Copy"}
              <span className="ml-0.5 font-sans text-[11px] text-ink-3">⌘C</span>
            </button>

            {/* Export earns its own button. Sending someone a flattened PNG is
                an ending — the thing you do once the annotating is finished —
                and an ending should not be two clicks behind a chevron. */}
            <button
              type="button"
              onClick={onExportFlat}
              disabled={!doc || busy !== null}
              title="Flattened PNG — annotations burned in, no longer editable"
              className="no-drag ml-1 flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.07] px-2.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-white/[0.11] active:bg-white/[0.14] disabled:opacity-40"
            >
              <IconImage />
              {busy === "export" ? "Exporting…" : "Export"}
              <span className="ml-0.5 font-sans text-[11px] text-ink-3">⌘E</span>
            </button>

            {/* One button, one click. This was a split button whose chevron
                offered Save as… and Export; Export now has a button of its own
                beside it, which left a menu carrying one item and a duplicate.
                Save as… keeps ⇧⌘S and its row in the command palette — the
                right home for something reached once in a while. */}
            <button
              type="button"
              onClick={onSave}
              disabled={!doc || busy !== null}
              className="no-drag flex h-8 items-center gap-1.5 rounded-lg bg-accent px-2.5 text-[12.5px] font-semibold text-accent-fg transition-colors hover:bg-accent-hi active:bg-accent-lo disabled:opacity-40"
            >
              <IconSave />
              {busy === "save" ? "Saving…" : "Save"}
              <span className="ml-0.5 font-sans text-[11px] opacity-60">⌘S</span>
            </button>
          </>
        )}
      </div>
    </header>
  );
}

/** Editor / Library / Player, as a segmented control. */
function ViewSwitch({
  view,
  canEdit,
  canPlay,
  onView,
}: {
  view: View;
  canEdit: boolean;
  canPlay: boolean;
  onView: (v: View) => void;
}) {
  const segment = (
    target: View,
    label: string,
    icon: ReactNode,
    shortcut: string | undefined,
    enabled: boolean,
  ) => (
    <Tooltip label={label} shortcut={shortcut}>
      <button
        type="button"
        role="tab"
        aria-selected={view === target}
        disabled={!enabled}
        onClick={() => onView(target)}
        className={clsx(
          "no-drag flex h-[30px] items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium transition-colors",
          view === target
            ? "bg-white/[0.10] text-ink"
            : "text-ink-3 hover:text-ink disabled:hover:text-ink-3",
          !enabled && "opacity-35",
        )}
      >
        {icon}
        {label}
      </button>
    </Tooltip>
  );

  return (
    <div role="tablist" className="flex items-center gap-0.5 rounded-lg bg-black/25 p-0.5">
      {/* Disabled with nothing open: the editor would have nothing to show, and
          a tab that switches to an empty pane is worse than one you can't press. */}
      {segment("editor", "Editor", <IconImage />, "Mod+L", canEdit)}
      {segment("library", "Library", <IconGrid />, "Mod+L", true)}
      {/* Only while there is a recording to go back to. Unlike the editor tab
          this one is absent rather than disabled: a permanently dead Player
          tab would suggest the app plays nothing at all. */}
      {canPlay && segment("player", "Player", <IconPlay />, undefined, true)}
    </div>
  );
}

/** Remembered so the button keeps doing whatever you last asked it to do. */
const MODE_KEY = "shotly.captureMode";

function storedMode(): CaptureMode {
  const saved = localStorage.getItem(MODE_KEY) as CaptureMode | null;
  return saved && MODES.some((m) => m.mode === saved) ? saved : "region";
}

/**
 * Capture as a split button: the main half fires one mode, the chevron offers
 * the others.
 *
 * The main half is labelled with the mode it will actually run — "Region", not
 * "Capture" — because a button called Capture sitting above a menu of three
 * capture modes gives no clue which of the three you get by pressing it. The
 * menu marks the same mode as current, and picking a different one both
 * captures immediately and rebinds the button, so it settles on whichever mode
 * you actually use.
 */
function CaptureMenu({
  onCapture,
  onOpenFile,
}: {
  onCapture: (mode: CaptureMode) => void;
  onOpenFile: () => void;
}) {
  const [mode, setMode] = useState<CaptureMode>(storedMode);
  const active = MODES.find((m) => m.mode === mode) ?? MODES[0];

  const pick = (next: CaptureMode) => {
    setMode(next);
    localStorage.setItem(MODE_KEY, next);
    onCapture(next);
  };

  return (
    <div className="flex items-center overflow-hidden rounded-lg bg-white/[0.07]">
      <Tooltip label={`Capture ${active.hint.toLowerCase()}`} shortcut={active.shortcut}>
        <button
          type="button"
          onClick={() => onCapture(mode)}
          className="no-drag flex h-8 items-center gap-1.5 pr-2 pl-2.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-white/[0.07] active:bg-white/[0.12]"
        >
          <IconCamera />
          {active.label}
        </button>
      </Tooltip>

      <span className="h-4 w-px bg-white/10" />

      <Popover
        align="center"
        trigger={({ open, toggle }) => (
          <button
            type="button"
            onClick={toggle}
            aria-label="Capture options"
            aria-expanded={open}
            className={clsx(
              "no-drag grid h-8 w-6 place-items-center text-ink-2 transition-colors hover:bg-white/[0.07] hover:text-ink",
              open && "bg-white/[0.12] text-ink",
            )}
          >
            <IconChevronDown className="size-3.5" width={14} height={14} />
          </button>
        )}
      >
        {({ close }) => (
          <div className="w-[228px]">
            {MODES.map((m) => {
              const current = m.mode === mode;
              return (
                <button
                  key={m.mode}
                  type="button"
                  aria-current={current}
                  onClick={() => {
                    close();
                    pick(m.mode);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover"
                >
                  <span className={current ? "text-accent" : "text-ink-2"}>
                    <m.icon />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
                      {m.label}
                      {/* Ties the menu back to the button: this is the one the
                          button itself runs. */}
                      {current && (
                        <span className="rounded bg-accent/16 px-1.5 py-px text-[9.5px] font-semibold tracking-wide text-accent uppercase">
                          Button
                        </span>
                      )}
                    </span>
                    <span className="block text-[11px] text-ink-4">{m.hint}</span>
                  </span>
                  <Kbd shortcut={m.shortcut} muted />
                </button>
              );
            })}

            <div className="my-1.5 h-px bg-line" />

            {/* Not one of the MODES: it can't be the button's default because
                it isn't a one-shot capture — it opens a session. */}
            <button
              type="button"
              onClick={() => {
                close();
                void ipc.scrollBegin();
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover"
            >
              <span className="text-ink-2">
                <IconScroll />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-medium text-ink">Scrolling capture</span>
                <span className="block text-[11px] text-ink-4">
                  A page taller than the screen, stitched as you scroll
                </span>
              </span>
              <Kbd shortcut="Ctrl+Shift+6" muted />
            </button>

            {/* Works with no permission at all — the editor doesn't need the OS. */}
            <button
              type="button"
              onClick={() => {
                close();
                onOpenFile();
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover"
            >
              <span className="text-ink-2">
                <IconFolder />
              </span>
              <span className="min-w-0 flex-1 text-[12.5px] font-medium text-ink">Open an image…</span>
              <Kbd shortcut="Mod+O" muted />
            </button>
          </div>
        )}
      </Popover>
    </div>
  );
}
