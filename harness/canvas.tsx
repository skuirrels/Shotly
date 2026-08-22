import { createRoot } from "react-dom/client";
import "./harness.css";
import { CanvasPicker } from "@/windows/editor/CanvasPicker";
import { Toolbar } from "@/windows/editor/Toolbar";
import { useEditor } from "@/state/editorStore";

useEditor.setState({
  doc: {
    id: 1,
    src: "/source.png",
    path: "/source.png",
    naturalWidth: 800,
    naturalHeight: 600,
    crop: { x: -100, y: 0, width: 1100, height: 600 },
    scale: 2,
    outputScale: 1,
    canvasFill: "#FFFFFF",
  },
  tool: "measure",
});

createRoot(document.getElementById("root")!).render(
  <div className="relative h-screen bg-canvas">
    <div className="flex h-12 items-center justify-center gap-2 bg-surface">
      <CanvasPicker />
    </div>
    <Toolbar onNotify={() => {}} focus={false} onToggleFocus={() => {}} onShortcuts={() => {}} />
  </div>,
);

// Expose the document so the harness can assert on what the buttons did.
Object.defineProperty(window, "DOC", { get: () => useEditor.getState().doc });
