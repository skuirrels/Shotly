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
}

// ------------------------------------------------------------- annotations

export type ToolId =
  | "select"
  | "arrow"
  | "rect"
  | "ellipse"
  | "line"
  | "text"
  | "step"
  | "blur"
  | "highlight"
  | "crop";

/** Tools that produce a box-shaped annotation by dragging a rectangle. */
export type BoxKind = "rect" | "ellipse" | "blur" | "highlight" | "text";
/** Tools defined by two endpoints rather than a bounding box. */
export type LineKind = "arrow" | "line";

export interface Style {
  color: string;
  strokeWidth: number;
  fontSize: number;
  /** 0 = outline only, which is the default for rect/ellipse. */
  fillOpacity: number;
  /** Blur/pixelate strength, in image pixels. */
  blurRadius: number;
  shadow: boolean;
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
  /** Only meaningful for `kind === "text"`. */
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

export type Annotation = BoxAnnotation | LineAnnotation | StepAnnotation;

export function isBox(a: Annotation): a is BoxAnnotation {
  return a.kind === "rect" || a.kind === "ellipse" || a.kind === "blur" ||
    a.kind === "highlight" || a.kind === "text";
}

export function isLine(a: Annotation): a is LineAnnotation {
  return a.kind === "arrow" || a.kind === "line";
}

export function isStep(a: Annotation): a is StepAnnotation {
  return a.kind === "step";
}

/** Axis-aligned bounds of any annotation, used for selection and handles. */
export function boundsOf(a: Annotation): Rect {
  if (isBox(a)) {
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
  return {
    x: a.x - a.radius,
    y: a.y - a.radius,
    width: a.radius * 2,
    height: a.radius * 2,
  };
}
