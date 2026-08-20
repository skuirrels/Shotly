/**
 * Pins `rectRadius`, which both renderers call — the SVG preview and the
 * Canvas2D export. A change here that only one of them agreed with would show
 * as a shape that looks one way on screen and another in the saved PNG.
 */
import { expect, test } from "vitest";
import { rectRadius } from "./shapes";
import type { Style } from "./types";

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
