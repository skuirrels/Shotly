import { createRoot } from "react-dom/client";
import "./harness.css";
import { ScrollApp } from "@/windows/scroll/ScrollApp";

createRoot(document.getElementById("root")!).render(<ScrollApp />);

// Walk it through its phases with plausible progress.
setTimeout(() => (window as any).EMIT("scroll:phase", "hud"), 300);
setTimeout(() => {
  const c = document.createElement("canvas");
  c.width = 148; c.height = 240;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff"; g.fillRect(0, 0, 148, 240);
  g.fillStyle = "#888";
  for (let y = 8; y < 232; y += 14) g.fillRect(10, y, 108 + (y % 3) * 8, 6);
  (window as any).EMIT("scroll:progress", {
    frames: 14, height: 4212, preview: c.toDataURL(), stalled: false,
  });
}, 600);
