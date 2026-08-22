/**
 * The rule a press on a shape follows. Pinned because breaking it is invisible
 * until someone tries to move a shape and draws on it instead — which is
 * exactly what happened when the arrow tool was given a special case here.
 */
import { expect, test } from "vitest";
import { shapePress } from "./press";
import { TOOL_IDS } from "./types";

test("every tool moves the shape it is pressed on", () => {
  // Including the arrow. A connector starts from the anchors on a hovered
  // shape, never by stealing the press that moves it — the regression this
  // test exists for made a page of shapes unmovable the moment an arrow was
  // drawn, because the arrow tool stays in hand afterwards.
  for (const tool of TOOL_IDS) {
    if (tool === "pick") continue;
    expect(shapePress(tool, false)).toBe("move");
  }
});

test("the eyedropper reads through a shape rather than picking it up", () => {
  expect(shapePress("pick", false)).toBe("through");
  expect(shapePress("pick", true)).toBe("through");
});

test("Alt draws through, except with nothing to draw", () => {
  expect(shapePress("rect", true)).toBe("through");
  expect(shapePress("arrow", true)).toBe("through");
  // Select has no ink, so Alt is not an escape from anything.
  expect(shapePress("select", true)).toBe("move");
});
