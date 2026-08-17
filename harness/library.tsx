import { useState } from "react";
import { createRoot } from "react-dom/client";
import "./harness.css";
import { Library } from "@/windows/editor/Library";

/**
 * The library grid over a stubbed listing that mixes recordings with stills —
 * which is the only thing worth looking at here: the play badge, the running
 * time where the dimensions go, and a right-click menu that drops everything a
 * movie cannot do.
 */
function Harness() {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <div className="h-screen bg-base text-ink">
      <Library
        onOpen={(p) => console.log("open in editor:", p)}
        onCopy={() => {}}
        onDelete={() => {}}
        refreshKey={0}
        onError={(m) => console.error(m)}
        empty={<p className="p-8">Nothing captured yet.</p>}
        selected={selected}
        onSelect={setSelected}
        onItems={() => {}}
        onCombine={() => {}}
        onPin={() => {}}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
