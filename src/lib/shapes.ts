import type { LineAnnotation, StepAnnotation, Style } from "./types";

/**
 * Geometry shared by the SVG renderer (screen) and the Canvas2D renderer
 * (export). Anything that decides what a shape *looks like* lives here so the
 * exported PNG matches the preview exactly.
 */

export const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif';

export interface Point {
  x: number;
  y: number;
}

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

// ------------------------------------------------------------------- step

/** Radius of a step badge, derived from stroke width so it scales with style. */
export function stepRadius(style: Style): number {
  return Math.max(12, style.strokeWidth * 3.4);
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
