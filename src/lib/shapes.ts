import type { LineAnnotation, Point, StepAnnotation, Style } from "./types";

/**
 * Geometry shared by the SVG renderer (screen) and the Canvas2D renderer
 * (export). Anything that decides what a shape *looks like* lives here so the
 * exported PNG matches the preview exactly.
 */

export const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif';

export type { Point };

/**
 * Outline of a tapered arrow, tail to head.
 *
 * A filled polygon rather than a stroked line with a marker: markers don't
 * scale with stroke width predictably across renderers, and the taper is what
 * makes an annotation arrow look drawn rather than diagrammatic.
 */
export function arrowPolygon(a: LineAnnotation): Point[] {
  const sw = a.style.strokeWidth;
  const dx = a.x2 - a.x1;
  const dy = a.y2 - a.y1;
  const len = Math.hypot(dx, dy) || 1;

  const ux = dx / len;
  const uy = dy / len;
  // Perpendicular unit vector.
  const px = -uy;
  const py = ux;

  // Clamp the head so a very short arrow stays an arrow instead of collapsing
  // into a triangle with no shaft.
  const headLen = Math.min(sw * 3.6, len * 0.6);
  const headHalf = sw * 1.5;
  const tailHalf = sw * 0.18;
  const shaftHalf = sw * 0.55;

  const bx = a.x2 - ux * headLen;
  const by = a.y2 - uy * headLen;

  return [
    { x: a.x1 + px * tailHalf, y: a.y1 + py * tailHalf },
    { x: bx + px * shaftHalf, y: by + py * shaftHalf },
    { x: bx + px * headHalf, y: by + py * headHalf },
    { x: a.x2, y: a.y2 },
    { x: bx - px * headHalf, y: by - py * headHalf },
    { x: bx - px * shaftHalf, y: by - py * shaftHalf },
    { x: a.x1 - px * tailHalf, y: a.y1 - py * tailHalf },
  ];
}

export function polygonToPath(points: Point[]): string {
  if (points.length === 0) return "";
  return `M ${points.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" L ")} Z`;
}

// -------------------------------------------------------------- freehand

/**
 * An open polyline through every sample, for the SVG renderer.
 *
 * A single point still emits a path, as a zero-length segment: with a round
 * cap that draws the dot you'd expect from a tap, where an empty `d` would
 * draw nothing and make the click look ignored.
 */
export function freehandPath(points: Point[]): string {
  if (points.length === 0) return "";
  const [first, ...rest] = points;
  const head = `M ${first.x.toFixed(2)} ${first.y.toFixed(2)}`;
  if (rest.length === 0) return `${head} L ${first.x.toFixed(2)} ${first.y.toFixed(2)}`;
  return `${head} ${rest.map((p) => `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ")}`;
}

/**
 * How far apart two samples must be before the second is kept, in document
 * pixels. Pointer events arrive far faster than the hand moves, and every
 * duplicate point is one more coordinate pair inside the saved PNG.
 */
export const FREEHAND_MIN_STEP = 1.4;

// ------------------------------------------------------------------- text

/** Shared measuring context, so screen and export agree on text metrics. */
let measureCtx: CanvasRenderingContext2D | null = null;

function ctxFor(fontSize: number): CanvasRenderingContext2D {
  if (!measureCtx) {
    measureCtx = document.createElement("canvas").getContext("2d")!;
  }
  measureCtx.font = fontFor(fontSize);
  return measureCtx;
}

export function fontFor(fontSize: number): string {
  return `600 ${fontSize}px ${FONT_STACK}`;
}

export const LINE_HEIGHT = 1.3;
export const TEXT_PADDING = 6;

export interface TextMetrics {
  lines: string[];
  width: number;
  height: number;
  lineHeight: number;
}

/**
 * Lay out a text annotation. Splits on explicit newlines only — auto-wrapping
 * would make the box resize under the user mid-sentence.
 */
export function measureText(text: string, fontSize: number): TextMetrics {
  const lines = (text.length > 0 ? text : " ").split("\n");
  const ctx = ctxFor(fontSize);
  const lineHeight = fontSize * LINE_HEIGHT;

  let width = 0;
  for (const line of lines) {
    width = Math.max(width, ctx.measureText(line || " ").width);
  }

  return {
    lines,
    width: width + TEXT_PADDING * 2,
    height: lines.length * lineHeight + TEXT_PADDING * 2,
    lineHeight,
  };
}

// ---------------------------------------------------------------- callout

/** Breathing room between a callout's text and its edges. */
export const CALLOUT_PADDING = 12;

/**
 * Wrap text to a width, breaking on spaces.
 *
 * The plain text tool deliberately doesn't wrap — its box is sized by what you
 * type. A callout is the other way round: you drag out the box first, so the
 * words have to fit the shape rather than the shape fitting the words. A single
 * word longer than the box is left to overhang rather than broken mid-word,
 * which is the lesser of two ugly outcomes.
 */
export function wrapText(text: string, fontSize: number, maxWidth: number): string[] {
  const ctx = ctxFor(fontSize);
  const room = Math.max(1, maxWidth);
  const lines: string[] = [];

  for (const paragraph of (text.length > 0 ? text : " ").split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > room) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }

  return lines;
}

export interface CalloutLayout {
  lines: string[];
  lineHeight: number;
  /** The height the box needs to show every line. */
  needed: number;
}

export function calloutLayout(
  text: string,
  fontSize: number,
  boxWidth: number,
): CalloutLayout {
  const lines = wrapText(text, fontSize, boxWidth - CALLOUT_PADDING * 2);
  const lineHeight = fontSize * LINE_HEIGHT;
  return { lines, lineHeight, needed: lines.length * lineHeight + CALLOUT_PADDING * 2 };
}

/**
 * Black or white text, whichever survives on this fill.
 *
 * A callout is a solid colour with words on it, and the palette runs from
 * yellow to navy — one fixed ink would be invisible on half of it. Rec. 709
 * luma, which is close enough to perceived brightness for a two-way choice.
 */
export function contrastInk(fill: string): string {
  const hex = fill.replace("#", "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) || 0);
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luma > 0.55 ? "#16181C" : "#FFFFFF";
}

// ------------------------------------------------------------------- step

/**
 * Radius of a step badge, derived from stroke width so it scales with style.
 *
 * The multiplier is calibrated against the *default* stroke, which is the part
 * that made this wrong: when that default went from 6 to 10 to give arrows some
 * weight, 3.4 quietly turned a step number into a badge twice the size of the
 * interface it was numbering. At 2 a default badge is the size it always was,
 * and the slider still moves it at either end.
 */
export function stepRadius(style: Style): number {
  return Math.max(12, style.strokeWidth * 2);
}

export function stepFontSize(a: StepAnnotation): number {
  // Shrink slightly for double digits so "10" still fits inside the circle.
  const digits = String(a.label).length;
  return a.radius * (digits > 1 ? 1.0 : 1.2);
}

/** A soft drop shadow keeps annotations legible over busy screenshots. */
export const SHADOW = {
  color: "rgba(0,0,0,0.45)",
  blur: 6,
  offsetY: 1.5,
};
