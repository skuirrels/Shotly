/**
 * Pins the rotation geometry.
 *
 * Two claims matter more than the rest, because everything visible rests on
 * them: a spun shape keeps the centre it is stored with, and a resize of a
 * spun shape leaves the corner under the pointer exactly where the pointer is.
 * Both are easy to break with a sign, and neither is obvious from looking at
 * the screen until a shape swims away from the hand dragging it.
 */
import { expect, test } from "vitest";
import {
  angleFrom,
  centreOf,
  handleAnchor,
  handlePoint,
  normalizeAngle,
  resizeCursor,
  resizedBox,
  respunBox,
  rotatePoint,
  snapTurn,
  spunBounds,
  unspun,
  unspunBox,
} from "./shapes";

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);
const box = { x: 100, y: 50, width: 200, height: 100 };

test("a quarter turn clockwise sends right to down", () => {
  const p = rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 90);
  near(p.x, 0);
  near(p.y, 10);
});

test("turning about a point leaves that point alone", () => {
  const p = rotatePoint({ x: 7, y: 7 }, { x: 7, y: 7 }, 37);
  near(p.x, 7);
  near(p.y, 7);
});

test("a spun box still covers its own centre", () => {
  const spun = spunBounds(box, 30);
  near(centreOf(spun).x, centreOf(box).x);
  near(centreOf(spun).y, centreOf(box).y);
});

test("a box on its side covers what it did, the other way round", () => {
  const spun = spunBounds(box, 90);
  near(spun.width, box.height);
  near(spun.height, box.width);
});

test("a box turned off-axis covers more than it did", () => {
  const spun = spunBounds(box, 45);
  expect(spun.width).toBeGreaterThan(box.width);
  expect(spun.height).toBeGreaterThan(box.height);
});

test("angles fold into half a turn either way", () => {
  expect(normalizeAngle(0)).toBe(0);
  expect(normalizeAngle(180)).toBe(180);
  expect(normalizeAngle(181)).toBe(-179);
  expect(normalizeAngle(-181)).toBe(179);
  expect(normalizeAngle(720 + 45)).toBe(45);
});

test("straight up reads as zero, and clockwise counts up", () => {
  const c = { x: 0, y: 0 };
  near(angleFrom(c, { x: 0, y: -10 }), 0);
  near(angleFrom(c, { x: 10, y: 0 }), 90);
  near(angleFrom(c, { x: 0, y: 10 }), 180);
});

test("unspinning a box and respinning it gives the box back", () => {
  const there = unspunBox(box, 41);
  const back = respunBox(there, 41);
  near(back.x, box.x);
  near(back.y, box.y);
  near(back.width, box.width);
  near(back.height, box.height);
});

test("a side handle resizes one axis and leaves the other alone", () => {
  const grown = resizedBox(box, "s", handleAnchor(box, "s"), { x: 999, y: 400 });
  near(grown.x, box.x);
  near(grown.width, box.width);
  near(grown.y, box.y);
  near(grown.height, 350);
});

test("a corner handle resizes both", () => {
  const grown = resizedBox(box, "se", handleAnchor(box, "se"), { x: 400, y: 400 });
  near(grown.x, box.x);
  near(grown.y, box.y);
  near(grown.width, 300);
  near(grown.height, 350);
});

/**
 * The whole point of `unspun`: the shape spins about its own centre, and a
 * resize moves that centre. Without the correction the corner being held slides
 * out from under the pointer, more the further round the shape is turned.
 */
test("resizing a spun shape holds the corner under the pointer", () => {
  const deg = 33;
  // Where the pointer is, in the world; and the same drag, seen unspun.
  const to = { x: 420, y: 380 };
  const local = unspunBox(box, deg);
  const anchor = handleAnchor(local, "se");
  const after = respunBox(resizedBox(local, "se", anchor, unspun(to, deg)), deg);

  // The dragged corner, once the new box is spun about its new centre, is
  // under the pointer.
  const corner = rotatePoint(
    { x: after.x + after.width, y: after.y + after.height },
    centreOf(after),
    deg,
  );
  near(corner.x, to.x);
  near(corner.y, to.y);
});

test("the corner opposite the drag does not move either", () => {
  const deg = 33;
  const before = rotatePoint({ x: box.x, y: box.y }, centreOf(box), deg);

  const local = unspunBox(box, deg);
  const after = respunBox(
    resizedBox(local, "se", handleAnchor(local, "se"), unspun({ x: 420, y: 380 }, deg)),
    deg,
  );
  const anchor = rotatePoint({ x: after.x, y: after.y }, centreOf(after), deg);

  near(anchor.x, before.x);
  near(anchor.y, before.y);
});

/**
 * Shift lands the shape on a right angle, not on a multiple of fifteen from
 * wherever it already was — which is the difference between "hold Shift to
 * straighten this" working and not.
 */
test("shift snaps to where the shape ends up, not to how far it moved", () => {
  // Sitting at 7°, turned by 40: 47 rounds to 45, so the turn is 38.
  expect(snapTurn(7, 40)).toBe(38);
  expect(7 + snapTurn(7, 40)).toBe(45);
  // And a small nudge from an odd angle finds upright.
  expect(2 + snapTurn(2, -4)).toBe(0);
});

test("handles sit on the corners and the middles of the sides", () => {
  expect(handlePoint(box, "nw")).toEqual({ x: 100, y: 50 });
  expect(handlePoint(box, "n")).toEqual({ x: 200, y: 50 });
  expect(handlePoint(box, "e")).toEqual({ x: 300, y: 100 });
  expect(handlePoint(box, "sw")).toEqual({ x: 100, y: 150 });
});

test("the cursor turns with the shape", () => {
  expect(resizeCursor("n", 0)).toBe("ns-resize");
  expect(resizeCursor("n", 90)).toBe("ew-resize");
  expect(resizeCursor("se", 0)).toBe("nwse-resize");
  expect(resizeCursor("se", 90)).toBe("nesw-resize");
  // Rounded to the nearest one macOS has, rather than left wrong.
  expect(resizeCursor("n", 10)).toBe("ns-resize");
  expect(resizeCursor("n", 40)).toBe("nesw-resize");
});
