import type { ReactNode } from "react";
import {
  IconArrow,
  IconBlur,
  IconCrop,
  IconEllipse,
  IconEyedropper,
  IconHighlight,
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
  { id: "step", label: "Step number", shortcut: "N", icon: IconStep },
  { id: "blur", label: "Blur", shortcut: "B", icon: IconBlur },
  { id: "highlight", label: "Highlight", shortcut: "H", icon: IconHighlight },
  { id: "spotlight", label: "Spotlight", shortcut: "S", icon: IconSpotlight },
  { id: "pick", label: "Pick colour", shortcut: "I", icon: IconEyedropper },
  { id: "crop", label: "Crop", shortcut: "C", icon: IconCrop },
];

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

export const STROKE_PRESETS = [2, 4, 6, 10, 16];
export const FONT_PRESETS = [16, 20, 24, 32, 48];

/** Which style controls make sense for the current tool or selection. */
export function styleControlsFor(kind: ToolId | string): {
  stroke: boolean;
  fill: boolean;
  font: boolean;
  blur: boolean;
  dim: boolean;
  color: boolean;
} {
  const none = { stroke: false, fill: false, font: false, blur: false, dim: false, color: false };

  switch (kind) {
    case "text":
      return { ...none, font: true, color: true };
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
    case "ellipse":
      return { ...none, stroke: true, fill: true, color: true };
    case "arrow":
    case "line":
    case "pen":
      return { ...none, stroke: true, color: true };
    default:
      return none;
  }
}
