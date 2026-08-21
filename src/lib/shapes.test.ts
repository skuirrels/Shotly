/**
 * Pins `rectRadius`, which both renderers call — the SVG preview and the
 * Canvas2D export. A change here that only one of them agreed with would show
 * as a shape that looks one way on screen and another in the saved PNG.
 */
import { expect, test } from "vitest";
import { arrowPolygon, bendTowards, lineMiddle, linePath, rectRadius } from "./shapes";
import type { LineAnnotation, Style } from "./types";

const style = (patch: Partial<Style>): Style =>
  ({
    color: "#FF3B30",
    strokeWidth: 10,
    fontSize: 48,
    fillOpacity: 0,
    cornerRadius: 0,
    blurRadius: 12,
    dim: 0.55,
    shadow: true,
    neon: false,
    measureUnits: "pt",
    ...patch,
  }) as Style;

const box = { width: 400, height: 200 };

test("a square corner stays square", () => {
  expect(rectRadius(box, style({ cornerRadius: 0 }))).toBe(0);
});

test("the radius is used as written when the box is big enough for it", () => {
  expect(rectRadius(box, style({ cornerRadius: 48 }))).toBe(48);
});

test("a radius larger than the box is clamped to half its shorter side", () => {
  expect(rectRadius({ width: 400, height: 30 }, style({ cornerRadius: 96 }))).toBe(15);
});

test("neon rounds itself, whatever the radius says", () => {
  expect(rectRadius(box, style({ cornerRadius: 0, neon: true }))).toBe(40);
});

/**
 * Markup saved before the radius was adjustable carries no `cornerRadius`, and
 * every rectangle in it was drawn at 4. Reading the absence as the new default
 * would redraw someone's saved work with different corners.
 */
test("a rectangle from an older payload keeps the corners it was drawn with", () => {
  const old = style({});
  delete (old as Partial<Style>).cornerRadius;
  expect(rectRadius(box, old)).toBe(4);
});

// ------------------------------------------------------------------- bend

/**
 * A bent line is one number — how far it bows out of the run between its ends
 * — and both renderers have to turn that number into the same curve. The
 * straight case matters most: thousands of saved arrows are straight, and the
 * bend must not have moved any of them.
 */
const line = (patch: Partial<LineAnnotation> = {}): LineAnnotation => ({
  id: "l",
  kind: "arrow",
  x1: 0,
  y1: 0,
  x2: 400,
  y2: 0,
  style: style({}),
  ...patch,
});

test("a straight arrow is the same seven points it always was", () => {
  expect(arrowPolygon(line())).toHaveLength(7);
  expect(arrowPolygon(line({ bend: 0 }))).toEqual(arrowPolygon(line()));
});

test("the middle of a bowed line sits its bend off the straight run", () => {
  // 0.25 of a 400px run is 100px, and the perpendicular is to the left of the
  // direction of travel — which for a line drawn rightwards is downwards.
  const at = lineMiddle(line({ bend: 0.25 }));
  expect(at.x).toBeCloseTo(200, 6);
  expect(at.y).toBeCloseTo(100, 6);
});

test("dragging the grip somewhere asks for the bend that puts it there", () => {
  const a = line();
  const bend = bendTowards(a, { x: 200, y: 100 });
  expect(bend).toBeCloseTo(0.25, 6);
  expect(lineMiddle({ ...a, bend }).y).toBeCloseTo(100, 6);
});

test("a bowed arrow still comes to a point exactly where it was aimed", () => {
  const points = arrowPolygon(line({ bend: 0.4, x2: 300, y2: 200 }));
  expect(points).toContainEqual({ x: 300, y: 200 });
});

test("a measurement never bows, whatever it is carrying", () => {
  const straight = linePath({ ...line({ kind: "measure" }), bend: 0.5 } as LineAnnotation);
  expect(straight).toContain(" L ");
  expect(linePath(line({ bend: 0.5 }))).toContain(" Q ");
});
