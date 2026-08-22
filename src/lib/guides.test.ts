/**
 * Pins the snapping arithmetic.
 *
 * The claims that matter: a snap never moves a shape further than its reach,
 * it prefers the nearest agreement rather than the first one it finds, and it
 * reports *every* line that holds at the position it chose — a shape that
 * silently lines up with two things and admits to one looks like it moved on
 * its own.
 */
import { expect, test } from "vitest";
import {
  NO_SNAP,
  shapeBoxesFor,
  sizeGuides,
  snapBox,
  snapPoint,
  snapSize,
  targetsFor,
  unionOf,
} from "./guides";
import type { Annotation } from "./types";

const page = { x: 0, y: 0, width: 1000, height: 800 };
const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

test("a box just outside the reach is left alone", () => {
  const target = { x: 100, y: 100, width: 50, height: 50 };
  const snap = snapBox({ x: 160, y: 300, width: 20, height: 20 }, [target], 6);
  expect(snap).toEqual(NO_SNAP);
});

test("a near-miss on an edge is pulled onto it", () => {
  const target = { x: 100, y: 100, width: 50, height: 50 };
  const snap = snapBox({ x: 104, y: 300, width: 4, height: 4 }, [target], 6);
  near(snap.dx, -4);
  near(snap.dy, 0);
  expect(snap.guides).toHaveLength(1);
  expect(snap.guides[0]).toMatchObject({ kind: "align", axis: "x", at: 100 });
});

test("the nearest agreement wins, not the first one offered", () => {
  // The moving box's left edge is 5 from one target and its right edge 1 from
  // another. Scanning in order would take the 5.
  const far = { x: 0, y: 0, width: 195, height: 10 };
  const close = { x: 241, y: 0, width: 100, height: 10 };
  const snap = snapBox({ x: 200, y: 300, width: 40, height: 40 }, [far, close], 6);
  near(snap.dx, 1);
});

test("a shape that lines up twice says so twice", () => {
  // Two targets share x = 100; the moving box's left edge is 3 away from both.
  const a = { x: 100, y: 40, width: 60, height: 20 };
  const b = { x: 100, y: 400, width: 60, height: 20 };
  const snap = snapBox({ x: 103, y: 200, width: 20, height: 20 }, [a, b], 6);
  near(snap.dx, -3);
  expect(snap.guides.filter((g) => g.kind === "align")).toHaveLength(2);
});

test("a guide reaches from the far side of one box to the far side of the other", () => {
  const target = { x: 100, y: 500, width: 50, height: 50 };
  const snap = snapBox({ x: 102, y: 100, width: 20, height: 20 }, [target], 6);
  const guide = snap.guides[0];
  expect(guide).toMatchObject({ from: 100, to: 550 });
});

test("both axes can catch at once", () => {
  const target = { x: 100, y: 100, width: 50, height: 50 };
  const snap = snapBox({ x: 97, y: 148, width: 20, height: 20 }, [target], 6);
  near(snap.dx, 3);
  near(snap.dy, 2);
  expect(snap.guides).toHaveLength(2);
});

test("the page is a target, so a shape centres on the capture", () => {
  const snap = snapBox({ x: 487, y: 300, width: 20, height: 20 }, [page], 6);
  near(snap.dx, 3);
  near(487 + snap.dx + 10, 500);
});

test("an even gap in a row pulls a third shape into step", () => {
  // Two boxes 40 apart. The third is dragged to a gap of 44 — inside reach.
  const a = { x: 0, y: 100, width: 20, height: 20 };
  const b = { x: 60, y: 100, width: 20, height: 20 };
  const snap = snapBox({ x: 124, y: 100, width: 20, height: 20 }, [a, b], 6);
  near(snap.dx, -4);
  const gaps = snap.guides.filter((g) => g.kind === "gap");
  expect(gaps).toHaveLength(2);
  expect(gaps.every((g) => g.kind === "gap" && Math.abs(g.size - 40) < 0.01)).toBe(true);
});

test("the page is not a neighbour to space evenly against", () => {
  // Without this the capture's own edges would offer gaps of their own, and a
  // shape dragged near the right-hand side would jump to match a margin.
  const a = { x: 0, y: 100, width: 20, height: 20 };
  const b = { x: 60, y: 100, width: 20, height: 20 };
  const snap = snapBox({ x: 124, y: 100, width: 20, height: 20 }, [page, a, b], 6);
  near(snap.dx, -4);
  expect(snap.guides.filter((g) => g.kind === "gap")).toHaveLength(2);
});

test("a gap only matches shapes that are actually in the same row", () => {
  const a = { x: 0, y: 100, width: 20, height: 20 };
  // Nowhere near the moving box vertically, so this is not a row.
  const b = { x: 60, y: 600, width: 20, height: 20 };
  const snap = snapBox({ x: 124, y: 100, width: 20, height: 20 }, [a, b], 6);
  expect(snap.guides.filter((g) => g.kind === "gap")).toHaveLength(0);
});

test("alignment beats spacing on the same axis", () => {
  // A row that would pull the box left, and an edge it is already almost on.
  const a = { x: 0, y: 100, width: 20, height: 20 };
  const b = { x: 60, y: 100, width: 20, height: 20 };
  const snap = snapBox({ x: 122, y: 100, width: 20, height: 20 }, [a, b], 6);
  // 122 is 2 from nothing alignable, so spacing takes it; confirm the reverse
  // by putting an edge within reach.
  const edge = { x: 110, y: 400, width: 10, height: 5 };
  const both = snapBox({ x: 122, y: 100, width: 20, height: 20 }, [a, b, edge], 6);
  expect(snap.guides.some((g) => g.kind === "gap")).toBe(true);
  expect(both.guides.every((g) => g.kind === "align")).toBe(true);
  near(both.dx, -2);
});

test("a dragged corner snaps as a point, so the anchored one cannot move", () => {
  const target = { x: 100, y: 100, width: 50, height: 50 };
  const snap = snapPoint({ x: 152, y: 300 }, [target], 6);
  near(snap.dx, -2);
});

test("the union of a selection is the box that gets snapped", () => {
  const u = unionOf([
    { x: 10, y: 10, width: 10, height: 10 },
    { x: 100, y: 50, width: 10, height: 10 },
  ]);
  expect(u).toEqual({ x: 10, y: 10, width: 100, height: 50 });
});

test("the shapes being dragged are not targets for themselves", () => {
  const style = { color: "#f00" } as Annotation["style"];
  const shapes: Annotation[] = [
    { id: "a", kind: "rect", x: 0, y: 0, width: 10, height: 10, style },
    { id: "b", kind: "rect", x: 50, y: 0, width: 10, height: 10, style },
  ];
  const targets = targetsFor(shapes, new Set(["a"]), { width: 100, height: 100 });
  // The page, plus b. Not a.
  expect(targets).toHaveLength(2);
  expect(targets[1].x).toBe(50);
});

test("a spotlight is not something you line a shape up with", () => {
  const style = { color: "#f00" } as Annotation["style"];
  const shapes: Annotation[] = [
    { id: "s", kind: "spotlight", x: 30, y: 30, width: 10, height: 10, style },
  ];
  const targets = targetsFor(shapes, new Set(), { width: 100, height: 100 });
  expect(targets).toHaveLength(1);
});

// --------------------------------------------------------------- same size

/** A box, written the way the resize arithmetic hands them over. */
const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

test("a corner dragged near a width something else already is lands on it", () => {
  // The box being sized is pinned at (0,0) and the pointer is at 98 across —
  // two short of the 100 the other rectangle is.
  const targets = [box(200, 0, 100, 40)];
  const snap = snapSize({ x: 98, y: 60 }, { x: 0, y: 0 }, targets, 6, {
    width: true,
    height: true,
  });
  expect(snap.dx).toBeCloseTo(2, 6);
  expect(snap.sizes).toEqual([{ axis: "x", size: 100 }]);
  // Nothing is 60 tall, so the height is left exactly where the hand put it.
  expect(snap.dy).toBe(0);
});

test("the pull is finite, and measured from the anchor rather than the origin", () => {
  const targets = [box(0, 0, 100, 40)];
  // Ten short is out of reach.
  expect(snapSize({ x: 90, y: 0 }, { x: 0, y: 0 }, targets, 6, { width: true, height: true }).dx).toBe(0);
  // The same width asked for from a different anchor is a different pointer
  // position, and still found.
  const from = snapSize({ x: 598, y: 0 }, { x: 500, y: 0 }, targets, 6, { width: true, height: true });
  expect(from.dx).toBeCloseTo(2, 6);
});

test("sizing back past the anchor looks for the same width the other way", () => {
  const targets = [box(0, 0, 100, 40)];
  // Dragging the left edge leftwards past the anchor: the box is 98 wide and
  // wants to be 100, so the pointer goes further left, not right.
  const snap = snapSize({ x: -98, y: 0 }, { x: 0, y: 0 }, targets, 6, {
    width: true,
    height: true,
  });
  expect(snap.dx).toBeCloseTo(-2, 6);
});

test("a handle that cannot change a dimension is never offered one", () => {
  // A north or south handle holds the width. Offering it a matching width
  // would jump the pointer sideways along an axis the drag does not own.
  const targets = [box(0, 0, 100, 40)];
  const snap = snapSize({ x: 98, y: 38 }, { x: 0, y: 0 }, targets, 6, {
    width: false,
    height: true,
  });
  expect(snap.dx).toBe(0);
  expect(snap.dy).toBeCloseTo(2, 6);
  expect(snap.sizes).toEqual([{ axis: "y", size: 40 }]);
});

test("a line has no width, and nothing snaps to nothing", () => {
  // Without a floor, every horizontal line on the page would offer to snap
  // the shape being sized to a width of zero.
  const targets = [box(0, 0, 0, 40), box(0, 0, 1, 40)];
  expect(snapSize({ x: 2, y: 0 }, { x: 0, y: 0 }, targets, 6, { width: true, height: true }).dx).toBe(0);
});

test("every shape that shares the size gets a bar, and the sized one too", () => {
  const targets = [box(0, 0, 100, 40), box(0, 200, 100, 90), box(0, 400, 55, 40)];
  const sized = box(300, 300, 100, 40);
  const bars = sizeGuides(sized, targets, [{ axis: "x", size: 100 }]);

  // The shape just sized, and the two that are also 100 wide. Not the 55.
  expect(bars).toHaveLength(3);
  expect(bars.every((b) => b.kind === "size" && b.axis === "x" && b.size === 100)).toBe(true);
  // Each bar spans its own shape and hangs off its bottom edge.
  expect(bars[0]).toMatchObject({ from: 300, to: 400, at: 340 });
  expect(bars[1]).toMatchObject({ from: 0, to: 100, at: 40 });
  expect(bars[2]).toMatchObject({ from: 0, to: 100, at: 290 });
});

test("a size with nothing to compare it against draws nothing", () => {
  expect(sizeGuides(box(0, 0, 100, 40), [box(0, 0, 55, 40)], [{ axis: "x", size: 100 }])).toEqual([]);
});

test("sizes are measured against the shapes, not against the page", () => {
  // `targetsFor` puts the page first so a shape can be centred on the capture.
  // A rectangle that happens to be exactly as wide as the screenshot is a
  // coincidence, and a bar drawn the width of the document says nothing.
  const style = { color: "#f00" } as Annotation["style"];
  const shapes: Annotation[] = [
    { id: "a", kind: "rect", x: 0, y: 0, width: 10, height: 10, style },
  ];
  expect(targetsFor(shapes, new Set(), { width: 100, height: 100 })).toHaveLength(2);
  expect(shapeBoxesFor(shapes, new Set())).toHaveLength(1);
  expect(shapeBoxesFor(shapes, new Set(["a"]))).toHaveLength(0);
});
