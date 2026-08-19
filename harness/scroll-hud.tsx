import { createRoot } from "react-dom/client";
import "./harness.css";
import { ScrollApp } from "@/windows/scroll/ScrollApp";

createRoot(document.getElementById("root")!).render(<ScrollApp />);

/** A strip of "page", for the preview and the anchor. */
function strip(width: number, height: number) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, width, height);
  g.fillStyle = "#888";
  for (let y = 8; y < height - 8; y += 14)
    g.fillRect(10, y, width * 0.73 + (y % 3) * 8, 6);
  return c.toDataURL();
}

// Walk it through its phases with plausible progress.
setTimeout(() => (window as any).EMIT("scroll:phase", "hud"), 300);
setTimeout(() => {
  (window as any).EMIT("scroll:progress", {
    frames: 14,
    height: 4212,
    preview: strip(148, 240),
    stalled: false,
  });
}, 600);

// And then into the state it spends its worst moments in. Worth having in the
// harness precisely because it is the hard one to reach in the real app — it
// takes a scroll fast enough to break the thread — and it is the panel a user
// reads when the capture has gone wrong, so its layout has to hold.
setTimeout(() => {
  (window as any).EMIT("scroll:progress", {
    frames: 31,
    height: 4212,
    preview: strip(148, 240),
    stalled: true,
    behind: false,
    anchor: strip(220, 46),
  });
}, 1600);

// The other way of getting stuck: scrolled back over page already captured,
// where the way on is down rather than back. Same panel, opposite advice —
// which is the whole reason it is worth being able to see both.
setTimeout(() => {
  (window as any).EMIT("scroll:progress", {
    frames: 46,
    height: 4212,
    preview: strip(148, 240),
    stalled: true,
    behind: true,
    anchor: strip(220, 46),
  });
}, 3200);

// And the state that used to be reported as the first of those two and is
// neither: a gap between sections, where there is nothing on screen to capture
// and nothing wrong. It says so in the status line and nowhere else, which is
// the point — the panel should not raise its voice for a blank page.
setTimeout(() => {
  (window as any).EMIT("scroll:progress", {
    frames: 58,
    height: 4212,
    preview: strip(148, 240),
    stalled: false,
    behind: false,
    blank: true,
  });
}, 4800);
