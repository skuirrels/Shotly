import { type Annotation, angleOf, boundsOf, canBend } from "./types";
import type { LineAnnotation, Point, Rect, StepAnnotation, Style } from "./types";

/**
 * Geometry shared by the SVG renderer (screen) and the Canvas2D renderer
 * (export). Anything that decides what a shape *looks like* lives here so the
 * exported PNG matches the preview exactly.
 */

export const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif';

export type { Point };

/**
 * How much heavier an arrow is than its stroke width suggests.
 *
 * An arrow is not a line, and weighting it like one made it disappear into
 * screenshots — a stroke that reads clearly as a rectangle's border is thin and
 * apologetic once it has a head on the end and is pointing at something.
 *
 * The figure is measured rather than chosen. Against a reference arrow of the
 * intended weight, drawn over a 1860×1317 capture: head 65pt across and 75pt
 * long, shaft 22pt. At the default stroke of 10 this geometry gives 66 / 79 /
 * 24 — the same arrow. The ratios below already matched; only the weight did
 * not, which is why this is one number and not four.
 */
const ARROW_WEIGHT = 2.2;

/**
 * Outline of an arrow: a parallel-sided shaft with a head on the end.
 *
 * A filled polygon rather than a stroked line with a marker, because markers
 * don't scale with stroke width predictably across renderers.
 *
 * The shaft used to taper from a near-point tail, on the theory that it made
 * the arrow look drawn rather than diagrammatic. It doesn't — it makes the tail
 * look like it is fading out, and an arrow pointing at something in a
 * screenshot wants a constant weight the eye can follow back to where it
 * started. Only the head flares.
 */
/**
 * How many pieces a bowed line is chopped into when it needs an outline.
 *
 * Only the arrow needs this: a stroked line is handed to both renderers as a
 * real quadratic, which they draw identically. An arrow is a filled outline
 * offset either side of its path, and there is no exact quadratic for the
 * offset of a quadratic — so it is walked instead. 48 is past the point where
 * more makes any visible difference at the zooms the editor allows.
 */
const CURVE_STEPS = 48;

/**
 * The control point of the quadratic a bent line follows, or null if straight.
 *
 * Twice the offset the bend asks for: a quadratic runs halfway between its
 * chord and its control point, so a control pushed out by 2d puts the *curve*
 * out by d — and d is what the handle was dragged to.
 */
export function bendControl(a: LineAnnotation): Point | null {
  const bend = canBend(a) ? (a.bend ?? 0) : 0;
  if (!bend) return null;
  const dx = a.x2 - a.x1;
  const dy = a.y2 - a.y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const h = 2 * bend * len;
  // Perpendicular, to the left of the direction of travel.
  return {
    x: (a.x1 + a.x2) / 2 - (dy / len) * h,
    y: (a.y1 + a.y2) / 2 + (dx / len) * h,
  };
}

/** A point on the line's path, `t` from 0 at the tail to 1 at the head. */
export function pointOnLine(a: LineAnnotation, t: number): Point {
  const c = bendControl(a);
  if (!c) return { x: a.x1 + (a.x2 - a.x1) * t, y: a.y1 + (a.y2 - a.y1) * t };
  const u = 1 - t;
  return {
    x: u * u * a.x1 + 2 * u * t * c.x + t * t * a.x2,
    y: u * u * a.y1 + 2 * u * t * c.y + t * t * a.y2,
  };
}

/** Where the bend grip sits: the middle of the path, bowed or not. */
export const lineMiddle = (a: LineAnnotation): Point => pointOnLine(a, 0.5);

/**
 * What bend would put the middle of the line under this point.
 *
 * The inverse of `bendControl`, and the whole of what the bend grip does: the
 * middle of the curve sits exactly `bend × length` off the chord, so the
 * answer is the grip's own distance from the chord over that length.
 */
export function bendTowards(a: LineAnnotation, at: Point): number {
  const dx = a.x2 - a.x1;
  const dy = a.y2 - a.y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return 0;
  const mx = (a.x1 + a.x2) / 2;
  const my = (a.y1 + a.y2) / 2;
  return ((at.x - mx) * -dy + (at.y - my) * dx) / (len * len);
}

/** The line itself, as a path both renderers draw the same way. */
export function linePath(a: LineAnnotation): string {
  const c = bendControl(a);
  const head = `M ${a.x1.toFixed(2)} ${a.y1.toFixed(2)}`;
  return c
    ? `${head} Q ${c.x.toFixed(2)} ${c.y.toFixed(2)} ${a.x2.toFixed(2)} ${a.y2.toFixed(2)}`
    : `${head} L ${a.x2.toFixed(2)} ${a.y2.toFixed(2)}`;
}

export function arrowPolygon(a: LineAnnotation): Point[] {
  if (bendControl(a)) return bowedArrow(a);

  const sw = a.style.strokeWidth * ARROW_WEIGHT;
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
  const shaftHalf = sw * 0.55;

  const bx = a.x2 - ux * headLen;
  const by = a.y2 - uy * headLen;

  return [
    { x: a.x1 + px * shaftHalf, y: a.y1 + py * shaftHalf },
    { x: bx + px * shaftHalf, y: by + py * shaftHalf },
    { x: bx + px * headHalf, y: by + py * headHalf },
    { x: a.x2, y: a.y2 },
    { x: bx - px * headHalf, y: by - py * headHalf },
    { x: bx - px * shaftHalf, y: by - py * shaftHalf },
    { x: a.x1 - px * shaftHalf, y: a.y1 - py * shaftHalf },
  ];
}

/**
 * The same arrow, walked along its curve.
 *
 * Kept apart from the straight one rather than made general: a straight arrow
 * is seven points of exact arithmetic that thousands of saved captures already
 * depend on, and rebuilding it out of 48 samples would move every one of them
 * by a fraction of a pixel for no gain at all. A bend is the only thing that
 * needs the walk.
 *
 * The shaft is the path offset either side; the head is squared to the
 * *tangent where the head begins*, not to the chord, so a hard bend still ends
 * in an arrow pointing where the line is actually going.
 */
function bowedArrow(a: LineAnnotation): Point[] {
  const sw = a.style.strokeWidth * ARROW_WEIGHT;
  const shaftHalf = sw * 0.55;
  const headHalf = sw * 1.5;

  const path: Point[] = [];
  for (let i = 0; i <= CURVE_STEPS; i++) path.push(pointOnLine(a, i / CURVE_STEPS));

  // Walked rather than solved: the arc length of a quadratic has no useful
  // closed form, and the head has to start a fixed distance back from the tip.
  const run: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    run.push(run[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
  }
  const total = run[run.length - 1] || 1;
  const headLen = Math.min(sw * 3.6, total * 0.6);
  const baseAt = total - headLen;

  let cut = path.length - 1;
  while (cut > 0 && run[cut] > baseAt) cut--;

  const tangent = (i: number): Point => {
    const from = path[Math.max(0, i - 1)];
    const to = path[Math.min(path.length - 1, i + 1)];
    const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    return { x: (to.x - from.x) / len, y: (to.y - from.y) / len };
  };

  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i <= cut; i++) {
    const t = tangent(i);
    left.push({ x: path[i].x - t.y * shaftHalf, y: path[i].y + t.x * shaftHalf });
    right.push({ x: path[i].x + t.y * shaftHalf, y: path[i].y - t.x * shaftHalf });
  }

  const base = path[cut];
  const bt = tangent(cut);
  return [
    ...left,
    { x: base.x - bt.y * headHalf, y: base.y + bt.x * headHalf },
    { x: a.x2, y: a.y2 },
    { x: base.x + bt.y * headHalf, y: base.y - bt.x * headHalf },
    ...right.reverse(),
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
 * Roughly the cap height of the UI font, as a fraction of the type size.
 *
 * Centring text by its cap height rather than its em box is what makes a label
 * *look* centred: the em box carries descender room that most labels never use,
 * so centring on it hangs the words high by a few percent of the size — small
 * on a 16px caption, plainly wrong on a 48px callout.
 */
const CAP_HEIGHT = 0.72;

/**
 * The baseline of each line of a callout, centred as a block in its box.
 *
 * Arithmetic rather than `dominant-baseline`, because that property is **not
 * inherited by `<tspan>`** — and a multi-line callout has to position each line
 * with its own `y`, which means tspans. WebKit therefore drew the block with
 * alphabetic baselines where the centres should have been, and hung the text
 * off the top of the box; Chromium inherited the property and looked correct,
 * which is exactly how the browser harness came to pass a bug the app has.
 *
 * Both renderers now ask this function where the baselines go and neither sets
 * a baseline mode at all, so there is nothing left for an engine to disagree
 * about.
 */
export function calloutBaselines(
  box: { y: number; height: number },
  layout: Pick<CalloutLayout, "lines" | "lineHeight">,
  fontSize: number,
): number[] {
  const block = layout.lines.length * layout.lineHeight;
  const top = box.y + (box.height - block) / 2;
  return layout.lines.map(
    (_, i) => top + layout.lineHeight * (i + 0.5) + (fontSize * CAP_HEIGHT) / 2,
  );
}

// ------------------------------------------------------------------- neon

/** A hex colour laid down at an opacity, so one swatch can paint three layers. */
export function withAlpha(hex: string, alpha: number): string {
  const raw = hex.replace("#", "");
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) || 0);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export interface NeonPaint {
  /** Near-black wash under the tint. See below — this is the legibility half. */
  scrim: string;
  /** The swatch colour, thin, over the scrim. */
  tint: string;
  /** The bright edge, in the swatch colour at full strength. */
  border: number;
  /** How far the light spills past that edge. */
  glow: number;
  /** Text on a neon fill is always white; the scrim is what guarantees it. */
  ink: string;
}

/**
 * The recipe for a neon box, in one place because two renderers draw it.
 *
 * Four layers, in order: a near-black scrim, a thin wash of the colour, the
 * bright border, and the glow spilling off it. Anything that changes here has
 * to change once — the SVG in the editor and the Canvas2D on export both read
 * these numbers, and a neon box that exports differently from its preview is
 * the one bug this whole module exists to prevent.
 *
 * **The scrim is not decoration.** A translucent tint alone looks right over
 * the dark screenshots these boxes were designed against and turns white text
 * into pale-on-pale over a bright one — and a screenshot tool cannot know
 * which it is about to be dropped on. Washing the area down first means the
 * ink is white against something dark whatever is underneath, which is why the
 * ink here is a constant rather than `contrastInk`.
 */
export function neonPaint(color: string, border: number): NeonPaint {
  const width = Math.max(2, border);
  return {
    scrim: "rgba(9, 10, 13, 0.62)",
    tint: withAlpha(color, 0.3),
    border: width,
    glow: Math.max(6, width * 3),
    ink: "#FFFFFF",
  };
}

/**
 * How thick a neon border is on a box whose only size control is its type.
 *
 * A callout has no stroke slider — see `styleControlsFor` — so the edge takes
 * its weight from the text it surrounds, the same way the padding does.
 */
export const neonBorderForFont = (fontSize: number) => Math.max(2, fontSize * 0.09);

/**
 * A neon box is rounder than a plain callout.
 *
 * The reference these were drawn from is a lozenge, and at the callout's flat
 * cap of 10px a large box reads as a rectangle with a lit edge rather than as
 * a sign. Still clamped to half the shorter side, or a small box turns into a
 * pill without being asked to.
 */
export function neonRadius(width: number, height: number): number {
  return Math.min(width / 2, height / 2, Math.max(10, height * 0.2));
}

/**
 * What a rectangle drawn before the radius was adjustable was drawn with.
 *
 * Markup written by an older Shotly carries no `cornerRadius`, and reading the
 * absence as the new default — a square corner — would redraw someone's saved
 * work as a slightly different shape. Four pixels is what those rectangles
 * have always had.
 */
const LEGACY_RECT_RADIUS = 4;

/**
 * How round a rectangle's corners are, in image pixels.
 *
 * Clamped to half the shorter side: a large radius on a box dragged out thin
 * would otherwise overlap its own corners and pinch in the middle. Neon
 * overrides the setting entirely — a lit sign is a lozenge by definition, and
 * its roundness has to follow the box it is drawn at rather than a number
 * chosen for a flat shape. See `neonRadius`.
 *
 * Both renderers call this, so the exported PNG rounds exactly as the preview
 * did.
 */
export function rectRadius(box: { width: number; height: number }, style: Style): number {
  const wanted = style.neon
    ? neonRadius(box.width, box.height)
    : (style.cornerRadius ?? LEGACY_RECT_RADIUS);
  return Math.max(0, Math.min(wanted, box.width / 2, box.height / 2));
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

// -------------------------------------------------------------- measuring

/**
 * Everything needed to draw a measurement, in document pixels.
 *
 * Shared rather than written twice: the SVG preview and the Canvas2D exporter
 * both consume this, so a dimension line that reads 240pt on screen cannot
 * come out of the exporter reading something else.
 */
export interface MeasureGeometry {
  /** The measuring line itself. */
  shaft: { x1: number; y1: number; x2: number; y2: number };
  /** The two end ticks, drawn across the line like a dimension drawing. */
  ticks: [Point, Point][];
  label: string;
  /** Centre of the label chip. */
  at: Point;
  /** The chip behind the label, so the number survives a busy screenshot. */
  box: { width: number; height: number; radius: number };
  fontSize: number;
}

/**
 * How far a measurement reaches, and what to call it.
 *
 * `scale` is the capture's backing scale — 2 on a Retina screenshot. Points
 * are what the eye saw and what CSS would call it; pixels are what is actually
 * in the file. When they are the same number there is only one honest label,
 * so a 1x capture always says px whatever the annotation asks for.
 */
export function measureLabel(
  lengthPx: number,
  scale: number,
  units: Style["measureUnits"],
): string {
  const points = units === "pt" && scale > 1;
  const value = points ? lengthPx / scale : lengthPx;
  // No decimals: these are pixel counts off a screenshot, and a tenth of a
  // pixel is precision the measurement does not have.
  return `${Math.round(value)}${points ? "pt" : "px"}`;
}

export function measureGeometry(a: LineAnnotation, scale: number): MeasureGeometry {
  const sw = a.style.strokeWidth;
  const dx = a.x2 - a.x1;
  const dy = a.y2 - a.y1;
  const len = Math.hypot(dx, dy);

  const ux = len > 0 ? dx / len : 1;
  const uy = len > 0 ? dy / len : 0;
  // Perpendicular, for the end ticks.
  const px = -uy;
  const py = ux;

  const tickHalf = sw * 1.6;
  const tick = (x: number, y: number): [Point, Point] => [
    { x: x + px * tickHalf, y: y + py * tickHalf },
    { x: x - px * tickHalf, y: y - py * tickHalf },
  ];

  // Sized off the stroke so the number grows with the line rather than
  // needing a second control of its own.
  const fontSize = Math.max(11, sw * 2.2);
  const label = measureLabel(len, scale, a.style.measureUnits);
  const m = measureText(label, fontSize);

  return {
    shaft: { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 },
    ticks: [tick(a.x1, a.y1), tick(a.x2, a.y2)],
    label,
    at: { x: (a.x1 + a.x2) / 2, y: (a.y1 + a.y2) / 2 },
    box: {
      width: m.width,
      height: fontSize * LINE_HEIGHT + TEXT_PADDING,
      radius: Math.min(6, sw),
    },
    fontSize,
  };
}

// --------------------------------------------------------------- rotation

/**
 * How annotations are turned.
 *
 * A shape is *stored* square to the axes and spun about its own centre when it
 * is drawn — one number on the shape rather than rotated geometry. Everything
 * that already worked on boxes and points keeps working untouched: the stored
 * width of a rectangle is still its width, text still wraps to a horizontal
 * line length, and a callout laid out at 30° is laid out exactly as it would
 * be at 0°. Only the last step before ink differs, and both renderers take it
 * — `rotate()` in SVG, `ctx.rotate` on the canvas.
 *
 * Rotating about the centre, specifically, is what makes it free: the centre
 * is the one point a rotation does not move, so a spun shape still has the
 * position it is stored with and dragging it is still a translation.
 */

/** Rotation snaps to this many degrees while Shift is held. */
export const ROTATE_STEP = 15;

const ORIGIN: Point = { x: 0, y: 0 };

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const centreOf = (b: Box): Point => ({
  x: b.x + b.width / 2,
  y: b.y + b.height / 2,
});

/** Turn a point `deg` degrees clockwise about another. */
export function rotatePoint(p: Point, about: Point, deg: number): Point {
  if (!deg) return p;
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const dx = p.x - about.x;
  const dy = p.y - about.y;
  return {
    x: about.x + dx * cos - dy * sin,
    y: about.y + dx * sin + dy * cos,
  };
}

/** The SVG transform that spins a shape in place — nothing at all at 0°. */
export function spinTransform(deg: number, centre: Point): string | undefined {
  return deg ? `rotate(${deg} ${centre.x} ${centre.y})` : undefined;
}

/** The four corners of a box once it has been spun, clockwise from top-left. */
export function spunCorners(b: Box, deg: number): Point[] {
  const c = centreOf(b);
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.width, y: b.y },
    { x: b.x + b.width, y: b.y + b.height },
    { x: b.x, y: b.y + b.height },
  ].map((p) => rotatePoint(p, c, deg));
}

/**
 * What a spun box actually covers.
 *
 * Wider and taller than the box itself at every angle but a right one — which
 * is the point: a crop that has to hold a shape has to hold where the shape
 * *is*, not where its unrotated twin would be.
 */
export function spunBounds(b: Box, deg: number): Box {
  if (!deg) return { x: b.x, y: b.y, width: b.width, height: b.height };
  const xs = spunCorners(b, deg).map((p) => p.x);
  const ys = spunCorners(b, deg).map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * Where an annotation really lands, once it has been turned.
 *
 * `boundsOf` is the shape's own box, which is what resizing, wrapping and
 * hit-testing all work in. This is the room it takes up on the page, which is
 * what cropping and fitting need — at any angle but a right one the two differ.
 */
export function spunBoundsOf(a: Annotation): Rect {
  return spunBounds(boundsOf(a), angleOf(a)) as Rect;
}

/** Fold an angle into (-180, 180], so turning round and round never drifts. */
export function normalizeAngle(deg: number): number {
  const wrapped = ((deg % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/**
 * Where Shift lands a turn.
 *
 * On the angle the shape ends up at, not on how far the hand has moved it —
 * so Shift finds true upright and true square, rather than fifteen degrees
 * from wherever the shape happened to be already.
 */
export const snapTurn = (from: number, by: number): number =>
  Math.round((from + by) / ROTATE_STEP) * ROTATE_STEP - from;

/** Which way `p` lies from `centre`, in degrees clockwise from straight up. */
export function angleFrom(centre: Point, p: Point): number {
  return (Math.atan2(p.y - centre.y, p.x - centre.x) * 180) / Math.PI + 90;
}

/**
 * Resizing something that has been spun, without any new arithmetic.
 *
 * Dragging a corner of a turned shape is the same drag it always was, seen
 * from a room tilted the other way. `unspun` takes a point — or a box — into
 * that room, where the shape is square to the axes again and the ordinary
 * anchor-and-opposite-corner maths applies exactly as written. `respun` takes
 * the answer back out.
 *
 * The two are inverses, and the corner under the pointer is what they hold
 * fixed: a shape spins about its own centre, so a resize that moves the centre
 * would swing the whole shape out from under the hand without this.
 */
export const unspun = (p: Point, deg: number): Point => rotatePoint(p, ORIGIN, -deg);

export function unspunBox<T extends Box>(b: T, deg: number): T {
  const c = centreOf(b);
  const m = unspun(c, deg);
  return { ...b, x: b.x + m.x - c.x, y: b.y + m.y - c.y };
}

export function respunBox<T extends Box>(b: T, deg: number): T {
  const m = centreOf(b);
  const c = rotatePoint(m, ORIGIN, deg);
  return { ...b, x: b.x + c.x - m.x, y: b.y + c.y - m.y };
}

/**
 * The eight resize handles, and the rotate grip that floats above them.
 *
 * Corners scale both ways; the four on the flat sides scale one. `anchor` is
 * the fraction of the box that must not move while this handle is dragged —
 * the opposite corner for a corner, the opposite edge for a side, where 0.5
 * means "this axis is not being resized at all".
 */
export type HandleAxis = 0 | 0.5 | 1;

export interface HandleSpec {
  id: string;
  /** Where on the box it sits, as a fraction of width and height. */
  at: readonly [HandleAxis, HandleAxis];
}

export const HANDLE_SPECS = [
  { id: "nw", at: [0, 0] },
  { id: "n", at: [0.5, 0] },
  { id: "ne", at: [1, 0] },
  { id: "e", at: [1, 0.5] },
  { id: "se", at: [1, 1] },
  { id: "s", at: [0.5, 1] },
  { id: "sw", at: [0, 1] },
  { id: "w", at: [0, 0.5] },
] as const satisfies readonly HandleSpec[];

export type HandleName = (typeof HANDLE_SPECS)[number]["id"];

const HANDLE_AT = new Map<string, readonly [HandleAxis, HandleAxis]>(
  HANDLE_SPECS.map((h) => [h.id, h.at]),
);

/** Where a handle sits on a box, before the box is spun. */
export function handlePoint(b: Box, handle: HandleName): Point {
  const [fx, fy] = HANDLE_AT.get(handle) ?? [1, 1];
  return { x: b.x + b.width * fx, y: b.y + b.height * fy };
}

/**
 * The point a drag of this handle must leave where it is.
 *
 * For a corner that is the opposite corner. For a side it is the opposite
 * edge, and the other axis is pinned to the centre — which is what stops a
 * top-edge drag from also sliding the shape sideways.
 */
export function handleAnchor(b: Box, handle: HandleName): Point {
  const [fx, fy] = HANDLE_AT.get(handle) ?? [0, 0];
  return {
    x: b.x + b.width * (fx === 0.5 ? 0.5 : 1 - fx),
    y: b.y + b.height * (fy === 0.5 ? 0.5 : 1 - fy),
  };
}

/** True where dragging this handle must not touch that axis at all. */
export const holdsWidth = (handle: HandleName) => handle === "n" || handle === "s";
export const holdsHeight = (handle: HandleName) => handle === "e" || handle === "w";

/**
 * The box a handle drag asks for.
 *
 * Written once because both the editor and the live overlay resize the same
 * way, and a side handle that behaved differently in the two would be a bug
 * nobody could describe. Every coordinate here is in unspun space — see
 * `unspun` — so this is the same arithmetic it always was.
 */
export function resizedBox(
  before: Box,
  handle: HandleName,
  anchor: Point,
  to: Point,
): Box {
  // A side handle leaves its other axis exactly as it found it: the anchor is
  // pinned to the centre there, so measuring from it would halve the shape.
  const x0 = holdsWidth(handle) ? before.x : Math.min(anchor.x, to.x);
  const x1 = holdsWidth(handle) ? before.x + before.width : Math.max(anchor.x, to.x);
  const y0 = holdsHeight(handle) ? before.y : Math.min(anchor.y, to.y);
  const y1 = holdsHeight(handle) ? before.y + before.height : Math.max(anchor.y, to.y);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const RESIZE_CURSORS = ["ns-resize", "nesw-resize", "ew-resize", "nwse-resize"];

/**
 * The cursor for a handle, once the shape it belongs to has been turned.
 *
 * A shape lying on its side wants its top handle to say "this stretches
 * sideways", because it does. Rounded to the nearest 45° — the four cursors
 * macOS actually has — and taken modulo 180°, since a resize arrow is the same
 * arrow whichever end you read it from.
 */
export function resizeCursor(handle: HandleName, deg: number): string {
  const [fx, fy] = HANDLE_AT.get(handle) ?? [1, 1];
  // Which way the handle points out of the box, as an angle.
  const base = angleFrom(ORIGIN, { x: fx - 0.5, y: fy - 0.5 });
  const turned = (((base + deg) % 180) + 180) % 180;
  return RESIZE_CURSORS[Math.round(turned / 45) % 4];
}
