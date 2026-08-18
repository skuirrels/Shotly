import { createRoot } from "react-dom/client";
import "./harness.css";
import { Canvas } from "@/windows/editor/Canvas";
import { useEditor } from "@/state/editorStore";

/**
 * The drawing surface with the crop tool armed.
 *
 * Exists because the crop confirmation could not be looked at anywhere: no
 * page mounted Canvas, so the only proof the Crop button existed was reading
 * the source. Drag a marquee and the overlay should answer with the size, a
 * Cancel and a Crop button — the absence of which was a real bug report.
 */
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
  tool: "crop",
});

createRoot(document.getElementById("root")!).render(
  <div className="flex h-screen flex-col bg-canvas">
    <Canvas onNotify={(t) => console.log("notify:", t)} />
  </div>,
);

// Expose the store so the harness can assert on what the buttons did.
Object.defineProperty(window, "STORE", { get: () => useEditor.getState() });
