import { centreOf, spunBoundsOf } from "./shapes";
import { type Annotation, canBond, isLine, isStep } from "./types";
import type { LineAnnotation, Point, Rect } from "./types";

/**
 * Arrows that stay pointed at the thing they were aimed at.
 *
 * The rule this file exists to keep: an end that has been tied to a shape sits
 * on that shape's edge, facing the other end, however either of them moves
 * afterwards. Everything else about a connector is an ordinary line — the
 * coordinates are real and stay real, so hit-testing, the exporter, the
 * markup format and a future reader that has never heard of bonds all keep
 * working without knowing anything about this.
 *
 * That choice is the whole design. The alternative — resolving the ends at
 * draw time — would mean every renderer needed the rest of the document to
 * know where one arrow was, and `boundsOf` would stop being a function of its
 * argument. Here, `rerouted` is run after anything that moves a shape and the
 * coordinates catch up.
 */

/**
 * How far short of the shape an arrow stops, before its own weight is added.
 *
 * Touching looks like a mistake and overlapping looks like a bug; a gap says
 * "points at" rather than "attached to". Scaled by the stroke on top of this,
 * because a heavy arrow needs more room to read as separate.
 */
export const BOND_GAP = 7;

const gapFor = (a: LineAnnotation): number => BOND_GAP + a.style.strokeWidth * 0.6;

/**
 * Where a line coming from `towards` should meet this shape.
 *
 * Measured on the shape's upright bounds even when it is turned: a bond wants
 * the edge you can see, and the box a turned rectangle occupies is the shape
 * the eye is following the arrow to.
 */
export function attachPoint(target: Annotation, towards: Point, gap: number): Point {
  const box = spunBoundsOf(target);
  const c = centreOf(box);
  const dx = towards.x - c.x;
  const dy = towards.y - c.y;
  const len = Math.hypot(dx, dy);
  // Sitting on top of it: there is no direction to leave in, so the centre is
  // the only answer that will not jump about as the shapes are nudged.
  if (len < 1e-6) return c;

  const ux = dx / len;
  const uy = dy / len;
  const edge = roundish(target) ? onEllipse(box, ux, uy) : onRect(box, ux, uy);
  return { x: c.x + ux * (edge + gap), y: c.y + uy * (edge + gap) };
}

/** Shapes whose edge is a curve rather than a box. */
const roundish = (a: Annotation): boolean => a.kind === "ellipse" || isStep(a);

/** How far the box's edge is from its centre, in the direction (ux, uy). */
function onRect(box: Rect, ux: number, uy: number): number {
  const rx = box.width / 2;
  const ry = box.height / 2;
  const byX = Math.abs(ux) < 1e-9 ? Infinity : rx / Math.abs(ux);
  const byY = Math.abs(uy) < 1e-9 ? Infinity : ry / Math.abs(uy);
  return Math.min(byX, byY);
}

/** The same for an ellipse, by squashing it into a circle and back. */
function onEllipse(box: Rect, ux: number, uy: number): number {
  const rx = box.width / 2 || 1;
  const ry = box.height / 2 || 1;
  return 1 / Math.hypot(ux / rx, uy / ry);
}

/**
 * Put every tied end back where it belongs.
 *
 * Run after anything that moves, resizes, turns or deletes a shape. Cheap
 * enough to run after all of them: it leaves the array alone entirely unless
 * something is actually bonded.
 *
 * Aimed centre-to-centre rather than solved: each end is placed on its own
 * edge facing the *centre* of what the other end is on. Solving the pair
 * properly — each end facing where the other one ended up — moves both by a
 * degree or two on shapes of very different sizes, and can oscillate on the
 * ones where it matters least.
 */
export function rerouted(annotations: Annotation[]): Annotation[] {
  if (!annotations.some((a) => isLine(a) && (a.fromId || a.toId))) return annotations;

  const byId = new Map(annotations.map((a) => [a.id, a]));
  return annotations.map((a) => {
    if (!isLine(a) || (!a.fromId && !a.toId)) return a;

    const from = a.fromId ? byId.get(a.fromId) : undefined;
    const to = a.toId ? byId.get(a.toId) : undefined;
    // A bond to a shape that has been deleted is not a bond, and holding onto
    // the id would tie the arrow to whatever an undo brought back in its place.
    const next: LineAnnotation = { ...a };
    if (a.fromId && !from) delete next.fromId;
    if (a.toId && !to) delete next.toId;
    if (!from && !to) return next;

    const gap = gapFor(a);
    const head = to ? centreOf(spunBoundsOf(to)) : { x: a.x2, y: a.y2 };
    const tail = from ? centreOf(spunBoundsOf(from)) : { x: a.x1, y: a.y1 };

    if (from) {
      const p = attachPoint(from, head, gap);
      next.x1 = p.x;
      next.y1 = p.y;
    }
    if (to) {
      const p = attachPoint(to, tail, gap);
      next.x2 = p.x;
      next.y2 = p.y;
    }
    return next;
  });
}

/**
 * What an end dropped here would tie itself to, if anything.
 *
 * Topmost first, since that is the one under the pointer as far as the eye is
 * concerned. Locked shapes are still valid targets: locked means "not to be
 * edited", and being pointed at is not an edit.
 */
export function bondTargetAt(
  annotations: Annotation[],
  at: Point,
  exclude: string,
): Annotation | null {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    if (a.id === exclude || !canBond(a)) continue;
    const b = spunBoundsOf(a);
    if (at.x >= b.x && at.x <= b.x + b.width && at.y >= b.y && at.y <= b.y + b.height) return a;
  }
  return null;
}

/** Does this line have either end tied to something? */
export const isBonded = (a: Annotation): boolean =>
  isLine(a) && Boolean(a.fromId || a.toId);
