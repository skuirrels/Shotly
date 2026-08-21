import { useState } from "react";
import { createRoot } from "react-dom/client";
import "./harness.css";
import { Canvas } from "@/windows/editor/Canvas";
import { useEditor } from "@/state/editorStore";
import { renderToPng } from "@/lib/export";
import type { Annotation, Style } from "@/lib/types";

/**
 * The drawing surface with shapes already turned.
 *
 * Rotation is the one thing about a shape that cannot be checked by reading
 * the geometry back: the question is whether the frame, the eight handles and
 * the grip stay with the shape as it goes round, and whether a side handle
 * then pulls along the shape's own axis rather than the screen's. Every kind
 * that can be turned is here at an angle, including the two that turn only
 * part of themselves — the blur samples the picture underneath, so its pixels
 * must stay square while its window tilts, and the spotlight's cover must stay
 * on the capture while its hole leans.
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
  { id: "flat", kind: "rect", x: 30, y: 30, width: 200, height: 110, style },
  { id: "tilted", kind: "rect", x: 300, y: 30, width: 200, height: 110, style, angle: 30 },
  { id: "oval", kind: "ellipse", x: 570, y: 30, width: 190, height: 110, style, angle: -25 },
  {
    id: "words",
    kind: "text",
    x: 30,
    y: 230,
    width: 210,
    height: 46,
    text: "Turned text",
    style,
    angle: 16,
  },
  {
    id: "callout",
    kind: "callout",
    x: 290,
    y: 220,
    width: 210,
    height: 66,
    text: "Callout",
    style: { ...style, color: "#0A84FF" },
    angle: -12,
  },
  // Over the corner of the picture's green square on purpose: if the pixels
  // turned with the clip, the edge of that square would lean inside the blur
  // and stay level outside it.
  { id: "blurred", kind: "blur", x: 640, y: 480, width: 150, height: 100, style, angle: 20 },
  {
    id: "scribble",
    kind: "pen",
    points: [
      { x: 60, y: 400 },
      { x: 120, y: 470 },
      { x: 180, y: 395 },
      { x: 250, y: 480 },
    ],
    style,
    angle: 18,
  },
  { id: "lit", kind: "spotlight", x: 320, y: 390, width: 200, height: 120, style, angle: 25 },
  { id: "pointer", kind: "arrow", x1: 560, y1: 190, x2: 740, y2: 300, style },
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
  selectedIds: ["tilted"],
});

/**
 * The preview, and beside it what the exporter makes of the same shapes.
 *
 * The two renderers turn shapes by different means — a `rotate()` transform in
 * SVG, `ctx.rotate` on the canvas — so the only way to know they agree is to
 * put them next to each other.
 */
function Harness() {
  const [png, setPng] = useState<string | null>(null);

  const exportNow = async () => {
    const s = useEditor.getState();
    const bytes = await renderToPng(s.doc!, s.annotations);
    setPng(URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" })));
  };

  return (
    <div className="flex h-screen flex-col bg-canvas">
      <div className="flex h-10 shrink-0 items-center gap-3 bg-surface px-3">
        <button className="rounded bg-accent px-3 py-1 text-sm text-white" onClick={exportNow}>
          export
        </button>
        {png && <span className="text-xs text-ink">exported →</span>}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Canvas onNotify={(t) => console.log("notify:", t)} />
        </div>
        {png && (
          <img src={png} alt="export" className="h-full w-1/2 shrink-0 object-contain bg-inset" />
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);

// Exposed so a drag can be checked against the geometry it produced.
Object.defineProperty(window, "STORE", { get: () => useEditor.getState() });
