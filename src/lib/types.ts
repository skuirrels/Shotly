export interface Point {
  x: number;
  y: number;
}

/** Mirrors the Rust `Rect` — global point space, top-left origin. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Mirrors the Rust `Frame`. */
export interface Frame {
  path: string;
  bounds: Rect;
  pixelWidth: number;
  pixelHeight: number;
  scale: number;
}

export interface DisplayInfo {
  id: number;
  bounds: Rect;
  scale: number;
  isPrimary: boolean;
}

export interface WindowInfo {
  id: number;
  title: string;
  appName: string;
  bounds: Rect;
  layer: number;
  /** The owning process; how the snap outline matches a window back to an id. */
  pid: number;
  /** Full-screen windows cannot be captured by id — see `WindowPicker`. */
  fullScreen: boolean;
}

export type CaptureMode = "region" | "window" | "fullscreen";

export interface OverlaySession {
  mode: CaptureMode;
  frames: Frame[];
  displays: DisplayInfo[];
  windows: WindowInfo[];
  virtualBounds: Rect;
}

export interface CaptureResult {
  frame: Frame;
  id: number;
  /**
   * Serialised markup, when the opened file was saved by Shotly and still
   * carries it. `frame.path` then points at the unannotated original — see
   * `lib/markup` and `open_image`.
   */
  markup?: string;
}

export interface LibraryItem {
  path: string;
  name: string;
  modified: number;
  size: number;
  width: number;
  height: number;
  /** A screen recording. There is nothing to annotate, so it opens elsewhere. */
  video: boolean;
  /** Running time of a recording, in seconds. Zero for stills. */
  seconds: number;
  /**
   * The bytes live in the cloud, not on this disk.
   *
   * Its size and date are still true; its dimensions and duration are not,
   * because reading them would mean downloading the file. Nothing in the app
   * may touch the contents of one of these without the user asking.
   */
  cloud: boolean;
}

// ------------------------------------------------------------- annotations

/**
 * Every tool, as values rather than only as a type.
 *
 * The union is derived from this rather than written beside it, so that the
 * one thing which needs to check a tool id at runtime — deciding whether a
 * remembered tool still exists, in `editorStore` — cannot drift out of step
 * with the type as tools come and go.
 */
export const TOOL_IDS = [
  "select",
  "arrow",
  "rect",
  "ellipse",
  "line",
  "pen",
  "text",
  "step",
  "callout",
  "blur",
  "highlight",
  "spotlight",
  "pick",
  "grab",
  "measure",
  "crop",
] as const;

export type ToolId = (typeof TOOL_IDS)[number];

/** Tools that produce a box-shaped annotation by dragging a rectangle. */
export type BoxKind =
  | "rect"
  | "ellipse"
  | "blur"
  | "highlight"
  | "spotlight"
  | "text"
  | "callout";
/**
 * Tools defined by two endpoints rather than a bounding box.
 *
 * `measure` is one of these rather than a family of its own: it is a line with
 * an opinion about what to draw at the ends, and being a line means dragging,
 * nudging, selecting and Shift-constraining all work on it already.
 */
export type LineKind = "arrow" | "line" | "measure";

export interface Style {
  color: string;
  strokeWidth: number;
  fontSize: number;
  /** 0 = outline only, which is the default for rect/ellipse. */
  fillOpacity: number;
  /** Blur/pixelate strength, in image pixels. */
  blurRadius: number;
  /** How far the spotlight darkens everything outside it, 0–1. */
  dim: number;
  shadow: boolean;
  /**
   * Draw this shape as a lit sign: a bright edge, a glow spilling off it, and
   * a washed-down fill behind whatever the shape holds.
   *
   * A property of the shape rather than a tool of its own, so a callout you
   * have already dragged out and typed into can become one — and so the same
   * switch lights a bare rectangle or ellipse, where it draws the edge and no
   * fill. See `neonPaint` for what the four layers are.
   */
  neon: boolean;
  /**
   * What a measurement counts in.
   *
   * A Retina capture holds two pixels for every point that was on screen, so
   * the same gap is honestly both "48px" and "24pt" — and which one is wanted
   * depends on whether you are writing CSS or checking an asset. On a 1x
   * capture the two are the same number and only `px` is ever shown.
   */
  measureUnits: "px" | "pt";
}

interface AnnotationBase {
  id: string;
  style: Style;
}

/** All geometry is in *image pixel* space, so annotations stay pinned to the
 *  screenshot regardless of zoom or window size. */
export interface BoxAnnotation extends AnnotationBase {
  kind: BoxKind;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Only meaningful for `kind === "text"` and `kind === "callout"`. */
  text?: string;
}

export interface LineAnnotation extends AnnotationBase {
  kind: LineKind;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface StepAnnotation extends AnnotationBase {
  kind: "step";
  x: number;
  y: number;
  radius: number;
  label: number;
}

/**
 * A freehand stroke, as a list of sampled points.
 *
 * No smoothing or curve fitting: the samples *are* the drawing, which is what
 * makes moving it a translation and resizing it a scale, with no control points
 * to keep consistent.
 */
export interface PenAnnotation extends AnnotationBase {
  kind: "pen";
  points: Point[];
}

/**
 * Another picture, laid over this one.
 *
 * `src` is a PNG data URL — the pixels themselves, not a path to them. An
 * overlay is part of the document, and a document that referred to a file could
 * lose half of itself to a capture being renamed or thrown away long after the
 * fact. Embedding costs size in the saved file, which is exactly what the
 * flattened export is for.
 *
 * The natural size rides along so a resize can hold the aspect ratio without
 * waiting on a decode.
 */
export interface ImageAnnotation extends AnnotationBase {
  kind: "image";
  x: number;
  y: number;
  width: number;
  height: number;
  src: string;
  naturalWidth: number;
  naturalHeight: number;
}

export type Annotation =
  | BoxAnnotation
  | LineAnnotation
  | StepAnnotation
  | PenAnnotation
  | ImageAnnotation;

export function isBox(a: Annotation): a is BoxAnnotation {
  return a.kind === "rect" || a.kind === "ellipse" || a.kind === "blur" ||
    a.kind === "highlight" || a.kind === "spotlight" || a.kind === "text" ||
    a.kind === "callout";
}

export function isLine(a: Annotation): a is LineAnnotation {
  return a.kind === "arrow" || a.kind === "line" || a.kind === "measure";
}

export function isStep(a: Annotation): a is StepAnnotation {
  return a.kind === "step";
}

export function isPen(a: Annotation): a is PenAnnotation {
  return a.kind === "pen";
}

export function isImage(a: Annotation): a is ImageAnnotation {
  return a.kind === "image";
}

/** Anything positioned by a rectangle, whatever else it may be. */
export function isRectangular(a: Annotation): a is BoxAnnotation | ImageAnnotation {
  return isBox(a) || isImage(a);
}

/** Axis-aligned bounds of any annotation, used for selection and handles. */
export function boundsOf(a: Annotation): Rect {
  if (isRectangular(a)) {
    return {
      x: Math.min(a.x, a.x + a.width),
      y: Math.min(a.y, a.y + a.height),
      width: Math.abs(a.width),
      height: Math.abs(a.height),
    };
  }
  if (isLine(a)) {
    return {
      x: Math.min(a.x1, a.x2),
      y: Math.min(a.y1, a.y2),
      width: Math.abs(a.x2 - a.x1),
      height: Math.abs(a.y2 - a.y1),
    };
  }
  if (isPen(a)) {
    // Padded by half the stroke width: a perfectly horizontal scribble has no
    // height as a set of points, and a selection box drawn through the middle
    // of it would be invisible and impossible to grab.
    const pad = a.style.strokeWidth / 2;
    const xs = a.points.map((p) => p.x);
    const ys = a.points.map((p) => p.y);
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    return {
      x: minX,
      y: minY,
      width: Math.max(...xs) + pad - minX,
      height: Math.max(...ys) + pad - minY,
    };
  }
  return {
    x: a.x - a.radius,
    y: a.y - a.radius,
    width: a.radius * 2,
    height: a.radius * 2,
  };
}

/**
 * Translate any annotation.
 *
 * One place rather than four: nudging, dragging, duplicating and cropping all
 * move shapes, and every shape family has its own idea of what a position is.
 * A new family added without touching this function would be missed by all of
 * them at once.
 */
export function movedBy(a: Annotation, dx: number, dy: number): Annotation {
  if (isRectangular(a)) return { ...a, x: a.x + dx, y: a.y + dy };
  if (isLine(a)) {
    return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy };
  }
  if (isPen(a)) {
    return { ...a, points: a.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  }
  return { ...a, x: a.x + dx, y: a.y + dy };
}

// --------------------------------------------------------------- hotkeys

/** Mirrors `Action` in `src-tauri/src/hotkeys.rs`. */
export type HotkeyAction =
  | "region"
  | "window"
  | "fullscreen"
  | "scroll"
  | "record"
  | "annotate"
  | "interact";

/** Mirrors `Binding` in `src-tauri/src/hotkeys.rs`. */
export interface HotkeyBinding {
  action: HotkeyAction;
  label: string;
  hint: string;
  /** `null` when the user has switched this hotkey off. */
  accelerator: string | null;
  defaultAccelerator: string;
}

// ------------------------------------------------------------ recognition

/** Mirrors `TextLine` in `src-tauri/src/ocr.rs`. */
export interface TextLine {
  text: string;
  /** 0 to 1, as Vision reports it. */
  confidence: number;
}

/** A QR code or barcode found in the same pass. Mirrors `Code` in `ocr.rs`. */
export interface CodePayload {
  payload: string;
  /** "QR", "Code128", "Aztec" — Vision's name for the symbology. */
  symbology: string;
}

/** Everything one look at the pixels turned up. Mirrors `Scan` in `ocr.rs`. */
export interface Scan {
  lines: TextLine[];
  codes: CodePayload[];
}

// ---------------------------------------------------------------- backup

/** Mirrors `Settings` in `src-tauri/src/backup.rs`. */
export interface BackupSettings {
  enabled: boolean;
  destination: string | null;
}

/** A cloud sync folder found on this Mac. */
export interface BackupTarget {
  label: string;
  path: string;
}

/** What one run of the backup did. */
export interface BackupReport {
  copied: number;
  skipped: number;
  failed: number;
  destination: string;
}
