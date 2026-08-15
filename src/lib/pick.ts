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
