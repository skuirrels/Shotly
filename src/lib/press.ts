import type { ToolId } from "./types";

/**
 * What a press on an existing shape means, given the tool in hand.
 *
 * Pulled out of the canvas and given a name because it is a *rule*, and the
 * one time it was decided inline it got quietly rewritten: the arrow tool was
 * taught to draw a connector from the shape under the press, which took the
 * move gesture away from every shape on the page for as long as that tool was
 * up — and the arrow tool stays up after you draw one. Connectors start from
 * the anchors that appear on a hovered shape instead; see `anchorsOf`.
 *
 * The rule, in one place, testable, and short enough to read:
 */
export type ShapePress =
  /** Pick the shape up. What the move cursor on hover has always promised. */
  | "move"
  /** Ignore the shape and let the stage have it — drawing straight through. */
  | "through";

export function shapePress(tool: ToolId, alt: boolean): ShapePress {
  // The eyedropper reads the capture *underneath* the annotations, so a press
  // on a shape has to reach the pixels rather than pick the shape up.
  if (tool === "pick") return "through";
  // The escape hatch, and the reason it exists: a highlight covering most of
  // the capture would otherwise leave nowhere to start a drag. Select has
  // nothing to draw, so Alt means nothing there.
  if (alt && tool !== "select") return "through";
  return "move";
}
