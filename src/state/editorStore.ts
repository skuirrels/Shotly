import { create } from "zustand";
import { type Backdrop, DEFAULT_BACKDROP, NO_BACKDROP } from "@/lib/backdrop";
import { rerouted } from "@/lib/connect";
import { parse as parseMarkup } from "@/lib/markup";
import { spunBoundsOf } from "@/lib/shapes";
import { type OverlaySource, placeOverlay } from "@/lib/overlay";
import { readColor, readNumber, readString, write } from "@/lib/prefs";
import {
  type Annotation,
  type CaptureResult,
  type Rect,
  type Style,
  type ToolId,
  TOOL_IDS,
  boundsOf,
  isBox,
  isLine,
  isPen,
  isStep,
  movedBy,
} from "@/lib/types";

export interface Doc {
  id: number;
  /** Asset-protocol URL of the captured PNG, for display. */
  src: string;
  /** The same file's absolute path, for the exporter to read bytes from. */
  path: string;
  /**
   * Where this capture lives in ~/Documents/Shotly.
   *
   * Every capture is persisted the moment it arrives, so navigating away can't
   * lose it. ⌘S then re-renders annotations over this same file rather than
   * piling up a second copy.
   */
  libraryPath?: string;
  /** Natural pixel size of that PNG, before any crop. */
  naturalWidth: number;
  naturalHeight: number;
  /**
   * The visible window onto the source image, in source pixels. Cropping is
   * non-destructive — it moves this rect rather than re-encoding, so it stays
   * undoable and lossless. Annotation coordinates are relative to its origin.
   */
  crop: Rect;
  scale: number;
  /**
   * How much of its natural size the exported image is drawn at. 1 is native.
   *
   * Non-destructive, exactly like the crop above: it changes what comes out of
   * the exporter, never the pixels on disk or the coordinates of a single
   * annotation. So it is undoable, it survives a save-and-reopen, and halving
   * a capture and putting it back leaves a file identical to the one you would
   * have had without touching it.
   *
   * The editor deliberately keeps working at full size while this is set.
   * Shrinking the canvas the user is drawing on would make every annotation
   * harder to place in exchange for showing them something they already know.
   */
  outputScale: number;
  /**
   * What shows through where the capture doesn't reach.
   *
   * The crop is a window onto the source image, and nothing ever said the
   * window had to be *inside* it. Pull an edge outward and the document grows
   * past the capture, leaving bare canvas to arrange other things on — which
   * is the whole of "combine several captures", with no second coordinate
   * system and no new field on any annotation.
   */
  canvasFill: string;
}

/** Does this document show any canvas the capture doesn't cover? */
export function hasBareCanvas(doc: Doc): boolean {
  const { x, y, width, height } = doc.crop;
  return x < 0 || y < 0 || x + width > doc.naturalWidth || y + height > doc.naturalHeight;
}

/** Document-space size, i.e. what the canvas and exporter actually work in. */
export function docSize(doc: Doc): { width: number; height: number } {
  return { width: doc.crop.width, height: doc.crop.height };
}

/** What the exporter will actually write, once the output scale is applied. */
export function outputSize(doc: Doc): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(doc.crop.width * doc.outputScale)),
    height: Math.max(1, Math.round(doc.crop.height * doc.outputScale)),
  };
}

/**
 * Where a fresh annotation starts.
 *
 * Sizes are in *image* pixels, and a Retina capture carries two of those for
 * every point on screen — so these numbers read about half as large as they
 * look written down. Judged against a real @2x capture rather than picked: at
 * 32px an annotation was smaller than the body text of the page underneath it,
 * which is the wrong way round for something meant to be read first. 48 sits
 * above body text without reaching the headings, and a 10px stroke gives an
 * arrow enough weight to compete with the interface it is pointing at.
 */
const DEFAULT_STYLE: Style = {
  color: "#FF3B30",
  strokeWidth: 10,
  fontSize: 48,
  fillOpacity: 0,
  // Square, because a rectangle drawn round a button or a paragraph is a
  // rectangle. The old fixed 4px was neither one thing nor the other: too
  // small to read as rounded at @2x, large enough to leave the corners
  // looking soft where they were meant to be sharp.
  cornerRadius: 0,
  blurRadius: 12,
  dim: 0.55,
  shadow: true,
  neon: false,
  measureUnits: "pt",
};

/**
 * Where a fresh callout's text starts, kept apart from the size above.
 *
 * Bare text has to compete with the screenshot underneath it, which is why the
 * default there is heading-sized. A callout arrives with its own solid block of
 * colour and has won that fight before a word is read, so the same 48px landed
 * as a banner rather than a label. Remembered separately, so choosing a size
 * for one doesn't resize the other.
 */
const DEFAULT_CALLOUT_FONT_SIZE = 32;

/**
 * What bare canvas is, until someone says otherwise.
 *
 * White rather than transparent: the reason to grow a canvas is to put two
 * screenshots side by side and send the result, and a transparent gap between
 * them renders as a checkerboard here and as black in half the apps it might
 * be pasted into.
 */
const DEFAULT_CANVAS_FILL = "#FFFFFF";

/** Tools that don't create geometry and so shouldn't be sticky after a drag. */
const TRANSIENT_TOOLS: ToolId[] = ["crop"];

const TOOL_KEY = "shotly.tool";

/**
 * Where each tool's ink is kept, one entry per tool.
 *
 * Ink used to be one setting shared by everything, which meant picking yellow
 * for a highlight made the next arrow yellow — and nobody has ever wanted a
 * yellow arrow. In practice a person has *a way they draw arrows* and *a way
 * they highlight*, and those are different decisions that happen to be made
 * with the same controls.
 *
 * The slot name is the tool id, which for every drawing tool is also the
 * annotation kind it produces. That coincidence is what lets a change made
 * with a shape selected land in the right slot without a lookup table:
 * recolouring a selected arrow teaches the arrow tool, whatever tool is
 * actually in hand.
 */
const STYLE_PREFIX = "shotly.style.";

/**
 * The keys the single shared style used to live in.
 *
 * Read once, as the starting point for a slot that has never been written, so
 * that upgrading doesn't throw away the colour and weight someone has been
 * working in. Never written again — a slot saves itself the first time it is
 * changed, and after that these are dead.
 */
const LEGACY_COLOR_KEY = "shotly.color";
const LEGACY_STROKE_KEY = "shotly.strokeWidth";
const LEGACY_RADIUS_KEY = "shotly.cornerRadius";

/**
 * The range a stroke width may take.
 *
 * Exported so the size control and the `[` / `]` keys enforce the same numbers
 * this validates a restored width against. Two copies that drifted would mean
 * either a stored width the interface can't reach — a slider pinned to one end
 * drawing something else — or a width the controls can produce and the reader
 * throws away on the next launch.
 */
export const MIN_STROKE = 1;
export const MAX_STROKE = 40;

/**
 * The range a rectangle's corner radius may take, in image pixels.
 *
 * Zero is a real value here rather than a floor to guard against — it is the
 * square corner, and the reason the control has a slider at all. The ceiling
 * is generous because the radius is clamped again to half the shorter side
 * when the shape is drawn, so a number too large for a particular box is
 * already harmless; this only stops a stored one growing without limit.
 */
export const MIN_RADIUS = 0;
export const MAX_RADIUS = 200;

/**
 * The rest of the ranges, for the same reason as the two above.
 *
 * These were written twice before this file remembered whole styles: once as
 * clamps in the `[` / `]` handler and once nowhere at all, because nothing was
 * ever restored from disk to be validated. Now that a stored style can contain
 * any of them, the numbers have to live in one place.
 */
export const MIN_FONT = 10;
export const MAX_FONT = 120;
export const MIN_BLUR = 2;
export const MAX_BLUR = 60;
export const MIN_DIM = 0.1;
export const MAX_DIM = 0.95;

/**
 * Tools that put something on the page, and so have ink worth remembering.
 *
 * The others either take a colour rather than give one (`pick`), read the
 * image (`grab`), or change the document without drawing on it (`crop`,
 * `select`). Switching to one of those leaves the current ink alone, so that
 * cropping and coming back doesn't land you in some other tool's palette.
 */
const DRAWING_TOOLS: ToolId[] = TOOL_IDS.filter(
  (t) => !["select", "pick", "grab", "crop"].includes(t),
);

/** Where a tool's ink starts out differently from the common default. */
const SLOT_DEFAULTS: Record<string, Partial<Style>> = {
  callout: { fontSize: DEFAULT_CALLOUT_FONT_SIZE },
};

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A stored number, if it is one and still inside the range the controls use. */
function number(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
}

const boolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

/**
 * A remembered style, field by field, with anything unrecognisable discarded.
 *
 * Every value is checked rather than trusted, for the reason `lib/prefs`
 * gives: a stored number from a version whose slider reached further than this
 * one does would leave the interface somewhere its own controls cannot get it
 * out of. Falling back per field rather than per style means one bad number
 * costs one setting instead of all of them.
 */
function sanitize(raw: unknown, base: Style): Style {
  if (typeof raw !== "object" || raw === null) return base;
  const v = raw as Record<string, unknown>;
  return {
    color: typeof v.color === "string" && HEX.test(v.color) ? v.color : base.color,
    strokeWidth: number(v.strokeWidth, base.strokeWidth, MIN_STROKE, MAX_STROKE),
    fontSize: number(v.fontSize, base.fontSize, MIN_FONT, MAX_FONT),
    fillOpacity: number(v.fillOpacity, base.fillOpacity, 0, 1),
    cornerRadius: number(v.cornerRadius, base.cornerRadius, MIN_RADIUS, MAX_RADIUS),
    blurRadius: number(v.blurRadius, base.blurRadius, MIN_BLUR, MAX_BLUR),
    dim: number(v.dim, base.dim, MIN_DIM, MAX_DIM),
    shadow: boolean(v.shadow, base.shadow),
    neon: boolean(v.neon, base.neon),
    measureUnits: v.measureUnits === "px" || v.measureUnits === "pt" ? v.measureUnits : base.measureUnits,
  };
}

/** What a slot starts as before anyone has drawn with it. */
function defaultsFor(slot: string): Style {
  const base: Style = { ...DEFAULT_STYLE, ...(SLOT_DEFAULTS[slot] ?? {}) };
  // The old shared settings, if this is the first run since they were split.
  return sanitize(
    {
      color: readColor(LEGACY_COLOR_KEY, base.color),
      strokeWidth: readNumber(LEGACY_STROKE_KEY, base.strokeWidth, MIN_STROKE, MAX_STROKE),
      cornerRadius: readNumber(LEGACY_RADIUS_KEY, base.cornerRadius, MIN_RADIUS, MAX_RADIUS),
    },
    base,
  );
}

/** The ink a tool was last drawing with. See `lib/prefs` on the guarded read. */
function storedStyle(slot: string): Style {
  const base = defaultsFor(slot);
  const saved = readString(STYLE_PREFIX + slot);
  if (saved === null) return base;
  try {
    return sanitize(JSON.parse(saved), base);
  } catch {
    return base;
  }
}

function rememberStyle(slot: string, style: Style): void {
  if (!DRAWING_TOOLS.includes(slot as ToolId)) return;
  write(STYLE_PREFIX + slot, JSON.stringify(style));
}

/**
 * Tools that are never remembered between sessions.
 *
 * Each is somewhere you go to do one thing and then leave, and two of the three
 * are already modelled that way here: `crop` is transient after a drag, and
 * `pick` keeps [`pickReturn`] so that one use puts the previous tool back.
 * `grab` reads text out of the image rather than drawing on it. Opening Shotly
 * into any of them would mean starting a session unable to draw and with
 * nothing obviously wrong.
 */
const UNREMEMBERED_TOOLS: ToolId[] = ["crop", "pick", "grab"];

/**
 * The tool in hand when Shotly was last used.
 *
 * A stored id that is no longer a tool is discarded — otherwise removing a tool
 * in some future version leaves a toolbar with nothing highlighted and a canvas
 * that ignores the mouse. See `lib/prefs` for why the read is guarded.
 */
function storedTool(): ToolId {
  const saved = readString(TOOL_KEY);
  return TOOL_IDS.includes(saved as ToolId) ? (saved as ToolId) : "select";
}

function rememberTool(tool: ToolId): void {
  if (UNREMEMBERED_TOOLS.includes(tool)) return;
  write(TOOL_KEY, tool);
}

/**
 * Which slot a style change belongs in.
 *
 * The selection wins over the tool, because a change made with a shape
 * selected is a change to *that kind of shape* — the toolbar is already
 * showing its controls, and remembering it against whatever tool happens to be
 * in hand would teach the wrong one.
 */
function slotFor(s: { annotations: Annotation[]; selectedIds: string[]; tool: ToolId }): string {
  return selectedShape(s)?.kind ?? s.tool;
}

function selectedShape(s: { annotations: Annotation[]; selectedIds: string[] }): Annotation | undefined {
  const first = s.selectedIds[0];
  return first ? s.annotations.find((a) => a.id === first) : undefined;
}

/**
 * The style the controls should be showing.
 *
 * With a shape selected that is the shape's own look, because that is what the
 * controls are about to change — the toolbar used to show the tool's ink while
 * editing a shape drawn in something else, so every control read as wrong until
 * you touched it.
 */
export function shownStyle(s: {
  annotations: Annotation[];
  selectedIds: string[];
  style: Style;
}): Style {
  return selectedShape(s)?.style ?? s.style;
}

/**
 * What a slot is working from, when it isn't the tool in hand.
 *
 * The selected shape's own style, not the stored one: the toolbar is showing
 * that shape's numbers, so a change made there has to be remembered as the
 * shape now looks rather than as the slot last happened to be saved.
 */
function slotStyle(s: { annotations: Annotation[]; selectedIds: string[] }, slot: string): Style {
  const selected = selectedShape(s);
  return selected?.kind === slot ? selected.style : storedStyle(slot);
}

interface HistoryEntry {
  annotations: Annotation[];
  stepCounter: number;
  /** Crop is undoable alongside annotations, so it rides in the same entry. */
  crop: Rect | null;
  /** As is the output scale — both live on the doc, both change the export. */
  outputScale: number | null;
  /** As is the frame: choosing one is an edit like any other. */
  backdrop: Backdrop;
}

interface EditorState {
  doc: Doc | null;
  annotations: Annotation[];
  selectedIds: string[];
  tool: ToolId;
  /** Where the picker hands control back to once a colour has been taken. */
  pickReturn: ToolId;
  /**
   * The ink the next shape will be drawn with.
   *
   * Whichever slot the current tool reads from — see `STYLE_PREFIX`. Swapped
   * out from under the toolbar when the tool changes, which is the whole point
   * of remembering one per tool.
   */
  style: Style;
  /** A style lifted off a shape, waiting to be pasted onto another. */
  clipboardStyle: Style | null;
  stepCounter: number;
  /** The frame drawn around the capture on export. */
  backdrop: Backdrop;
  /** Set while a crop gesture is pending confirmation. */
  pendingCrop: Rect | null;
  zoom: number;
  /** True when zoom should track the viewport instead of a fixed value. */
  fitToWindow: boolean;
  dirty: boolean;

  past: HistoryEntry[];
  future: HistoryEntry[];

  open: (result: CaptureResult, src: string) => void;
  setLibraryPath: (path: string) => void;
  /** Called after a successful write, so ⌘W stops claiming there's unsaved work. */
  markSaved: () => void;
  reset: () => void;

  setTool: (tool: ToolId) => void;
  setStyle: (patch: Partial<Style>) => void;
  /** Lift the selected shape's look, for `pasteStyle` to put on another. */
  copyStyle: () => boolean;
  /** Put the lifted look on everything selected. */
  pasteStyle: () => boolean;
  setBackdrop: (patch: Partial<Backdrop>) => void;
  /** Resize the exported image. 1 is native; see `Doc.outputScale`. */
  setOutputScale: (scale: number) => void;
  setCanvasFill: (fill: string) => void;
  /** Add bare canvas on one side, in document pixels. */
  expandCanvas: (edge: "top" | "right" | "bottom" | "left", amount: number) => void;
  /** Grow (or shrink) the canvas to exactly hold everything on it. */
  fitCanvasToContent: () => void;
  setZoom: (zoom: number) => void;
  setFitToWindow: (fit: boolean) => void;

  /** Snapshot current state onto the undo stack. Call once before a gesture. */
  snapshot: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  add: (annotation: Annotation) => void;
  /** Lay another image over this one, centred, selected and ready to resize. */
  addOverlay: (source: OverlaySource) => void;
  update: (id: string, patch: Partial<Annotation>) => void;
  replaceAll: (annotations: Annotation[]) => void;
  remove: (ids: string[]) => void;
  deleteSelection: () => void;
  duplicateSelection: () => void;

  group: () => void;
  ungroup: () => void;
  lock: () => void;
  unlockAll: () => number;
  align: (edge: AlignEdge) => void;
  distribute: (axis: "x" | "y") => void;

  select: (ids: string[]) => void;
  toggleSelect: (id: string) => void;
  selectAll: () => void;
  clearSelection: () => void;
  selectNext: (delta: number) => void;

  nudge: (dx: number, dy: number) => void;
  reorder: (mode: "front" | "back" | "forward" | "backward") => void;

  setPendingCrop: (rect: Rect | null) => void;
  applyCrop: (rect: Rect) => void;

  nextStepLabel: () => number;
}

/**
 * Everything that comes up with these: a group is picked up whole.
 *
 * Applied inside `select` rather than at each of the half-dozen places that
 * choose a selection — clicking, shift-clicking, Tab, Select All, the marquee
 * — because a group that came apart in one of them would be a group nobody
 * could trust. Removing works the same way in reverse: whatever is not in the
 * list stays out, and only the mates of what *is* there are added.
 */
function withGroups(annotations: Annotation[], ids: string[]): string[] {
  const groups = new Set(
    annotations.filter((a) => ids.includes(a.id) && a.group).map((a) => a.group),
  );
  if (groups.size === 0) return ids;
  const out = new Set(ids);
  for (const a of annotations) if (a.group && groups.has(a.group)) out.add(a.id);
  return [...out];
}

/** The ids a click on this shape should take, its group included. */
export function familyOf(annotations: Annotation[], id: string): string[] {
  const target = annotations.find((a) => a.id === id);
  if (!target?.group) return [id];
  return annotations.filter((a) => a.group === target.group).map((a) => a.id);
}

/** Which edge or middle an alignment lines up. */
export type AlignEdge = "left" | "hcentre" | "right" | "top" | "vcentre" | "bottom";

function snapshotOf(s: EditorState): HistoryEntry {
  return {
    annotations: s.annotations,
    stepCounter: s.stepCounter,
    crop: s.doc ? s.doc.crop : null,
    outputScale: s.doc ? s.doc.outputScale : null,
    backdrop: s.backdrop,
  };
}

/** Reapply a history entry's document-level fields, if there are any. */
function restoreDoc(doc: Doc | null, entry: HistoryEntry): Doc | null {
  if (!doc || !entry.crop) return doc;
  return { ...doc, crop: entry.crop, outputScale: entry.outputScale ?? doc.outputScale };
}

/** Cap the undo stack so a long session can't grow without bound. */
const HISTORY_LIMIT = 100;

/**
 * Push a style patch onto the selected shapes, undoably.
 *
 * With a selection, a style change edits those shapes *and* becomes the new
 * default — matching how Figma and Sketch behave. Which slot the default is
 * remembered in is the caller's business; this only touches the canvas, and
 * returns nothing to merge when there's nothing selected.
 */
function restyleSelection(s: EditorState, patch: Partial<Style>): Partial<EditorState> {
  if (s.selectedIds.length === 0) return {};
  return {
    dirty: true,
    past: [...s.past, snapshotOf(s)].slice(-HISTORY_LIMIT),
    future: [],
    annotations: s.annotations.map((a) =>
      s.selectedIds.includes(a.id) ? ({ ...a, style: { ...a.style, ...patch } } as Annotation) : a,
    ),
  };
}

export const useEditor = create<EditorState>((set, get) => ({
  doc: null,
  annotations: [],
  selectedIds: [],
  tool: storedTool(),
  pickReturn: "select",
  style: storedStyle(storedTool()),
  clipboardStyle: null,
  stepCounter: 1,
  backdrop: NO_BACKDROP,
  pendingCrop: null,
  zoom: 1,
  fitToWindow: true,
  dirty: false,
  past: [],
  future: [],

  open: (result, src) => {
    // A capture saved by Shotly comes back with its markup intact. `frame.path`
    // is the unannotated original in that case, so these shapes land on clean
    // pixels rather than on a flattened copy of themselves.
    const restored = result.markup ? parseMarkup(result.markup) : null;

    set((s) => ({
      doc: {
        id: result.id,
        src,
        path: result.frame.path,
        naturalWidth: result.frame.pixelWidth,
        naturalHeight: result.frame.pixelHeight,
        crop: restored?.crop ?? {
          x: 0,
          y: 0,
          width: result.frame.pixelWidth,
          height: result.frame.pixelHeight,
        },
        scale: result.frame.scale,
        outputScale: restored?.outputScale ?? 1,
        canvasFill: restored?.canvasFill ?? DEFAULT_CANVAS_FILL,
      },
      annotations: restored?.annotations ?? [],
      selectedIds: [],
      stepCounter: restored?.stepCounter ?? 1,
      backdrop: restored?.backdrop ?? NO_BACKDROP,
      pendingCrop: null,
      past: [],
      future: [],
      fitToWindow: true,
      dirty: false,
      // The tool in hand carries over to a new capture. It used to reset to
      // select here, on the reasoning that the last image's tool is rarely
      // what a new one wants — but that also meant the tool could never
      // survive anything, since every launch opens a capture. Someone who
      // arrows one screenshot is usually about to arrow the next.
      //
      // Except the ones that were only ever a detour, which would otherwise
      // reopen a colour picker or a crop over a brand new image.
      tool: UNREMEMBERED_TOOLS.includes(s.tool) ? "select" : s.tool,
    }));
  },

  setLibraryPath: (libraryPath) =>
    set((s) => (s.doc ? { doc: { ...s.doc, libraryPath } } : {})),

  markSaved: () => set({ dirty: false }),

  reset: () => set({ doc: null, annotations: [], selectedIds: [], past: [], future: [] }),

  setTool: (tool) => {
    rememberTool(tool);
    set((s) => ({
      tool,
      // The picker is a detour, not a destination: remember what was in hand so
      // one pick puts it straight back. Picking a colour is nearly always in
      // service of the next thing you were about to draw.
      pickReturn: tool === "pick" && s.tool !== "pick" ? s.tool : s.pickReturn,
      // Switching to a drawing tool drops the selection, so the inspector shows
      // the new tool's defaults rather than the old shape's properties.
      selectedIds: tool === "select" ? s.selectedIds : [],
      pendingCrop: tool === "crop" ? s.pendingCrop : null,
      // Picking up a tool picks up the ink it was last used with. Read on
      // every switch rather than cached: another window of the same app writes
      // the same slots, and the cost of a miss is drawing in the wrong colour.
      style: DRAWING_TOOLS.includes(tool) ? storedStyle(tool) : s.style,
    }));
  },

  /**
   * Change the ink, and remember it where the shape it belongs to will look.
   *
   * The working style only moves when the change belongs to the tool in hand.
   * Recolouring a selected arrow while the rectangle tool is up teaches the
   * arrow — and leaving the rectangle's own ink alone is what stops that one
   * click from following you into the next shape you draw.
   */
  setStyle: (patch) =>
    set((s) => {
      const slot = slotFor(s);
      const style = { ...(slot === s.tool ? s.style : slotStyle(s, slot)), ...patch };
      rememberStyle(slot, style);
      return {
        ...(slot === s.tool ? { style } : {}),
        ...restyleSelection(s, patch),
      };
    }),

  /**
   * Lift a look off one shape and put it on another.
   *
   * The whole style travels, including the parts the receiving shape has no
   * use for: an arrow ignores a corner radius, and carrying it means pasting
   * the same look onto a rectangle later still works. Both halves report
   * whether they found anything, so the caller can say so rather than leaving
   * a keystroke that silently did nothing.
   */
  copyStyle: () => {
    const s = get();
    const first = s.annotations.find((a) => s.selectedIds.includes(a.id));
    if (!first) return false;
    set({ clipboardStyle: { ...first.style } });
    return true;
  },

  pasteStyle: () => {
    const s = get();
    if (!s.clipboardStyle || s.selectedIds.length === 0) return false;
    set(restyleSelection(s, s.clipboardStyle));
    return true;
  },

  /**
   * Change the frame.
   *
   * Undoable, and marks the document dirty: it changes the exported image, so
   * it is an edit rather than a view setting. Choosing a colour for the first
   * time also brings a sensible margin with it, since a frame of zero width
   * would look like the swatch had done nothing.
   */
  setBackdrop: (patch) =>
    set((s) => {
      const arriving = patch.fill !== undefined && patch.fill !== "none" && s.backdrop.fill === "none";
      const backdrop = { ...s.backdrop, ...(arriving ? DEFAULT_BACKDROP : {}), ...patch };
      return {
        backdrop,
        dirty: true,
        past: [...s.past, snapshotOf(s)].slice(-HISTORY_LIMIT),
        future: [],
      };
    }),

  /**
   * Resize what gets exported.
   *
   * Clamped rather than validated: the only ways in are a preset and a width
   * field, and a width field will at some point contain a 0 or a number bigger
   * than the screen. The floor keeps the result at least one pixel across; the
   * ceiling is 1 because scaling a screenshot *up* adds no detail and only
   * makes a blurrier, larger file.
   */
  setOutputScale: (scale) =>
    set((s) => {
      if (!s.doc) return {};
      const shorter = Math.min(s.doc.crop.width, s.doc.crop.height);
      const outputScale = Math.min(1, Math.max(1 / Math.max(1, shorter), scale));
      if (outputScale === s.doc.outputScale) return {};
      return {
        doc: { ...s.doc, outputScale },
        dirty: true,
        past: [...s.past, snapshotOf(s)].slice(-HISTORY_LIMIT),
        future: [],
      };
    }),

  setCanvasFill: (canvasFill) =>
    set((s) =>
      s.doc
        ? {
            doc: { ...s.doc, canvasFill },
            dirty: true,
            past: [...s.past, snapshotOf(s)].slice(-HISTORY_LIMIT),
            future: [],
          }
        : {},
    ),

  /**
   * Make room on one side.
   *
   * Expressed as a crop, because that is exactly what it is: `applyCrop`
   * already composes a document-space rect onto the existing window and slides
   * every annotation to match, and a rect that starts at a negative coordinate
   * is a window bigger than what it looks through.
   */
  expandCanvas: (edge, amount) => {
    const s = get();
    if (!s.doc || amount <= 0) return;
    const { width, height } = s.doc.crop;
    get().applyCrop({
      x: edge === "left" ? -amount : 0,
      y: edge === "top" ? -amount : 0,
      width: width + (edge === "left" || edge === "right" ? amount : 0),
      height: height + (edge === "top" || edge === "bottom" ? amount : 0),
    });
  },

  /**
   * Shrink-wrap the canvas around everything on it.
   *
   * The counterpart to dragging a pasted screenshot off the edge: put things
   * where you want them, then have the canvas take the shape they make. The
   * capture itself always counts as content, so this can never crop away the
   * picture the document is of.
   */
  fitCanvasToContent: () => {
    const s = get();
    if (!s.doc) return;
    const { width, height } = s.doc.crop;

    let x0 = 0;
    let y0 = 0;
    let x1 = width;
    let y1 = height;
    for (const a of s.annotations) {
      // Where the shape lands rather than the box it is stored as: a canvas
      // grown to hold a turned shape has to hold the corners it really has.
      const b = spunBoundsOf(a);
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.width);
      y1 = Math.max(y1, b.y + b.height);
    }

    if (x0 === 0 && y0 === 0 && x1 === width && y1 === height) return;
    get().applyCrop({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  },

  setZoom: (zoom) => set({ zoom: Math.min(8, Math.max(0.05, zoom)), fitToWindow: false }),
  setFitToWindow: (fitToWindow) => set({ fitToWindow }),

  snapshot: () =>
    set((s) => ({ past: [...s.past, snapshotOf(s)].slice(-HISTORY_LIMIT), future: [] })),

  undo: () =>
    set((s) => {
      const prev = s.past[s.past.length - 1];
      if (!prev) return {};
      return {
        past: s.past.slice(0, -1),
        future: [snapshotOf(s), ...s.future].slice(0, HISTORY_LIMIT),
        annotations: prev.annotations,
        stepCounter: prev.stepCounter,
        backdrop: prev.backdrop,
        doc: restoreDoc(s.doc, prev),
        // Drop references to shapes that no longer exist.
        selectedIds: s.selectedIds.filter((id) => prev.annotations.some((a) => a.id === id)),
        dirty: true,
      };
    }),

  redo: () =>
    set((s) => {
      const next = s.future[0];
      if (!next) return {};
      return {
        past: [...s.past, snapshotOf(s)].slice(-HISTORY_LIMIT),
        future: s.future.slice(1),
        annotations: next.annotations,
        stepCounter: next.stepCounter,
        backdrop: next.backdrop,
        doc: restoreDoc(s.doc, next),
        selectedIds: s.selectedIds.filter((id) => next.annotations.some((a) => a.id === id)),
        dirty: true,
      };
    }),

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,

  add: (annotation) =>
    set((s) => ({
      annotations: [...s.annotations, annotation],
      selectedIds: [annotation.id],
      dirty: true,
      stepCounter: annotation.kind === "step" ? s.stepCounter + 1 : s.stepCounter,
      tool: TRANSIENT_TOOLS.includes(s.tool) ? "select" : s.tool,
    })),

  addOverlay: (source) =>
    set((s) => {
      if (!s.doc) return {};
      const overlay: Annotation = {
        id: crypto.randomUUID(),
        ...placeOverlay(source, docSize(s.doc), s.style),
      };
      return {
        annotations: [...s.annotations, overlay],
        // Selected and in the select tool, so the handles are already under the
        // pointer: placing an overlay and resizing it are one gesture in
        // practice, and nobody drops an image in at exactly the right size.
        selectedIds: [overlay.id],
        tool: "select",
        dirty: true,
        past: [...s.past, snapshotOf(s)].slice(-HISTORY_LIMIT),
        future: [],
      };
    }),

  // `rerouted` on each of these rather than on a few: an end tied to a shape
  // has to keep up with every way that shape can move, and the list of those
  // is only ever going to get longer. It costs nothing when nothing is tied.
  update: (id, patch) =>
    set((s) => ({
      annotations: rerouted(
        s.annotations.map((a) => (a.id === id ? ({ ...a, ...patch } as Annotation) : a)),
      ),
      dirty: true,
    })),

  replaceAll: (annotations) => set({ annotations: rerouted(annotations), dirty: true }),

  remove: (ids) =>
    set((s) => ({
      annotations: rerouted(s.annotations.filter((a) => !ids.includes(a.id))),
      selectedIds: s.selectedIds.filter((id) => !ids.includes(id)),
      dirty: true,
    })),

  deleteSelection: () => {
    const { selectedIds, snapshot, remove } = get();
    if (selectedIds.length === 0) return;
    snapshot();
    remove(selectedIds);
  },

  duplicateSelection: () =>
    set((s) => {
      const chosen = s.annotations.filter((a) => s.selectedIds.includes(a.id));
      if (chosen.length === 0) return {};

      // Offset the copies so they're visibly distinct from the originals.
      const OFFSET = 16;
      // Ids are remapped rather than kept: a copied arrow tied to a copied box
      // should point at *its* box, and a copied group should be a group of its
      // own or the two would move together for the rest of the document's life.
      const fresh = new Map(chosen.map((a) => [a.id, crypto.randomUUID()]));
      const groups = new Map(
        [...new Set(chosen.map((a) => a.group).filter(Boolean))].map((g) => [g, crypto.randomUUID()]),
      );
      const copies = chosen.map((a) => {
        const copy = { ...movedBy(a, OFFSET, OFFSET), id: fresh.get(a.id)! } as Annotation;
        if (copy.group) copy.group = groups.get(copy.group);
        if (isLine(copy)) {
          if (copy.fromId) copy.fromId = fresh.get(copy.fromId) ?? copy.fromId;
          if (copy.toId) copy.toId = fresh.get(copy.toId) ?? copy.toId;
        }
        return copy;
      });

      return {
        past: [...s.past, snapshotOf(s)].slice(-HISTORY_LIMIT),
        future: [],
        annotations: [...s.annotations, ...copies],
        selectedIds: copies.map((c) => c.id),
        dirty: true,
      };
    }),

  /**
   * Make several shapes into one thing to pick up.
   *
   * Flattens whatever was grouped before: a selection spanning two groups
   * becomes one group, not a group of groups. See `AnnotationBase.group` for
   * why there is no tree here.
   */
  group: () =>
    set((s) => {
      if (s.selectedIds.length < 2) return {};
      const group = crypto.randomUUID();
      return {
        past: [...s.past, snapshotOf(s)].slice(-HISTORY_LIMIT),
        future: [],
        annotations: s.annotations.map((a) =>
          s.selectedIds.includes(a.id) ? { ...a, group } : a,
        ),
        dirty: true,
      };
    }),

  ungroup: () =>
    set((s) => {
      const grouped = s.annotations.filter((a) => s.selectedIds.includes(a.id) && a.group);
      if (grouped.length === 0) return {};
      return {
        past: [...s.past, snapshotOf(s)].slice(-HISTORY_LIMIT),
        future: [],
        annotations: s.annotations.map((a) => {
          if (!s.selectedIds.includes(a.id) || !a.group) return a;
          const { group: _was, ...rest } = a;
          return rest as Annotation;
        }),
        dirty: true,
      };
    }),

  /**
   * Put the selection out of reach, and let go of it.
   *
   * Deselecting is the point rather than a side effect: a locked shape is one
   * that cannot be selected, so leaving it selected would leave every command
   * on the menu still pointed at it.
   */
  lock: () =>
    set((s) => {
      if (s.selectedIds.length === 0) return {};
      return {
        past: [...s.past, snapshotOf(s)].slice(-HISTORY_LIMIT),
        future: [],
        annotations: s.annotations.map((a) =>
          s.selectedIds.includes(a.id) ? { ...a, locked: true } : a,
        ),
        selectedIds: [],
        dirty: true,
      };
    }),

  /** The way back. Answers how many there were, for something to say. */
  unlockAll: () => {
    const locked = get().annotations.filter((a) => a.locked);
    if (locked.length === 0) return 0;
    set((s) => ({
      past: [...s.past, snapshotOf(s)].slice(-HISTORY_LIMIT),
        future: [],
      annotations: s.annotations.map((a) => {
        if (!a.locked) return a;
        const { locked: _was, ...rest } = a;
        return rest as Annotation;
      }),
      selectedIds: locked.map((a) => a.id),
      dirty: true,
    }));
    return locked.length;
  },

  /**
   * Line the selection up on one edge, or through one middle.
   *
   * On *spun* bounds, so a turned shape lines up by the box you can see rather
   * than by the untilted rectangle underneath it — the second would look
   * plainly wrong at any angle that matters.
   */
  align: (edge) =>
    set((s) => {
      const boxes = new Map(
        s.annotations.filter((a) => s.selectedIds.includes(a.id)).map((a) => [a.id, spunBoundsOf(a)]),
      );
      if (boxes.size < 2) return {};
      const all = [...boxes.values()];
      const left = Math.min(...all.map((b) => b.x));
      const right = Math.max(...all.map((b) => b.x + b.width));
      const top = Math.min(...all.map((b) => b.y));
      const bottom = Math.max(...all.map((b) => b.y + b.height));

      const shift = (b: Rect): [number, number] => {
        switch (edge) {
          case "left":
            return [left - b.x, 0];
          case "right":
            return [right - (b.x + b.width), 0];
          case "hcentre":
            return [(left + right) / 2 - (b.x + b.width / 2), 0];
          case "top":
            return [0, top - b.y];
          case "bottom":
            return [0, bottom - (b.y + b.height)];
          case "vcentre":
            return [0, (top + bottom) / 2 - (b.y + b.height / 2)];
        }
      };

      return {
        past: [...s.past, snapshotOf(s)].slice(-HISTORY_LIMIT),
        future: [],
        annotations: rerouted(
          s.annotations.map((a) => {
            const b = boxes.get(a.id);
            if (!b) return a;
            const [dx, dy] = shift(b);
            return dx || dy ? movedBy(a, dx, dy) : a;
          }),
        ),
        dirty: true,
      };
    }),

  /**
   * Even gaps, not even centres.
   *
   * Three shapes of different widths spaced by their centres leave gaps that
   * visibly differ, which is the thing anyone reaching for this was trying to
   * fix. The two at the ends stay put and define the run.
   */
  distribute: (axis) =>
    set((s) => {
      const chosen = s.annotations
        .filter((a) => s.selectedIds.includes(a.id))
        .map((a) => ({ id: a.id, box: spunBoundsOf(a) }));
      if (chosen.length < 3) return {};

      const start = (b: Rect) => (axis === "x" ? b.x : b.y);
      const size = (b: Rect) => (axis === "x" ? b.width : b.height);
      chosen.sort((p, q) => start(p.box) - start(q.box));

      const first = chosen[0].box;
      const last = chosen[chosen.length - 1].box;
      const span = start(last) + size(last) - start(first);
      const used = chosen.reduce((n, c) => n + size(c.box), 0);
      const gap = (span - used) / (chosen.length - 1);

      const moves = new Map<string, number>();
      let at = start(first);
      for (const c of chosen) {
        moves.set(c.id, at - start(c.box));
        at += size(c.box) + gap;
      }

      return {
        past: [...s.past, snapshotOf(s)].slice(-HISTORY_LIMIT),
        future: [],
        annotations: rerouted(
          s.annotations.map((a) => {
            const d = moves.get(a.id);
            if (!d) return a;
            return axis === "x" ? movedBy(a, d, 0) : movedBy(a, 0, d);
          }),
        ),
        dirty: true,
      };
    }),

  /**
   * The one door every selection comes through.
   *
   * Two rules live here so that nothing else has to remember them: a group
   * comes up whole, and a locked shape does not come up at all.
   */
  select: (ids) =>
    set((s) => ({
      selectedIds: withGroups(
        s.annotations,
        ids.filter((id) => !s.annotations.find((a) => a.id === id)?.locked),
      ),
    })),

  toggleSelect: (id) => {
    const { selectedIds, select } = get();
    select(
      selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id],
    );
  },

  selectAll: () =>
    set((s) => ({
      selectedIds: s.annotations.filter((a) => !a.locked).map((a) => a.id),
      tool: "select",
    })),
  clearSelection: () => set({ selectedIds: [] }),

  /** Tab / Shift-Tab cycling through annotations in z-order. */
  selectNext: (delta) =>
    set((s) => {
      const len = s.annotations.length;
      if (len === 0) return {};
      const current = s.annotations.findIndex((a) => a.id === s.selectedIds[0]);
      // Walk on past anything locked rather than landing on it and stopping:
      // Tab is the one way to reach a shape without clicking it, and a locked
      // shape is exactly what should not be reachable.
      let at = current === -1 ? (delta > 0 ? -1 : 0) : current;
      for (let step = 0; step < len; step++) {
        at = (at + delta + len) % len;
        const next = s.annotations[at];
        if (!next.locked) return { selectedIds: withGroups(s.annotations, [next.id]), tool: "select" };
      }
      return {};
    }),

  nudge: (dx, dy) =>
    set((s) => {
      if (s.selectedIds.length === 0) return {};
      return {
        dirty: true,
        annotations: rerouted(
          s.annotations.map((a) => (s.selectedIds.includes(a.id) ? movedBy(a, dx, dy) : a)),
        ),
      };
    }),

  reorder: (mode) =>
    set((s) => {
      if (s.selectedIds.length === 0) return {};
      const chosen = s.annotations.filter((a) => s.selectedIds.includes(a.id));
      const rest = s.annotations.filter((a) => !s.selectedIds.includes(a.id));

      let annotations: Annotation[];
      if (mode === "front") annotations = [...rest, ...chosen];
      else if (mode === "back") annotations = [...chosen, ...rest];
      else {
        // Step a single shape one position through the stack.
        annotations = [...s.annotations];
        const step = mode === "forward" ? 1 : -1;
        const indices = s.annotations
          .map((a, i) => (s.selectedIds.includes(a.id) ? i : -1))
          .filter((i) => i >= 0);
        // Walk from the end when moving forward so shapes don't leapfrog.
        const ordered = step > 0 ? indices.reverse() : indices;
        for (const i of ordered) {
          const j = i + step;
          if (j < 0 || j >= annotations.length) continue;
          [annotations[i], annotations[j]] = [annotations[j], annotations[i]];
        }
      }

      return {
        past: [...s.past, snapshotOf(s)].slice(-HISTORY_LIMIT),
        future: [],
        annotations,
        dirty: true,
      };
    }),

  setPendingCrop: (pendingCrop) => set({ pendingCrop }),

  /**
   * Crop is destructive to geometry: the image is trimmed and every annotation
   * shifts into the new origin. Anything left entirely outside is dropped.
   */
  applyCrop: (rect) =>
    set((s) => {
      if (!s.doc) return {};
      const shifted = s.annotations
        .filter((a) => {
          const b = spunBoundsOf(a);
          return (
            b.x + b.width > rect.x &&
            b.y + b.height > rect.y &&
            b.x < rect.x + rect.width &&
            b.y < rect.y + rect.height
          );
        })
        .map((a) => movedBy(a, -rect.x, -rect.y));
      // A crop can drop the shape an arrow was tied to; rerouting is what
      // turns that back into an ordinary arrow rather than a dangling bond.
      const kept = rerouted(shifted);

      // `rect` arrives in document space, so compose it onto the existing crop
      // to get back to source-image coordinates.
      const crop: Rect = {
        x: s.doc.crop.x + rect.x,
        y: s.doc.crop.y + rect.y,
        width: rect.width,
        height: rect.height,
      };

      return {
        past: [...s.past, snapshotOf(s)].slice(-HISTORY_LIMIT),
        future: [],
        annotations: kept,
        doc: { ...s.doc, crop },
        pendingCrop: null,
        tool: "select",
        dirty: true,
        fitToWindow: true,
      };
    }),

  nextStepLabel: () => get().stepCounter,
}));

export { DEFAULT_STYLE, isBox, isLine, isPen, isStep, boundsOf, movedBy };
