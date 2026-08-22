/**
 * Pins the two claims a connector makes: a tied end sits on the edge of the
 * shape it is tied to, facing the other end, and it stays there when that
 * shape moves. Everything else in the editor treats a connector as an ordinary
 * line, so if these numbers are wrong nothing else will notice — the arrow
 * will just quietly point at the wrong place.
 */
import { expect, test } from "vitest";
import {
  BOND_GAP,
  BOND_REACH,
  anchorsOf,
  attachPoint,
  bondForEnd,
  bondTargetAt,
  isBonded,
  rerouted,
} from "./connect";
import type { Annotation, LineAnnotation, Style } from "./types";

const style: Style = {
  color: "#FF3B30",
  strokeWidth: 10,
  fontSize: 48,
  fillOpacity: 0,
  cornerRadius: 0,
  blurRadius: 12,
  dim: 0.55,
  shadow: false,
  neon: false,
  measureUnits: "px",
};

/** The gap an arrow of the default weight leaves: 7 + 10 × 0.6. */
const GAP = BOND_GAP + 6;

const rect = (id: string, x: number, y: number, width = 100, height = 100): Annotation => ({
  id,
  kind: "rect",
  x,
  y,
  width,
  height,
  style,
});

const arrow = (patch: Partial<LineAnnotation> = {}): LineAnnotation => ({
  id: "line",
  kind: "arrow",
  x1: 0,
  y1: 0,
  x2: 500,
  y2: 0,
  style,
  ...patch,
});

test("an end tied to a box leaves from the side facing the other end", () => {
  // The box spans 200–300 across, centred on 250; the other end is off to the
  // right, so the arrow should start on the right-hand edge plus the gap.
  const doc = [rect("box", 200, 200, 100, 100), arrow({ fromId: "box", x2: 900, y2: 250 })];
  const [, line] = rerouted(doc) as [Annotation, LineAnnotation];
  expect(line.x1).toBeCloseTo(300 + GAP, 6);
  expect(line.y1).toBeCloseTo(250, 6);
});

test("moving the shape moves the end that is tied to it", () => {
  const doc = [rect("box", 200, 200), arrow({ fromId: "box", x2: 900, y2: 250 })];
  const moved = doc.map((a) => (a.id === "box" ? { ...a, x: 500, y: 200 } : a));
  const [, line] = rerouted(moved) as [Annotation, LineAnnotation];
  expect(line.x1).toBeCloseTo(600 + GAP, 6);
});

test("both ends tied leaves each on its own edge", () => {
  const doc = [
    rect("a", 0, 0, 100, 100),
    rect("b", 400, 0, 100, 100),
    arrow({ fromId: "a", toId: "b" }),
  ];
  const line = rerouted(doc)[2] as LineAnnotation;
  expect(line.x1).toBeCloseTo(100 + GAP, 6);
  expect(line.x2).toBeCloseTo(400 - GAP, 6);
  expect(line.y1).toBeCloseTo(50, 6);
  expect(line.y2).toBeCloseTo(50, 6);
});

test("an ellipse is met on its curve, not on the corner of its box", () => {
  const box = { id: "e", kind: "ellipse", x: 0, y: 0, width: 200, height: 200, style } as Annotation;
  // Out along the diagonal: a box would answer at the corner, 100√2 from the
  // centre; a circle answers at its radius, 100.
  const at = attachPoint(box, { x: 1100, y: 1100 }, 0);
  expect(Math.hypot(at.x - 100, at.y - 100)).toBeCloseTo(100, 6);
});

test("a bond to a shape that has been deleted is forgotten, not followed", () => {
  const line = arrow({ fromId: "gone", x1: 11, y1: 22 });
  const [out] = rerouted([line]) as [LineAnnotation];
  expect(out.fromId).toBeUndefined();
  // The coordinates are the line's own and survive the bond going away.
  expect(out.x1).toBe(11);
  expect(out.y1).toBe(22);
});

test("nothing tied means nothing touched, array and all", () => {
  const doc = [rect("box", 0, 0), arrow()];
  expect(rerouted(doc)).toBe(doc);
});

test("an untied end stays exactly where it was put", () => {
  const doc = [rect("box", 200, 200), arrow({ fromId: "box", x2: 913, y2: 407 })];
  const line = rerouted(doc)[1] as LineAnnotation;
  expect(line.x2).toBe(913);
  expect(line.y2).toBe(407);
});

test("dropping an end picks the shape on top", () => {
  const doc = [rect("under", 0, 0, 400, 400), rect("over", 100, 100, 100, 100)];
  expect(bondTargetAt(doc, { x: 150, y: 150 }, "line")?.id).toBe("over");
  expect(bondTargetAt(doc, { x: 350, y: 350 }, "line")?.id).toBe("under");
  expect(bondTargetAt(doc, { x: 900, y: 900 }, "line")).toBeNull();
});

test("an end that stops on the edge still lands, which is where the hand stops", () => {
  // The whole bug this reach exists for: 200 is the box's own right edge, and
  // "inside the bounds" made an aim at exactly the right place a coin toss.
  const doc = [rect("box", 100, 100, 100, 100)];
  expect(bondTargetAt(doc, { x: 200, y: 150 }, "line")?.id).toBe("box");
  expect(bondTargetAt(doc, { x: 208, y: 150 }, "line", BOND_REACH)).toBe(doc[0]);
  // Reach is a distance, not a bounding box: the same 8px out along both axes
  // is 11 away from the corner, which is still within it.
  expect(bondTargetAt(doc, { x: 208, y: 208 }, "line", BOND_REACH)?.id).toBe("box");
  // And it is finite.
  expect(bondTargetAt(doc, { x: 260, y: 150 }, "line", BOND_REACH)).toBeNull();
  // Asked without reach, only the shape itself answers.
  expect(bondTargetAt(doc, { x: 208, y: 150 }, "line")).toBeNull();
});

test("inside beats near, and near means nearest", () => {
  const doc = [rect("under", 0, 0, 400, 400), rect("over", 100, 100, 100, 100)];
  // Inside both: the topmost wins, reach or no reach.
  expect(bondTargetAt(doc, { x: 150, y: 150 }, "line", BOND_REACH)?.id).toBe("over");
  // Outside everything, between two candidates: the closer edge wins even
  // though the other is on top — at arm's length "which was that aimed at?"
  // is a question about distance, not z-order.
  const pair = [rect("far", 0, 0, 10, 10), rect("near", 100, 0, 10, 10)];
  expect(bondTargetAt(pair, { x: 116, y: 5 }, "line", 20)?.id).toBe("near");
});

test("an arrow is never a target, including itself", () => {
  const doc = [arrow({ id: "other", x1: 0, y1: 0, x2: 400, y2: 400 })];
  expect(bondTargetAt(doc, { x: 200, y: 200 }, "line")).toBeNull();
});

test("a shape offers four anchors, on the edges an arrow would leave from", () => {
  const [top, right, bottom, left] = anchorsOf(rect("box", 100, 200, 60, 40));
  expect(top).toEqual({ x: 130, y: 200 });
  expect(right).toEqual({ x: 160, y: 220 });
  expect(bottom).toEqual({ x: 130, y: 240 });
  expect(left).toEqual({ x: 100, y: 220 });
});

test("an anchor is a place the arrow actually leaves from", () => {
  // The dot the hand presses and the point `attachPoint` answers with are the
  // same place, or the arrow would jump on the first frame of the drag.
  const box = rect("box", 0, 0, 100, 100);
  const [, right] = anchorsOf(box);
  const met = attachPoint(box, { x: 900, y: 50 }, 0);
  expect(met).toEqual(right);
});

test("an end will not tie to whatever the other end is already holding", () => {
  // Both ends on one shape is an arrow with no direction and two ends chasing
  // the same edge. Asked of both drags — drawing one and dragging its end —
  // through this one rule, because they had already drifted apart once.
  const doc = [rect("a", 0, 0, 100, 100), rect("b", 400, 0, 100, 100)];
  expect(bondForEnd(doc, { x: 50, y: 50 }, "line", "a", BOND_REACH)).toBeNull();
  expect(bondForEnd(doc, { x: 450, y: 50 }, "line", "a", BOND_REACH)).toBe("b");
  // Nothing under it is nothing tied, whatever the other end is doing.
  expect(bondForEnd(doc, { x: 900, y: 900 }, "line", undefined, BOND_REACH)).toBeNull();
});

test("isBonded is about the ends, not the kind", () => {
  expect(isBonded(arrow())).toBe(false);
  expect(isBonded(arrow({ toId: "box" }))).toBe(true);
  expect(isBonded(rect("box", 0, 0))).toBe(false);
});
