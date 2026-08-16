import { readCaptureBytes } from "./ipc";

/**
 * Reading pixels back out of a capture, for the eyedropper.
 *
 * The bytes come through Rust and a blob URL rather than the asset protocol,
 * for the same reason the exporter does it that way: a cross-origin image
 * taints the canvas, and `getImageData` on a tainted canvas throws.
 *
 * Sampling itself is synchronous. The eyedropper reads a colour on every
 * pointer move, and an async read per move would deliver colours out of order
 * and lag the readout behind the cursor. So the whole image is decoded once,
 * up front, and every sample after that is a lookup.
 */

interface Sheet {
  path: string;
  ctx: CanvasRenderingContext2D;
}

let sheet: Sheet | null = null;
let loading: { path: string; done: Promise<void> } | null = null;

/**
 * Decode a capture ready for sampling.
 *
 * Safe to call repeatedly — the same path is only ever decoded once, and
 * overlapping calls for it share the one read already in flight.
 */
export async function preloadPixels(path: string): Promise<void> {
  if (sheet?.path === path) return;
  if (loading?.path === path) return loading.done;

  const done = (async () => {
    const bytes = await readCaptureBytes(path);
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    try {
      const img = await decode(url);
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("could not acquire a 2D context");
      ctx.drawImage(img, 0, 0);
      // Only if this is still the read anyone is waiting for: a slower read of
      // a document since navigated away from must not install itself over the
      // current one.
      if (loading?.path === path) sheet = { path, ctx };
    } finally {
      URL.revokeObjectURL(url);
      if (loading?.path === path) loading = null;
    }
  })();

  loading = { path, done };
  return done;
}

/**
 * The colour at a point in *source image* pixels, as `#RRGGBB`.
 *
 * `null` until `preloadPixels` has finished, or if the point is outside the
 * image — the caller shows nothing rather than a wrong colour.
 */
export function sampleColor(path: string, x: number, y: number): string | null {
  if (sheet?.path !== path) return null;

  const px = Math.floor(x);
  const py = Math.floor(y);
  const { canvas } = sheet.ctx;
  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return null;

  const [r, g, b, a] = sheet.ctx.getImageData(px, py, 1, 1).data;
  // A fully transparent pixel has no colour to report; its RGB is whatever the
  // encoder left behind, which is usually black and always a lie.
  if (a === 0) return null;

  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/**
 * Pull a point onto the nearest strong edge along one axis.
 *
 * This is what turns "measure this gap" from a steady-hand exercise into a
 * rough drag: you pull a line across the space between two elements and the
 * ends click onto where those elements actually stop. Only along the direction
 * being measured — snapping across it would move the line off the row the user
 * aimed at.
 *
 * The edge is the biggest jump in brightness within `radius`, and ties go to
 * the one nearest where the pointer already was, so an even gradient leaves
 * the point exactly where it was put. `null` when the pixels aren't loaded or
 * nothing in reach looks like an edge.
 */
export function snapToEdge(
  path: string,
  x: number,
  y: number,
  /** Unit vector along the measurement. */
  dir: { x: number; y: number },
  radius = 12,
): { x: number; y: number } | null {
  if (sheet?.path !== path) return null;
  const { canvas } = sheet.ctx;

  // The whole neighbourhood in one read. This runs on every pointer move of a
  // measuring drag, and a `getImageData` per sampled pixel was fifty calls a
  // frame for a strip that fits in a single small rectangle.
  const span = Math.round(radius);
  const x0 = Math.round(x) - span;
  const y0 = Math.round(y) - span;
  const side = span * 2 + 1;
  if (x0 + side <= 0 || y0 + side <= 0 || x0 >= canvas.width || y0 >= canvas.height) return null;
  const patch = sheet.ctx.getImageData(x0, y0, side, side);

  const lumaAt = (px: number, py: number): number => {
    const ix = px - x0;
    const iy = py - y0;
    if (ix < 0 || iy < 0 || ix >= side || iy >= side) return Number.NaN;
    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return Number.NaN;
    const i = (iy * side + ix) * 4;
    const d = patch.data;
    return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  };

  // One strip of pixels along the axis, centred on the point.
  const luma: number[] = [];
  for (let t = -span; t <= span; t++) {
    luma.push(lumaAt(Math.round(x + dir.x * t), Math.round(y + dir.y * t)));
  }

  /** Below this a "jump" is just noise or a gradient, not an edge. */
  const MIN_JUMP = 24;

  let best: { t: number; jump: number } | null = null;
  for (let i = 1; i < luma.length; i++) {
    const jump = Math.abs(luma[i] - luma[i - 1]);
    if (!Number.isFinite(jump) || jump < MIN_JUMP) continue;
    // The boundary sits between the two samples; take the later one, which is
    // the first pixel of the new thing.
    const t = i - span;
    if (best === null || jump > best.jump || (jump === best.jump && Math.abs(t) < Math.abs(best.t))) {
      best = { t, jump };
    }
  }

  if (best === null) return null;
  return { x: x + dir.x * best.t, y: y + dir.y * best.t };
}

/**
 * Release the decoded copy.
 *
 * Worth doing rather than leaving to chance: this is a full-resolution RGBA
 * canvas, which for a 5K capture is tens of megabytes held for a feature the
 * user may never touch again.
 */
export function forgetPixels(): void {
  sheet = null;
}

function decode(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not decode the capture"));
    img.src = url;
  });
}
