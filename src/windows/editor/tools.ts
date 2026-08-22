import type { ReactNode } from "react";
import {
  IconArrow,
  IconBlur,
  IconCallout,
  IconCrop,
  IconEllipse,
  IconEyedropper,
  IconTextGrab,
  IconHighlight,
  IconMeasure,
  IconLine,
  IconPen,
  IconRect,
  IconSelect,
  IconSpotlight,
  IconStep,
  IconText,
} from "@/components/icons";
import type { ToolId } from "@/lib/types";

export interface ToolDef {
  id: ToolId;
  label: string;
  shortcut: string;
  icon: (props: { className?: string }) => ReactNode;
}

/**
 * The tool palette, in toolbar order.
 *
 * Shortcuts are single letters chosen to be mnemonic and, where two tools
 * compete for the same initial, to stay on the left half of the keyboard so
 * they're reachable while the other hand is on the trackpad.
 */
export const TOOLS: ToolDef[] = [
  { id: "select", label: "Select", shortcut: "V", icon: IconSelect },
  { id: "arrow", label: "Arrow", shortcut: "A", icon: IconArrow },
  { id: "rect", label: "Rectangle", shortcut: "R", icon: IconRect },
  { id: "ellipse", label: "Ellipse", shortcut: "E", icon: IconEllipse },
  { id: "line", label: "Line", shortcut: "L", icon: IconLine },
  { id: "pen", label: "Pen", shortcut: "P", icon: IconPen },
  { id: "text", label: "Text", shortcut: "T", icon: IconText },
  { id: "callout", label: "Callout", shortcut: "O", icon: IconCallout },
  { id: "step", label: "Step number", shortcut: "N", icon: IconStep },
  { id: "blur", label: "Blur", shortcut: "B", icon: IconBlur },
  { id: "highlight", label: "Highlight", shortcut: "H", icon: IconHighlight },
  { id: "spotlight", label: "Spotlight", shortcut: "S", icon: IconSpotlight },
  { id: "pick", label: "Pick colour", shortcut: "I", icon: IconEyedropper },
  { id: "measure", label: "Measure", shortcut: "M", icon: IconMeasure },
  // Named for both halves because one gesture does both: the same drag reads
  // the prose and decodes any QR or barcode inside it. Called "Grab text", the
  // QR half would only ever be found by accident.
  { id: "grab", label: "Grab text & codes", shortcut: "G", icon: IconTextGrab },
  { id: "crop", label: "Crop", shortcut: "C", icon: IconCrop },
];

/**
 * The palette, in slots rather than in sixteen icons.
 *
 * Sixteen identical squares in a row give the eye nothing to hold on to and
 * ask the hand to remember sixteen letters. Grouped by what the tool *makes* —
 * a shape, some words, an emphasis, a reading off the picture — the bar is six
 * slots, each showing whichever of its tools you used last, with the rest one
 * press away in a menu that names them and their keys.
 *
 * Every letter still works exactly as it did. This changes what the bar looks
 * like and what it teaches, not what the keyboard does: nothing here is a
 * rebinding, and a hand that knows `S` for spotlight never has to learn where
 * spotlight went.
 */
export interface ToolGroup {
  id: string;
  /** What the slot is called when it holds more than one tool. */
  label: string;
  /** In menu order; the first is the slot's default before anything is used. */
  tools: ToolId[];
}

export const TOOL_GROUPS: ToolGroup[] = [
  { id: "select", label: "Select", tools: ["select"] },
  { id: "shape", label: "Shapes", tools: ["arrow", "line", "rect", "ellipse", "pen"] },
  { id: "text", label: "Text", tools: ["text", "callout", "step"] },
  { id: "emphasis", label: "Emphasis", tools: ["blur", "highlight", "spotlight"] },
  // The three that take something *out* of the capture rather than adding to
  // it: the words, a distance, a colour.
  { id: "read", label: "Read from the capture", tools: ["grab", "measure", "pick"] },
  { id: "crop", label: "Crop", tools: ["crop"] },
];

/** The tool definition for an id — the icon, label and key the palette shows. */
export const toolDef = (id: ToolId): ToolDef => TOOLS.find((t) => t.id === id)!;

/** Annotation ink palette. Index order doubles as the ⌘1–⌘9 shortcuts. */
export const SWATCHES = [
  { name: "Red", value: "#FF3B30" },
  { name: "Orange", value: "#FF9500" },
  { name: "Yellow", value: "#FFCC00" },
  { name: "Green", value: "#34C759" },
  { name: "Blue", value: "#0A84FF" },
  { name: "Purple", value: "#BF5AF2" },
  { name: "Pink", value: "#FF2D55" },
  { name: "White", value: "#FFFFFF" },
  { name: "Black", value: "#1C1C1E" },
];

/**
 * The neon inks.
 *
 * A second row rather than a replacement: these are chosen to survive being
 * lit — saturated, bright, and far enough apart in hue to stay distinct once
 * each is glowing — which makes several of them poor choices for a hairline
 * arrow. The nine above stay the palette for everything else.
 *
 * No ⌘-digit shortcuts: the digits belong to the row above, and shadowing them
 * on whichever tool happens to be in hand would be worse than a two-click trip
 * to the picker.
 */
export const NEON_SWATCHES = [
  { name: "Hot pink", value: "#FF3EA5" },
  { name: "Electric blue", value: "#4D6BFF" },
  { name: "Cyan", value: "#22E0FF" },
  { name: "Amber", value: "#FFB020" },
  { name: "Lime", value: "#7CFF3E" },
  { name: "Violet", value: "#A855F7" },
  { name: "Ice", value: "#CFE6FF" },
];

export const STROKE_PRESETS = [2, 4, 6, 10, 16];

/**
 * Corner radii worth one click, in image pixels.
 *
 * 0 is the square corner and leads deliberately: it is the shape most people
 * want most of the time, and burying it at one end of a slider would make the
 * plainest rectangle the fiddliest to draw. The rest roughly double, because
 * roundness is judged by eye and even steps read as barely any change at all
 * near the top of the range. A Retina capture holds two pixels per point, so
 * these look about half as round on screen as they read written down.
 */
export const RADIUS_PRESETS = [0, 12, 24, 48, 96];
export const FONT_PRESETS = [16, 20, 24, 32, 48];

/** Which style controls make sense for the current tool or selection. */
export function styleControlsFor(kind: ToolId | string): {
  stroke: boolean;
  fill: boolean;
  font: boolean;
  blur: boolean;
  dim: boolean;
  color: boolean;
  /** The px/pt switch, which only a measurement has any use for. */
  units: boolean;
  /** The neon switch — shapes that can be drawn as a lit sign. */
  neon: boolean;
  /** How round the corners are, which only a rectangle has any. */
  radius: boolean;
} {
  const none = {
    stroke: false,
    fill: false,
    font: false,
    blur: false,
    dim: false,
    color: false,
    units: false,
    neon: false,
    radius: false,
  };

  switch (kind) {
    case "text":
      return { ...none, font: true, color: true };
    // No stroke or fill control: a callout *is* its fill, and the text colour
    // follows from it automatically so the words stay legible on any swatch.
    case "callout":
      return { ...none, font: true, color: true, neon: true };
    case "blur":
      return { ...none, blur: true };
    case "highlight":
      return { ...none, color: true };
    // No colour: the surround is darkened, not tinted, so the only thing worth
    // adjusting is how far down it goes.
    case "spotlight":
      return { ...none, dim: true };
    case "step":
      return { ...none, stroke: true, color: true };
    case "rect":
      return { ...none, stroke: true, fill: true, color: true, neon: true, radius: true };
    // No radius: an ellipse is already all corner, and there is nothing on it
    // for the number to describe.
    case "ellipse":
      return { ...none, stroke: true, fill: true, color: true, neon: true };
    case "arrow":
    case "line":
    case "pen":
      return { ...none, stroke: true, color: true };
    // The stroke width also sets the size of the number, so there is no
    // separate font control to offer.
    case "measure":
      return { ...none, stroke: true, color: true, units: true };
    default:
      return none;
  }
}
