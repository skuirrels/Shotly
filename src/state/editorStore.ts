import { create } from "zustand";
import { type Backdrop, DEFAULT_BACKDROP, NO_BACKDROP } from "@/lib/backdrop";
import { parse as parseMarkup } from "@/lib/markup";
import { type OverlaySource, placeOverlay } from "@/lib/overlay";
import {
  type Annotation,
  type CaptureResult,
  type Rect,
  type Style,
  type ToolId,
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
  blurRadius: 12,
  dim: 0.55,
  shadow: true,
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
  style: Style;
  /** A callout's remembered text size. See `DEFAULT_CALLOUT_FONT_SIZE`. */
  calloutFontSize: number;
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
  setCalloutFontSize: (fontSize: number) => void;
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
  tool: "select",
  pickReturn: "select",
  style: DEFAULT_STYLE,
  calloutFontSize: DEFAULT_CALLOUT_FONT_SIZE,
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

    set({
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
      // A fresh capture starts in select mode; the previous session's tool
      // choice is rarely what you want for a new image.
      tool: "select",
    });
  },

  setLibraryPath: (libraryPath) =>
    set((s) => (s.doc ? { doc: { ...s.doc, libraryPath } } : {})),

  markSaved: () => set({ dirty: false }),

  reset: () => set({ doc: null, annotations: [], selectedIds: [], past: [], future: [] }),

  setTool: (tool) =>
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
    })),

  setStyle: (patch) => set((s) => ({ style: { ...s.style, ...patch }, ...restyleSelection(s, patch) })),

  // Same gesture, different memory: the size lands on any selected callout, but
  // is remembered where the next callout will look for it rather than in the
  // shared style.
  setCalloutFontSize: (fontSize) =>
    set((s) => ({ calloutFontSize: fontSize, ...restyleSelection(s, { fontSize }) })),

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
      const b = boundsOf(a);
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

  update: (id, patch) =>
    set((s) => ({
      annotations: s.annotations.map((a) => (a.id === id ? ({ ...a, ...patch } as Annotation) : a)),
      dirty: true,
    })),

  replaceAll: (annotations) => set({ annotations, dirty: true }),

  remove: (ids) =>
    set((s) => ({
      annotations: s.annotations.filter((a) => !ids.includes(a.id)),
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
      const copies = chosen.map((a) => ({
        ...movedBy(a, OFFSET, OFFSET),
        id: crypto.randomUUID(),
      }));

      return {
        past: [...s.past, snapshotOf(s)].slice(-HISTORY_LIMIT),
        future: [],
        annotations: [...s.annotations, ...copies],
        selectedIds: copies.map((c) => c.id),
        dirty: true,
      };
    }),

  select: (ids) => set({ selectedIds: ids }),

  toggleSelect: (id) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id],
    })),

  selectAll: () => set((s) => ({ selectedIds: s.annotations.map((a) => a.id), tool: "select" })),
  clearSelection: () => set({ selectedIds: [] }),

  /** Tab / Shift-Tab cycling through annotations in z-order. */
  selectNext: (delta) =>
    set((s) => {
      if (s.annotations.length === 0) return {};
      const current = s.annotations.findIndex((a) => a.id === s.selectedIds[0]);
      const len = s.annotations.length;
      const next = current === -1 ? (delta > 0 ? 0 : len - 1) : (current + delta + len) % len;
      return { selectedIds: [s.annotations[next].id], tool: "select" };
    }),

  nudge: (dx, dy) =>
    set((s) => {
      if (s.selectedIds.length === 0) return {};
      return {
        dirty: true,
        annotations: s.annotations.map((a) =>
          s.selectedIds.includes(a.id) ? movedBy(a, dx, dy) : a,
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
          const b = boundsOf(a);
          return (
            b.x + b.width > rect.x &&
            b.y + b.height > rect.y &&
            b.x < rect.x + rect.width &&
            b.y < rect.y + rect.height
          );
        })
        .map((a) => movedBy(a, -rect.x, -rect.y));

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
        annotations: shifted,
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
