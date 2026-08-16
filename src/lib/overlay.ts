import * as ipc from "./ipc";
import type { ImageAnnotation, Rect, Style } from "./types";

/**
 * Images laid over the capture being edited.
 *
 * Two ways in — the clipboard and the library — and one thing they produce: a
 * PNG data URL plus the size it decodes to. Everything downstream of here
 * treats an overlay as pixels the document owns, with no path to go stale.
 */
export interface OverlaySource {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
}

/** How much of the canvas a freshly placed overlay is allowed to cover. */
const PLACE_FRACTION = 0.5;

/**
 * The clipboard's image, or `null` when it holds something else.
 *
 * Null is a normal answer: ⌘V is a general-purpose key and most of what people
 * copy is not a picture.
 */
export async function overlayFromClipboard(): Promise<OverlaySource | null> {
  const src = await ipc.readClipboardImage();
  return src ? await withNaturalSize(src) : null;
}

/** A saved capture, ready to lay over the one in the editor. */
export async function overlayFromLibrary(path: string): Promise<OverlaySource> {
  return await withNaturalSize(await ipc.imageDataUrl(path));
}

/**
 * Where a new overlay lands: centred, and shrunk to fit if it would swamp the
 * picture underneath.
 *
 * Only ever shrunk. Dropping a small logo onto a large screenshot should give
 * you the logo at its own size — blowing it up to fill half the canvas would
 * both look wrong and invent detail the source doesn't have.
 */
export function placeOverlay(
  source: OverlaySource,
  canvas: { width: number; height: number },
  style: Style,
): Omit<ImageAnnotation, "id"> {
  const fit = Math.min(
    1,
    (canvas.width * PLACE_FRACTION) / source.naturalWidth,
    (canvas.height * PLACE_FRACTION) / source.naturalHeight,
  );
  const width = Math.round(source.naturalWidth * fit);
  const height = Math.round(source.naturalHeight * fit);

  return {
    kind: "image",
    x: Math.round((canvas.width - width) / 2),
    y: Math.round((canvas.height - height) / 2),
    width,
    height,
    src: source.src,
    naturalWidth: source.naturalWidth,
    naturalHeight: source.naturalHeight,
    style: { ...style },
  };
}

/**
 * Resize an overlay to `box` without distorting it.
 *
 * The dragged corner rarely lands on the aspect ratio exactly, so one axis has
 * to give. Taking the larger scale means the image always covers the rectangle
 * you drew — undershooting would leave a gap on the side you were watching.
 */
export function fitToBox(a: ImageAnnotation, box: Rect, anchor: { x: number; y: number }): Rect {
  const aspect = a.naturalWidth / a.naturalHeight;
  const scale = Math.max(box.width / a.naturalWidth, box.height / a.naturalHeight);
  const width = Math.max(1, a.naturalWidth * scale);
  const height = Math.max(1, width / aspect);

  // Grow away from the fixed corner, so the handle opposite the one being
  // dragged stays exactly where it was.
  return {
    width,
    height,
    x: box.x < anchor.x ? anchor.x - width : anchor.x,
    y: box.y < anchor.y ? anchor.y - height : anchor.y,
  };
}

/** Decode just far enough to learn the image's real size. */
function withNaturalSize(src: string): Promise<OverlaySource> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      resolve({ src, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight });
    img.onerror = () => reject(new Error("that image could not be decoded"));
    img.src = src;
  });
}
