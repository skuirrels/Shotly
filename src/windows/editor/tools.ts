import type { ReactNode } from "react";
import {
  IconArrow,
  IconBlur,
  IconCrop,
  IconEllipse,
  IconHighlight,
  IconLine,
  IconRect,
  IconSelect,
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
  { id: "text", label: "Text", shortcut: "T", icon: IconText },
  { id: "step", label: "Step number", shortcut: "N", icon: IconStep },
  { id: "blur", label: "Blur", shortcut: "B", icon: IconBlur },
  { id: "highlight", label: "Highlight", shortcut: "H", icon: IconHighlight },
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
  color: boolean;
} {
  switch (kind) {
    case "text":
      return { stroke: false, fill: false, font: true, blur: false, color: true };
    case "blur":
      return { stroke: false, fill: false, font: false, blur: true, color: false };
    case "highlight":
      return { stroke: false, fill: false, font: false, blur: false, color: true };
    case "step":
      return { stroke: true, fill: false, font: false, blur: false, color: true };
    case "rect":
    case "ellipse":
      return { stroke: true, fill: true, font: false, blur: false, color: true };
    case "arrow":
    case "line":
      return { stroke: true, fill: false, font: false, blur: false, color: true };
    default:
      return { stroke: false, fill: false, font: false, blur: false, color: false };
  }
}
