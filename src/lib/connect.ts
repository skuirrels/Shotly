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

    // `canBond` decides what is a target, so it decides here too, and not
    // only in the hit test that offers one. A document can arrive from
    // anywhere — a hand-edited markup payload, a version that allowed
    // something this one does not — and an arrow tied to another arrow has no
    // edge to sit on and two ends that would chase each other.
    const bonded = (id: string | undefined) => {
      const target = id ? byId.get(id) : undefined;
      return target && canBond(target) ? target : undefined;
    };
    const from = bonded(a.fromId);
    const to = bonded(a.toId);
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
 * The four places a connector can be started from, on a shape being hovered.
 *
 * Edge midpoints of the upright bounds — the same box `attachPoint` measures
 * against, so the dot the hand presses is where the arrow actually leaves
 * from. An ellipse touches its box at exactly these four points, so one
 * formula serves both.
 *
 * They exist because the alternative does not work: pressing the *body* of a
 * shape has always meant "move it", for every tool, and a connector that
 * needs that press takes the move gesture away from the whole page for as
 * long as the arrow tool is in hand. A dot on the edge asks for neither.
 */
export function anchorsOf(shape: Annotation): Point[] {
  const b = spunBoundsOf(shape);
  const midX = b.x + b.width / 2;
  const midY = b.y + b.height / 2;
  return [
    { x: midX, y: b.y },
    { x: b.x + b.width, y: midY },
    { x: midX, y: b.y + b.height },
    { x: b.x, y: midY },
  ];
}

/**
 * How close an end has to come, in screen pixels, for a shape to catch it./**
 * How close an end has to come, in screen pixels, for a shape to catch it.
 *
 * There has to be some reach. The place the hand naturally stops is the *edge*
 * of the thing being pointed at — that is where the arrowhead belongs — and an
 * edge is a boundary, so "inside the bounds" turns a gesture aimed at exactly
 * the right place into a coin toss. Without this, connecting took several
 * goes; with it, one.
 *
 * Divided by the zoom at the call site, so the reach is a constant distance
 * under the pointer rather than a constant number of document pixels: at
 * "fit" on a large capture the latter would be a couple of pixels on screen.
 */
export const BOND_REACH = 14;

/** How far `at` lies outside `box`. Zero anywhere inside it. */
function distanceToBox(at: Point, box: Rect): number {
  const dx = Math.max(box.x - at.x, 0, at.x - (box.x + box.width));
  const dy = Math.max(box.y - at.y, 0, at.y - (box.y + box.height));
  return Math.hypot(dx, dy);
}

/**
 * What an end dropped here would tie itself to, if anything.
 *
 * Inside beats near: a point within a shape's bounds takes the topmost shape
 * holding it, which is the one under the pointer as far as the eye is
 * concerned. Only when the point is outside everything does `slack` come into
 * it, and then the nearest edge wins rather than the topmost — the question
 * being answered is "which shape was that aimed at", and at arm's length the
 * honest answer is the closest one.
 *
 * Locked shapes are still valid targets: locked means "not to be edited", and
 * being pointed at is not an edit.
 */
export function bondTargetAt(
  annotations: Annotation[],
  at: Point,
  exclude: string,
  slack = 0,
): Annotation | null {
  let nearest: Annotation | null = null;
  let best = Infinity;

  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    if (a.id === exclude || !canBond(a)) continue;
    const gap = distanceToBox(at, spunBoundsOf(a));
    if (gap === 0) return a;
    if (gap <= slack && gap < best) {
      best = gap;
      nearest = a;
    }
  }
  return nearest;
}

/**
 * What the end of a line being dragged would tie itself to.
 *
 * `bondTargetAt` plus the one rule on top of it: an arrow with both ends on
 * the same shape has no direction and two ends chasing one edge, so whatever
 * the other end is already holding is not on offer to this one.
 *
 * Both the end-handle drag and the draw-a-new-arrow drag ask this, rather than
 * each deciding for itself — they had drifted apart once already, which is how
 * a freshly drawn arrow came to bond to nothing at all.
 */
export function bondForEnd(
  annotations: Annotation[],
  at: Point,
  lineId: string,
  otherEnd: string | undefined,
  reach: number,
): string | null {
  const over = bondTargetAt(annotations, at, lineId, reach);
  return over && over.id !== otherEnd ? over.id : null;
}

/** Does this line have either end tied to something? */
export const isBonded = (a: Annotation): boolean =>
  isLine(a) && Boolean(a.fromId || a.toId);
