/**
 * The document rules the canvas leans on.
 *
 * The canvas itself is a two-thousand-line component full of pointer events
 * and cannot be driven from here — but almost nothing it does to a document
 * happens in it. Every gesture ends in one of these actions, so this is where
 * the rules can be held still: what a bond survives, what a delete takes with
 * it, what a copy points at, what a group does when one of its members is
 * clicked.
 *
 * Written after two regressions in a row in exactly this area, both of which
 * looked local and were not.
 */
import { beforeEach, expect, test } from "vitest";
import { useEditor } from "./editorStore";
import { BOND_GAP, rerouted } from "@/lib/connect";
import type { Annotation, LineAnnotation, Style } from "@/lib/types";

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

/** The gap an arrow of this weight leaves: 7 + 10 × 0.6. */
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

/**
 * Two boxes 400 apart with an arrow tied between them, and nothing selected.
 *
 * Seeded *through* `rerouted`, because that is the only state a document is
 * ever in: every action that writes annotations runs it, so an arrow whose
 * coordinates disagree with its bonds cannot exist for longer than one call.
 * Seeding raw made the first test of every gesture measure the reroute rather
 * than the gesture.
 */
function joined() {
  useEditor.setState({
    annotations: rerouted([rect("a", 0, 0), rect("b", 400, 0), arrow({ fromId: "a", toId: "b" })]),
    selectedIds: [],
    past: [],
    future: [],
  });
}

const line = () => useEditor.getState().annotations.find((a) => a.id === "line") as LineAnnotation;
const shape = (id: string) => useEditor.getState().annotations.find((a) => a.id === id)!;

beforeEach(() => {
  useEditor.setState({ annotations: [], selectedIds: [], past: [], future: [], doc: null });
});

// ------------------------------------------------------------------- bonds

test("an arrow tied to a shape follows it, whichever action moved it", () => {
  // Every gesture that moves a shape goes through one of these three, and each
  // has to reroute: a drag ends in `replaceAll`, the arrow keys in `nudge`,
  // and the alignment commands in `align`. One that forgot would leave the
  // arrow pointing at where the shape used to be.
  joined();
  useEditor.setState({ selectedIds: ["b"] });
  useEditor.getState().nudge(400, 0);
  expect(line().x2).toBeCloseTo(800 - GAP, 6);
  expect(line().y2).toBeCloseTo(50, 6);

  joined();
  useEditor
    .getState()
    .replaceAll(useEditor.getState().annotations.map((a) => (a.id === "b" ? { ...a, x: 900 } : a)));
  expect(line().x2).toBeCloseTo(900 - GAP, 6);

  joined();
  useEditor.setState({ selectedIds: ["a", "b"] });
  useEditor.getState().align("top");
  expect(line().y1).toBeCloseTo(50, 6);
});

test("an arrow added already tied lands on the edge, not where it was drawn", () => {
  // Arrows drawn from a shape's anchor arrive with a bond and coordinates that
  // are only a guess. `add` used to be the one mutation that skipped
  // rerouting, so this held until the first update happened to fix it.
  useEditor.setState({ annotations: [rect("a", 0, 0)] });
  useEditor.getState().add(arrow({ fromId: "a", x1: 40, y1: 40, x2: 900, y2: 50 }));
  expect(line().x1).toBeCloseTo(100 + GAP, 6);
  expect(line().y1).toBeCloseTo(50, 6);
});

test("deleting a shape unties the arrow and leaves it where it was", () => {
  joined();
  const before = { x2: line().x2, y2: line().y2 };
  useEditor.getState().remove(["b"]);

  expect(line().toId).toBeUndefined();
  expect(line().fromId).toBe("a");
  // The coordinates were always the line's own; losing the bond must not move
  // it, or a delete would jump every arrow that pointed at the thing deleted.
  expect(line().x2).toBe(before.x2);
  expect(line().y2).toBe(before.y2);
});

test("undo brings back the shape and the bond with it", () => {
  joined();
  useEditor.getState().snapshot();
  useEditor.getState().remove(["b"]);
  expect(line().toId).toBeUndefined();

  useEditor.getState().undo();
  expect(shape("b")).toBeDefined();
  expect(line().toId).toBe("b");
  expect(line().x2).toBeCloseTo(400 - GAP, 6);
});

test("a copied arrow points at the copied shapes, not the originals", () => {
  joined();
  useEditor.setState({ selectedIds: ["a", "b", "line"] });
  useEditor.getState().duplicateSelection();

  const copies = useEditor.getState().selectedIds;
  const copiedLine = useEditor
    .getState()
    .annotations.find((a) => copies.includes(a.id) && a.kind === "arrow") as LineAnnotation;

  expect(copiedLine.fromId).not.toBe("a");
  expect(copiedLine.toId).not.toBe("b");
  expect(copies).toContain(copiedLine.fromId);
  expect(copies).toContain(copiedLine.toId);
  // And the originals are untouched by any of it.
  expect(line().fromId).toBe("a");
  expect(line().toId).toBe("b");
});

test("an arrow cannot be tied to another arrow, however it got that way", () => {
  // `canBond` says so where a bond is offered; `rerouted` has to agree where
  // one is honoured, or a document from anywhere else — hand-edited markup, a
  // version with different rules — puts an arrow on an edge that does not
  // exist. The id is dropped exactly as a deleted one is.
  useEditor.setState({ annotations: [] });
  useEditor.getState().replaceAll([
    arrow({ id: "other", x1: 0, y1: 0, x2: 400, y2: 400 }),
    arrow({ toId: "other", x2: 913, y2: 407 }),
  ]);
  expect(line().toId).toBeUndefined();
  // And it stays where it was put, like any other untied end.
  expect(line().x2).toBe(913);
  expect(line().y2).toBe(407);
});

// --------------------------------------------------------------- selection

test("a group is picked up whole, from any one of its members", () => {
  useEditor.setState({
    annotations: [
      { ...rect("a", 0, 0), group: "g" },
      { ...rect("b", 200, 0), group: "g" },
      rect("c", 400, 0),
    ],
  });
  useEditor.getState().select(["a"]);
  expect(useEditor.getState().selectedIds.sort()).toEqual(["a", "b"]);

  // And a shape outside it is not dragged in.
  useEditor.getState().select(["c"]);
  expect(useEditor.getState().selectedIds).toEqual(["c"]);
});

test("a locked shape cannot be selected, so nothing can be done to it", () => {
  useEditor.setState({ annotations: [{ ...rect("a", 0, 0), locked: true }, rect("b", 200, 0)] });
  useEditor.getState().select(["a", "b"]);
  expect(useEditor.getState().selectedIds).toEqual(["b"]);
});

test("a locked shape is still a thing an arrow can be tied to", () => {
  // Locked means "not to be edited". Being pointed at is not an edit, and an
  // arrow that quietly refused to attach to a locked box would look broken.
  useEditor.setState({
    annotations: rerouted([
      { ...rect("a", 0, 0), locked: true },
      arrow({ fromId: "a", x2: 900, y2: 50 }),
    ]),
  });
  expect(line().x1).toBeCloseTo(100 + GAP, 6);
});

test("a copied group is a group of its own", () => {
  // Or the copy and the original would move together for the rest of the
  // document's life, and nothing on screen would say why.
  useEditor.setState({
    annotations: [
      { ...rect("a", 0, 0), group: "g" },
      { ...rect("b", 200, 0), group: "g" },
    ],
  });
  useEditor.getState().select(["a"]);
  useEditor.getState().duplicateSelection();

  const copies = useEditor.getState().selectedIds.map((id) => shape(id));
  const groups = new Set(copies.map((a) => a.group));
  expect(groups.size).toBe(1);
  expect([...groups][0]).not.toBe("g");
  // Still grouped to each other, though — that is what was copied.
  expect(copies).toHaveLength(2);
});

test("grouping and ungrouping is a round trip", () => {
  useEditor.setState({ annotations: [rect("a", 0, 0), rect("b", 200, 0), rect("c", 400, 0)] });
  useEditor.getState().select(["a", "b"]);
  useEditor.getState().group();
  expect(shape("a").group).toBeDefined();
  expect(shape("a").group).toBe(shape("b").group);
  expect(shape("c").group).toBeUndefined();

  useEditor.getState().ungroup();
  expect(shape("a").group).toBeUndefined();
  expect(shape("b").group).toBeUndefined();
});

test("deleting the selection takes the selection with it", () => {
  // A selection holding ids that no longer exist is how a later action comes
  // to act on nothing while the chrome says otherwise.
  useEditor.setState({ annotations: [rect("a", 0, 0), rect("b", 200, 0)], selectedIds: ["a"] });
  useEditor.getState().deleteSelection();
  expect(useEditor.getState().annotations.map((a) => a.id)).toEqual(["b"]);
  expect(useEditor.getState().selectedIds).toEqual([]);
});

test("reordering moves the selection through the stack without losing anything", () => {
  const ids = () => useEditor.getState().annotations.map((a) => a.id);
  useEditor.setState({
    annotations: [rect("a", 0, 0), rect("b", 200, 0), rect("c", 400, 0)],
    selectedIds: ["a"],
  });

  // Last in the array is topmost, which is the order the canvas paints and
  // the order `bondTargetAt` reads backwards.
  useEditor.getState().reorder("front");
  expect(ids()).toEqual(["b", "c", "a"]);
  useEditor.getState().reorder("back");
  expect(ids()).toEqual(["a", "b", "c"]);
  useEditor.getState().reorder("forward");
  expect(ids()).toEqual(["b", "a", "c"]);
});

// ----------------------------------------------------------------- history

test("nothing selected means nothing moved, and no history entry either", () => {
  joined();
  useEditor.setState({ selectedIds: [] });
  const before = useEditor.getState().annotations;
  useEditor.getState().nudge(10, 10);
  useEditor.getState().align("left");
  expect(useEditor.getState().annotations).toBe(before);
  expect(useEditor.getState().past).toHaveLength(0);
});

test("a snapshot taken before a change is what undo goes back to", () => {
  useEditor.setState({ annotations: [rect("a", 0, 0)], selectedIds: ["a"] });
  useEditor.getState().snapshot();
  useEditor.getState().nudge(50, 0);
  expect((shape("a") as { x: number }).x).toBe(50);

  useEditor.getState().undo();
  expect((shape("a") as { x: number }).x).toBe(0);
  useEditor.getState().redo();
  expect((shape("a") as { x: number }).x).toBe(50);
});
