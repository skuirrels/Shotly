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
import { NO_SNAP, snapBox, snapPoint, targetsFor, unionOf } from "./guides";
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
