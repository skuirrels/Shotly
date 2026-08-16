/**
 * The frame a capture can be presented in.
 *
 * A screenshot pasted into a slide or a release note usually wants a margin
 * and a soft edge around it — it reads as a deliberate illustration rather
 * than a raw grab. This is that margin: a background, some space, rounded
 * corners and a shadow.
 *
 * Everything is stored as a fraction of the capture's shorter side rather than
 * in pixels, so the same setting looks the same on a 600px crop and a 5K
 * screen. A fixed 64px margin is generous on one and invisible on the other.
 */

export interface Backdrop {
  /** Preset id, or `none` for no frame at all. */
  fill: string;
  /** Margin around the capture, as a fraction of its shorter side. */
  padding: number;
  /** Corner rounding, in the same terms. */
  radius: number;
  shadow: boolean;
}

export interface BackdropFill {
  id: string;
  name: string;
  /** Gradient stops. A solid colour is simply the same value twice. */
  from: string;
  to: string;
  /** CSS gradient angle: 0 points up, 90 to the right. */
  angle: number;
}

/**
 * Deliberately few, and none of them loud.
 *
 * The frame is there to set the screenshot off, not to be looked at. Every one
 * of these is dark enough or pale enough to sit behind a window chrome of any
 * colour without fighting it.
 */
export const BACKDROP_FILLS: BackdropFill[] = [
  { id: "slate", name: "Slate", from: "#2b3140", to: "#161a22", angle: 160 },
  { id: "dusk", name: "Dusk", from: "#5b4b8a", to: "#241d3a", angle: 160 },
  { id: "ember", name: "Ember", from: "#f0793a", to: "#c2354e", angle: 160 },
  { id: "ocean", name: "Ocean", from: "#3aa0f0", to: "#134b8f", angle: 160 },
  { id: "moss", name: "Moss", from: "#4fae7d", to: "#1d5b45", angle: 160 },
  { id: "paper", name: "Paper", from: "#f2f2f0", to: "#d8d8d4", angle: 160 },
  { id: "ink", name: "Ink", from: "#0e0f12", to: "#0e0f12", angle: 0 },
];

export const NO_BACKDROP: Backdrop = { fill: "none", padding: 0.05, radius: 0.015, shadow: true };

/** Sensible frame for someone who has just clicked a colour. */
export const DEFAULT_BACKDROP: Backdrop = { ...NO_BACKDROP, fill: "slate" };

export const fillById = (id: string): BackdropFill | null =>
  BACKDROP_FILLS.find((f) => f.id === id) ?? null;

/** Is this backdrop actually going to draw anything? */
export const hasBackdrop = (b: Backdrop | null | undefined): boolean =>
  !!b && b.fill !== "none" && !!fillById(b.fill);

/** The frame's measurements in real pixels, for a capture of this size. */
export function backdropMetrics(b: Backdrop, width: number, height: number) {
  const shorter = Math.min(width, height);
  const pad = Math.round(shorter * b.padding);
  return {
    pad,
    radius: Math.round(shorter * b.radius),
    /** The whole exported image, frame included. */
    width: width + pad * 2,
    height: height + pad * 2,
    /** Soft and low, so it reads as depth rather than as an effect. */
    shadowBlur: Math.round(shorter * 0.03),
    shadowOffset: Math.round(shorter * 0.008),
  };
}

/** The preset as a CSS value, for the editor's own preview and the swatches. */
export function fillToCss(fill: BackdropFill): string {
  return `linear-gradient(${fill.angle}deg, ${fill.from}, ${fill.to})`;
}

/**
 * The same gradient as a canvas object.
 *
 * CSS measures its angle from "up" and turns clockwise; canvas wants two
 * points. The line runs through the centre, and is long enough that the stops
 * land on the box's edges rather than somewhere inside it.
 */
export function fillToCanvas(
  ctx: CanvasRenderingContext2D,
  fill: BackdropFill,
  width: number,
  height: number,
): CanvasGradient {
  const t = (fill.angle * Math.PI) / 180;
  const dx = Math.sin(t);
  const dy = -Math.cos(t);
  const length = Math.abs(width * dx) + Math.abs(height * dy);
  const cx = width / 2;
  const cy = height / 2;

  const gradient = ctx.createLinearGradient(
    cx - (dx * length) / 2,
    cy - (dy * length) / 2,
    cx + (dx * length) / 2,
    cy + (dy * length) / 2,
  );
  gradient.addColorStop(0, fill.from);
  gradient.addColorStop(1, fill.to);
  return gradient;
}
