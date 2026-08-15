import { create } from "zustand";
import {
  type Annotation,
  type CaptureResult,
  type Rect,
  type Style,
  type ToolId,
  boundsOf,
  isBox,
  isLine,
  isStep,
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
}

/** Document-space size, i.e. what the canvas and exporter actually work in. */
export function docSize(doc: Doc): { width: number; height: number } {
  return { width: doc.crop.width, height: doc.crop.height };
}

const DEFAULT_STYLE: Style = {
  color: "#FF3B30",
  strokeWidth: 4,
  fontSize: 24,
  fillOpacity: 0,
  blurRadius: 12,
  shadow: true,
};

/** Tools that don't create geometry and so shouldn't be sticky after a drag. */
const TRANSIENT_TOOLS: ToolId[] = ["crop"];

interface HistoryEntry {
  annotations: Annotation[];
  stepCounter: number;
  /** Crop is undoable alongside annotations, so it rides in the same entry. */
  crop: Rect | null;
}

interface EditorState {
  doc: Doc | null;
  annotations: Annotation[];
  selectedIds: string[];
  tool: ToolId;
  style: Style;
  stepCounter: number;
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
  reset: () => void;

  setTool: (tool: ToolId) => void;
  setStyle: (patch: Partial<Style>) => void;
  setZoom: (zoom: number) => void;
  setFitToWindow: (fit: boolean) => void;

  /** Snapshot current state onto the undo stack. Call once before a gesture. */
  snapshot: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  add: (annotation: Annotation) => void;
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
  };
}

/** Reapply a history entry's crop to the document, if there is one. */
function restoreDoc(doc: Doc | null, entry: HistoryEntry): Doc | null {
  if (!doc || !entry.crop) return doc;
  return { ...doc, crop: entry.crop };
}

/** Cap the undo stack so a long session can't grow without bound. */
const HISTORY_LIMIT = 100;

export const useEditor = create<EditorState>((set, get) => ({
  doc: null,
  annotations: [],
  selectedIds: [],
  tool: "select",
  style: DEFAULT_STYLE,
  stepCounter: 1,
  pendingCrop: null,
  zoom: 1,
  fitToWindow: true,
  dirty: false,
  past: [],
  future: [],

  open: (result, src) =>
    set({
      doc: {
        id: result.id,
        src,
        path: result.frame.path,
        naturalWidth: result.frame.pixelWidth,
        naturalHeight: result.frame.pixelHeight,
        crop: { x: 0, y: 0, width: result.frame.pixelWidth, height: result.frame.pixelHeight },
        scale: result.frame.scale,
      },
      annotations: [],
      selectedIds: [],
      stepCounter: 1,
      pendingCrop: null,
      past: [],
      future: [],
      fitToWindow: true,
      dirty: false,
      // A fresh capture starts in select mode; the previous session's tool
      // choice is rarely what you want for a new image.
      tool: "select",
    }),

  setLibraryPath: (libraryPath) =>
    set((s) => (s.doc ? { doc: { ...s.doc, libraryPath } } : {})),

  reset: () => set({ doc: null, annotations: [], selectedIds: [], past: [], future: [] }),

  setTool: (tool) =>
    set((s) => ({
      tool,
      // Switching to a drawing tool drops the selection, so the inspector shows
      // the new tool's defaults rather than the old shape's properties.
      selectedIds: tool === "select" ? s.selectedIds : [],
      pendingCrop: tool === "crop" ? s.pendingCrop : null,
    })),

  setStyle: (patch) =>
    set((s) => {
      const style = { ...s.style, ...patch };
      if (s.selectedIds.length === 0) return { style };

      // With a selection, a style change edits those shapes and becomes the
      // new default — matching how Figma and Sketch behave.
      return {
        style,
        dirty: true,
        past: [...s.past, snapshotOf(s)].slice(-HISTORY_LIMIT),
        future: [],
        annotations: s.annotations.map((a) =>
          s.selectedIds.includes(a.id) ? ({ ...a, style: { ...a.style, ...patch } } as Annotation) : a,
        ),
      };
    }),

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
      const copies = chosen.map((a) => {
        const id = crypto.randomUUID();
        if (isBox(a)) return { ...a, id, x: a.x + OFFSET, y: a.y + OFFSET };
        if (isLine(a))
          return {
            ...a,
            id,
            x1: a.x1 + OFFSET,
            y1: a.y1 + OFFSET,
            x2: a.x2 + OFFSET,
            y2: a.y2 + OFFSET,
          };
        return { ...a, id, x: a.x + OFFSET, y: a.y + OFFSET };
      });

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
        annotations: s.annotations.map((a) => {
          if (!s.selectedIds.includes(a.id)) return a;
          if (isBox(a)) return { ...a, x: a.x + dx, y: a.y + dy };
          if (isLine(a)) return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy };
          return { ...a, x: a.x + dx, y: a.y + dy };
        }),
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
        .map((a) => {
          if (isBox(a)) return { ...a, x: a.x - rect.x, y: a.y - rect.y };
          if (isLine(a))
            return {
              ...a,
              x1: a.x1 - rect.x,
              y1: a.y1 - rect.y,
              x2: a.x2 - rect.x,
              y2: a.y2 - rect.y,
            };
          return { ...a, x: a.x - rect.x, y: a.y - rect.y };
        });

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

export { DEFAULT_STYLE, isBox, isLine, isStep, boundsOf };
