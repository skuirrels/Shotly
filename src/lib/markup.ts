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
}

/**
 * 2 added the freehand and spotlight shapes; 3 added callouts.
 *
 * Bumping rather than quietly extending the last one is what keeps the promise
 * below honest: a build that predates these shapes sees a version it doesn't
 * know and opens the capture flat, instead of drawing a document with pieces
 * of it silently missing.
 */
const VERSION = 3;

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
