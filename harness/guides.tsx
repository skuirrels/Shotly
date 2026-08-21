import { createRoot } from "react-dom/client";
import "./harness.css";
import { Canvas } from "@/windows/editor/Canvas";
import { useEditor } from "@/state/editorStore";
import type { Annotation, Style } from "@/lib/types";

/**
 * The drawing surface with things to line up against.
 *
 * Snapping is the one feature whose whole value is in a couple of pixels, so
 * looking at it proves nothing: the question is always whether the shape
 * landed *exactly* on the coordinate the line claims, and whether the corner
 * that was not being dragged stayed where it was. Both are numbers, so this
 * page exists to be driven from the console and read back — `STORE` gives the
 * geometry and `GUIDES` gives the lines currently on screen.
 *
 * The shapes are placed on purpose: two of them share a left edge, two more
 * sit an even 60 apart in a row, and there is a lone box out on its own to
 * drag around. Nothing is turned, because a turned shape deliberately does not
 * snap on resize — see the rotation note in `lib/guides`.
 */
const style: Style = {
  color: "#FF3B30",
  strokeWidth: 6,
  fontSize: 30,
  fillOpacity: 0,
  cornerRadius: 0,
  blurRadius: 10,
  dim: 0.5,
  shadow: true,
  neon: false,
  measureUnits: "px",
};

const annotations: Annotation[] = [
  // A column: same left edge, so dragging anything near x = 120 should catch.
  { id: "top", kind: "rect", x: 120, y: 40, width: 160, height: 90, style },
  { id: "bottom", kind: "rect", x: 120, y: 300, width: 160, height: 90, style },
  // A row with an even gap of 60 between them, for the spacing match.
  { id: "one", kind: "rect", x: 380, y: 40, width: 80, height: 80, style },
  { id: "two", kind: "rect", x: 520, y: 40, width: 80, height: 80, style },
  // The one to drag.
  { id: "loose", kind: "rect", x: 400, y: 440, width: 120, height: 70, style },
];

useEditor.setState({
  doc: {
    id: 1,
    src: "/source.png",
    path: "/source.png",
    naturalWidth: 800,
    naturalHeight: 600,
    crop: { x: 0, y: 0, width: 800, height: 600 },
    scale: 2,
    outputScale: 1,
    canvasFill: "#FFFFFF",
  },
  tool: "select",
  annotations,
  selectedIds: [],
});

function Harness() {
  return (
    <div className="flex h-screen flex-col bg-canvas">
      <div className="flex min-h-0 flex-1">
        <Canvas onNotify={(t) => console.log("notify:", t)} />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);

Object.defineProperty(window, "STORE", { get: () => useEditor.getState() });

/**
 * The guides as the SVG has them, in document pixels.
 *
 * Read off the drawn elements rather than out of React state on purpose: a
 * line that the arithmetic produced but the layer failed to draw is exactly
 * the sort of thing this page is for.
 */
Object.defineProperty(window, "GUIDES", {
  get: () => {
    const svg = document.querySelector<SVGSVGElement>("svg.overflow-visible");
    if (!svg) return [];
    const zoom = svg.width.baseVal.value / 800;
    return [...svg.querySelectorAll("line")].map((l) => ({
      x1: +l.getAttribute("x1")! / zoom,
      y1: +l.getAttribute("y1")! / zoom,
      x2: +l.getAttribute("x2")! / zoom,
      y2: +l.getAttribute("y2")! / zoom,
    }));
  },
});
