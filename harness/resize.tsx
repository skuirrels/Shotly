import { createRoot } from "react-dom/client";
import "./harness.css";
import { ResizePicker } from "@/windows/editor/ResizePicker";
import { useEditor } from "@/state/editorStore";

useEditor.setState({
  doc: {
    id: 1,
    src: "/source.png",
    path: "/source.png",
    naturalWidth: 3024,
    naturalHeight: 1964,
    crop: { x: 0, y: 0, width: 3024, height: 1964 },
    scale: 2,
    outputScale: 1,
  },
});

createRoot(document.getElementById("root")!).render(
  <div className="flex h-12 items-center justify-center bg-surface">
    <ResizePicker />
  </div>,
);
