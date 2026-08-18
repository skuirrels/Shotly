import { useState } from "react";
import { createRoot } from "react-dom/client";
import "./harness.css";
import { TopBar } from "@/windows/editor/TopBar";
import type { View } from "@/windows/editor/view";

/**
 * The window chrome, in each of its three states.
 *
 * The bar is what every header change lands on — height, the view tabs, the
 * editing controls — and it cannot be seen in a plain browser through the app
 * itself, because the main entry point talks to Tauri unstubbed. All three
 * views are stacked so a change to the bar's shape is checked against the
 * short library bar and the player bar in one glance, not just the editor's.
 */
function Bar({ initial, player }: { initial: View; player: boolean }) {
  const [view, setView] = useState<View>(initial);
  return (
    <TopBar
      view={view}
      canEdit
      player={
        player
          ? {
              name: "Recording 2026-08-18 at 09.15.14.mov",
              onReveal: () => console.log("reveal"),
              onExternal: () => console.log("external"),
              onDelete: () => console.log("delete"),
              onCopyLink: () => console.log("copy link"),
            }
          : null
      }
      onView={setView}
      onCapture={(mode) => console.log("capture", mode)}
      onOpenFile={() => console.log("open")}
      onCopy={() => console.log("copy")}
      onDelete={() => console.log("delete")}
      onSave={() => console.log("save")}
      onExportFlat={() => console.log("export")}
      pickedCount={0}
      busy={null}
    />
  );
}

function Harness() {
  return (
    <div className="flex h-screen flex-col gap-6 bg-base py-6 text-ink">
      <Bar initial="editor" player={false} />
      <Bar initial="library" player={false} />
      <Bar initial="player" player />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
