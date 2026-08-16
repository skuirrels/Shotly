import type { Backdrop } from "./backdrop";
import type { Annotation, Rect } from "./types";

/**
 * The re-editing payload Shotly stores inside a saved PNG.
 *
 * Kept deliberately small and self-describing. The Rust side treats it as an
 * opaque string (see `src-tauri/src/markup.rs`) — nothing outside this file
 * needs to know the shape, which is what makes it cheap to change later.
 */
export interface MarkupDoc {
  version: number;
  /** The visible window onto the source image. Cropping is non-destructive. */
  crop: Rect;
  /** Where the step tool had counted to, so numbering continues rather than restarting. */
  stepCounter: number;
  annotations: Annotation[];
  /** The frame drawn around the capture. Absent in payloads written before 5. */
  backdrop?: Backdrop;
  /**
   * How much of its natural size the export is drawn at. Absent before 6,
   * where it reads as 1 — which is what every older capture in fact was.
   */
  outputScale?: number;
  /**
   * What shows through where the capture doesn't reach. Absent before 7,
   * where the crop was always inside the image and none ever showed.
   */
  canvasFill?: string;
}

/**
 * 2 added the freehand and spotlight shapes; 3 added callouts; 4 added
 * overlaid images, which is also the first version whose payload can be large;
 * 5 added the backdrop; 6 added the output scale; 7 let the crop grow past the
 * capture, which is how the canvas expands, and gave the bare part a colour.
 *
 * Bumping rather than quietly extending the last one is what keeps the promise
 * below honest: a build that predates these shapes sees a version it doesn't
 * know and opens the capture flat, instead of drawing a document with pieces
 * of it silently missing. The backdrop earns a bump on exactly those grounds —
 * an older build would draw the annotations correctly and lose the frame, and
 * a frame silently missing is a different picture. So does the output scale:
 * an older build reopening a halved capture would export it at full size, and
 * quietly hand back a file twice the dimensions that were asked for. And so
 * does the expanded canvas, most of all: an older build would read the wider
 * crop, fail to draw anything in the part with no capture behind it, and hand
 * back a picture with a hole in it.
 */
const VERSION = 7;

export function serialize(doc: Omit<MarkupDoc, "version">): string {
  return JSON.stringify({ version: VERSION, ...doc });
}

/**
 * Read a payload back, or `null` if it can't be trusted.
 *
 * Deliberately forgiving: this parses bytes that came off disk, possibly
 * written by a different version of Shotly, possibly truncated by a tool that
 * rewrote the file. Anything unrecognised falls back to opening the capture
 * flat, which is exactly what happened before this feature existed — a worse
 * result than re-editing, but never a broken document or a lost file.
 */
export function parse(json: string): MarkupDoc | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }

  if (typeof raw !== "object" || raw === null) return null;
  const doc = raw as Partial<MarkupDoc>;

  // A newer version may mean shapes this build cannot draw. Opening flat is
  // the honest response; silently dropping the ones it doesn't understand
  // would look like data loss. Older ones are always readable — every version
  // so far has only added shapes, so nothing in an old payload needs
  // translating to be understood by a new build.
  if (typeof doc.version !== "number" || doc.version > VERSION) return null;
  if (!Array.isArray(doc.annotations)) return null;
  if (!isRect(doc.crop)) return null;

  return {
    version: VERSION,
    crop: doc.crop,
    stepCounter: typeof doc.stepCounter === "number" ? doc.stepCounter : 1,
    annotations: doc.annotations as Annotation[],
    backdrop: isBackdrop(doc.backdrop) ? doc.backdrop : undefined,
    // Range-checked as well as type-checked: a zero or a negative here would
    // reach the exporter as a canvas of no size at all.
    outputScale:
      typeof doc.outputScale === "number" && doc.outputScale > 0 && doc.outputScale <= 1
        ? doc.outputScale
        : undefined,
    canvasFill: typeof doc.canvasFill === "string" ? doc.canvasFill : undefined,
  };
}

function isRect(value: unknown): value is Rect {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<Rect>;
  return (
    typeof r.x === "number" &&
    typeof r.y === "number" &&
    typeof r.width === "number" &&
    typeof r.height === "number" &&
    r.width > 0 &&
    r.height > 0
  );
}

/** A frame from disk, checked field by field before it is trusted. */
function isBackdrop(value: unknown): value is Backdrop {
  if (typeof value !== "object" || value === null) return false;
  const b = value as Partial<Backdrop>;
  return (
    typeof b.fill === "string" &&
    typeof b.padding === "number" &&
    typeof b.radius === "number" &&
    typeof b.shadow === "boolean"
  );
}
