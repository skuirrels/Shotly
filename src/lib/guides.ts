import type { Box } from "./shapes";
import { spunBoundsOf } from "./shapes";
import type { Annotation, Point } from "./types";

/**
 * Where a shape being dragged wants to line up, and the lines that say so.
 *
 * Placing three step numbers down a sidebar by hand means three separate
 * attempts at the same x, and the eye can't tell one pixel from three at the
 * zoom a screenshot is edited at. So the shape is given a small pull towards
 * the coordinates that already mean something in the document — the edges and
 * centres of the other annotations, and of the page — and a line is drawn to
 * show which one it caught.
 *
 * Everything here is pure arithmetic on axis-aligned boxes, deliberately: the
 * caller decides what a "box" is (the union of a selection, one shape's spun
 * bounds, a corner being dragged out), and this decides where it should land.
 * That keeps the whole feature testable without a pointer, and it is why the
 * rotation case is handled by passing in `spunBounds` rather than by teaching
 * this file about angles. A turned shape snaps by the box it visibly occupies,
 * which is the only rectangle a guide line could honestly be drawn against.
 */

/**
 * How close, in *screen* pixels, a shape has to come before it snaps.
 *
 * Screen rather than document pixels because it is a property of the hand, not
 * of the picture: the same 6px feels identical whether the capture is zoomed to
 * a third or to double. Callers divide by the zoom on the way in.
 *
 * Six is small on purpose. A generous threshold makes a shape feel magnetic
 * and makes *deliberate* near-misses impossible, and a screenshot is full of
 * things you want a hair off centre.
 */
export const SNAP_REACH = 6;

/** A line drawn where something lined up, in document coordinates. */
export interface AlignGuide {
  kind: "align";
  axis: "x" | "y";
  /** The coordinate everything agreed on. */
  at: number;
  /** The extent to draw over, along the *other* axis. */
  from: number;
  to: number;
}

/**
 * A matched gap, drawn as a bar with its size on it.
 *
 * Two of these always appear together — the point is that this gap equals that
 * one — so they carry the measurement rather than a coordinate.
 */
export interface GapGuide {
  kind: "gap";
  axis: "x" | "y";
  /** Start and end of the gap along `axis`. */
  from: number;
  to: number;
  /** Where to draw the bar on the other axis. */
  at: number;
  size: number;
}

export type Guide = AlignGuide | GapGuide;

/** What a snap decided: how far to move, and what to draw about it. */
export interface Snap {
  dx: number;
  dy: number;
  guides: Guide[];
}

export const NO_SNAP: Snap = { dx: 0, dy: 0, guides: [] };

const right = (b: Box) => b.x + b.width;
const bottom = (b: Box) => b.y + b.height;

/** The three coordinates of a box worth lining up against, on one axis. */
function marks(b: Box, axis: "x" | "y"): number[] {
  return axis === "x"
    ? [b.x, b.x + b.width / 2, right(b)]
    : [b.y, b.y + b.height / 2, bottom(b)];
}

/** Low and high edge of a box on the axis *across* from the one in question. */
function span(b: Box, axis: "x" | "y"): [number, number] {
  return axis === "x" ? [b.y, bottom(b)] : [b.x, right(b)];
}

/** Do two boxes overlap on the axis across from `axis`, at all? */
function overlaps(a: Box, b: Box, axis: "x" | "y"): boolean {
  const [a0, a1] = span(a, axis);
  const [b0, b1] = span(b, axis);
  return a0 < b1 && b0 < a1;
}

/**
 * The boxes a moving shape is measured against.
 *
 * The page counts as one of them. Centring a callout on the capture is at
 * least as common as lining it up with another annotation, and expressing the
 * page as a box means the same three marks per axis cover both.
 */
export function targetsFor(
  annotations: Annotation[],
  moving: Set<string>,
  page: { width: number; height: number },
): Box[] {
  const boxes: Box[] = [{ x: 0, y: 0, width: page.width, height: page.height }];
  for (const a of annotations) {
    if (moving.has(a.id)) continue;
    // A spotlight is the whole page with a hole in it and a blur is a patch of
    // the picture; neither is a shape anyone positions *relative to*, and both
    // would litter the document with lines nothing was aimed at.
    if (a.kind === "spotlight") continue;
    boxes.push(spunBoundsOf(a));
  }
  return boxes;
}

/** Union of several boxes, or null when there are none. */
export function unionOf(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, right(b));
    y1 = Math.max(y1, bottom(b));
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * The nearest coordinate `box` could shift to on one axis, and why.
 *
 * Two passes on purpose. The first finds the smallest correction any of the
 * three marks can make; the second re-asks every mark *at the corrected
 * position* and keeps all of them that now agree. Without the second pass a
 * shape whose left edge and centre both land on something would be drawn with
 * one line and look arbitrary — and the second line is exactly the information
 * that makes the first one trustworthy.
 */
function alignOn(box: Box, targets: Box[], axis: "x" | "y", reach: number): {
  delta: number;
  guides: AlignGuide[];
} {
  const mine = marks(box, axis);
  let delta = 0;
  let best = reach;

  for (const t of targets) {
    for (const at of marks(t, axis)) {
      for (const m of mine) {
        const d = at - m;
        if (Math.abs(d) < best) {
          best = Math.abs(d);
          delta = d;
        }
      }
    }
  }
  if (best >= reach) return { delta: 0, guides: [] };

  // Where the box ends up, so the guides can be drawn to reach it.
  const moved: Box = axis === "x" ? { ...box, x: box.x + delta } : { ...box, y: box.y + delta };
  const settled = marks(moved, axis);
  const guides: AlignGuide[] = [];

  for (const t of targets) {
    for (const at of marks(t, axis)) {
      if (!settled.some((m) => Math.abs(m - at) < 0.01)) continue;
      const [m0, m1] = span(moved, axis);
      const [t0, t1] = span(t, axis);
      // Drawn from the far side of one to the far side of the other, which is
      // what makes the line read as "these two agree" rather than as a ruler.
      const guide: AlignGuide = {
        kind: "align",
        axis,
        at,
        from: Math.min(m0, t0),
        to: Math.max(m1, t1),
      };
      if (!guides.some((g) => Math.abs(g.at - at) < 0.01 && g.from === guide.from && g.to === guide.to)) {
        guides.push(guide);
      }
    }
  }

  return { delta, guides };
}

/**
 * Snap so the gap to a neighbour matches a gap that is already there.
 *
 * The case worth having: two shapes already sit an even distance apart, and a
 * third is being dragged into the row. Only boxes that overlap the moving one
 * across the axis are considered, because "evenly spaced" means nothing
 * between two shapes on opposite sides of the page.
 *
 * Runs only when the alignment pass found nothing on this axis. Both pulling
 * at once would mean a shape that snaps to an edge *and* shifts to even a gap,
 * landing somewhere it was never dragged.
 */
function gapOn(box: Box, targets: Box[], axis: "x" | "y", reach: number): {
  delta: number;
  guides: GapGuide[];
} {
  const low = (b: Box) => (axis === "x" ? b.x : b.y);
  const high = (b: Box) => (axis === "x" ? right(b) : bottom(b));

  const row = targets
    .filter((t) => overlaps(box, t, axis))
    // Something the moving box sits *inside* is a container, not a neighbour:
    // the page is one, and so is a highlight drawn over half the capture. The
    // distance to its far edge is a margin, and matching one margin against
    // another says nothing about how evenly anything is spaced.
    .filter((t) => !(low(t) <= low(box) && high(t) >= high(box)))
    .sort((a, b) => low(a) - low(b));
  if (row.length < 2) return { delta: 0, guides: [] };

  // Every gap that already exists between two neighbours in the row. These are
  // the only sizes worth matching: a number nothing else in the picture uses
  // would be a coincidence dressed up as a decision.
  const known: number[] = [];
  for (let i = 1; i < row.length; i++) {
    const gap = low(row[i]) - high(row[i - 1]);
    if (gap > 0.5) known.push(gap);
  }
  if (known.length === 0) return { delta: 0, guides: [] };

  const size = axis === "x" ? box.width : box.height;
  let delta = 0;
  let best = reach;
  let landed: { before: Box; gap: number } | null = null;

  for (const t of row) {
    for (const gap of known) {
      // After `t`, and before it.
      for (const want of [high(t) + gap, low(t) - gap - size]) {
        const d = want - low(box);
        if (Math.abs(d) < best) {
          best = Math.abs(d);
          delta = d;
          landed = { before: t, gap };
        }
      }
    }
  }
  if (!landed || best >= reach) return { delta: 0, guides: [] };

  const moved: Box = axis === "x" ? { ...box, x: box.x + delta } : { ...box, y: box.y + delta };
  const placed = [...row, moved].sort((a, b) => low(a) - low(b));
  const guides: GapGuide[] = [];

  // Draw every gap in the finished row that came out the matched size — the
  // two (or more) equal spans are the whole message.
  for (let i = 1; i < placed.length; i++) {
    const gap = low(placed[i]) - high(placed[i - 1]);
    if (Math.abs(gap - landed.gap) > 0.01) continue;
    const [a0, a1] = span(placed[i - 1], axis);
    const [b0, b1] = span(placed[i], axis);
    guides.push({
      kind: "gap",
      axis,
      from: high(placed[i - 1]),
      to: low(placed[i]),
      // Along the middle of where the two boxes overlap, so the bar sits
      // between them rather than off the end of one.
      at: (Math.max(a0, b0) + Math.min(a1, b1)) / 2,
      size: gap,
    });
  }

  return { delta, guides: guides.length > 1 ? guides : [] };
}

/**
 * Where a box being dragged should actually land.
 *
 * `reach` is in document pixels — the caller divides [`SNAP_REACH`] by the
 * zoom, so the pull feels the same at every magnification.
 */
export function snapBox(box: Box, targets: Box[], reach: number): Snap {
  const x = alignOn(box, targets, "x", reach);
  const y = alignOn(box, targets, "y", reach);

  const gx = x.guides.length === 0 ? gapOn(box, targets, "x", reach) : null;
  const gy = y.guides.length === 0 ? gapOn(box, targets, "y", reach) : null;

  return {
    dx: x.delta || gx?.delta || 0,
    dy: y.delta || gy?.delta || 0,
    guides: [...x.guides, ...y.guides, ...(gx?.guides ?? []), ...(gy?.guides ?? [])],
  };
}

/**
 * Snap one moving corner — what a resize or a fresh drag-out has instead of a
 * box.
 *
 * Only the edges the hand is actually moving may snap. Snapping the whole box
 * during a resize would drag the *anchored* corner off the spot it is pinned
 * to, which is the one thing a resize promises not to do. So the guides here
 * are asked of a degenerate box: the point itself.
 */
export function snapPoint(p: Point, targets: Box[], reach: number): Snap {
  return snapBox({ x: p.x, y: p.y, width: 0, height: 0 }, targets, reach);
}
