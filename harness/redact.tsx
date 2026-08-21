import { useState } from "react";
import { createRoot } from "react-dom/client";
import "./harness.css";
import { renderRedactedOriginal } from "@/lib/export";
import type { Annotation, Style } from "@/lib/types";
import type { Doc } from "@/state/editorStore";

/**
 * The picture that gets tucked inside a saved capture.
 *
 * This is the one thing about a save that cannot be checked by looking at the
 * app: a saved PNG carries the *unannotated* original so the shapes stay
 * editable, and the whole claim of `renderRedactedOriginal` is that the copy it
 * makes no longer has the blurred pixels in it. On screen both files look
 * identical, because the visible capture is flattened either way. The only way
 * to see the difference is to render the embedded copy on its own.
 *
 * So: the source on the left, what would go in the file on the right. The
 * blurs are placed over the green and yellow squares in `source.png` — flat
 * colour would hide a failure, where a hard edge either survives or does not.
 *
 * `peek.py` in a scratch directory does the same job for a file that has
 * already been saved; this is the version that needs no app running.
 */
const style: Style = {
  color: "#FF3B30",
  strokeWidth: 6,
  fontSize: 30,
  fillOpacity: 0,
  cornerRadius: 0,
  blurRadius: 14,
  dim: 0.5,
  shadow: true,
  neon: false,
  measureUnits: "px",
};

const doc: Doc = {
  id: 1,
  src: "/source.png",
  path: "/source.png",
  naturalWidth: 800,
  naturalHeight: 600,
  // Deliberately not the whole image: annotations are stored relative to the
  // crop and the file is not, so a crop that is ignored on the way in puts
  // every blur in the wrong place — which is exactly the bug worth catching.
  crop: { x: 40, y: 30, width: 700, height: 520 },
  scale: 2,
  outputScale: 1,
  canvasFill: "#FFFFFF",
};

const annotations: Annotation[] = [
  // Over the yellow square in the corner of the source image.
  { id: "a", kind: "blur", x: -40, y: -30, width: 120, height: 90, style },
  // Over the green one, and turned, so the rotated path is covered too.
  { id: "b", kind: "blur", x: 610, y: 460, width: 150, height: 110, style, angle: 20 },
  // Something that is not a redaction, to prove it is left alone.
  { id: "c", kind: "rect", x: 200, y: 200, width: 200, height: 120, style },
];

function Harness() {
  const [png, setPng] = useState<string | null>(null);
  const [note, setNote] = useState<string>("");

  const run = async () => {
    const bytes = await renderRedactedOriginal(doc, annotations);
    if (!bytes) {
      setNote("nothing blurred — nothing to redact");
      return;
    }
    setNote(`${bytes.length} bytes`);
    setPng(URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" })));
  };

  return (
    <div className="flex h-screen flex-col bg-canvas">
      <div className="flex h-10 shrink-0 items-center gap-3 bg-surface px-3">
        <button className="rounded bg-accent px-3 py-1 text-sm text-white" onClick={run}>
          redact
        </button>
        <span className="text-xs text-ink">{note}</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <figure className="flex min-w-0 flex-1 flex-col items-center gap-1 p-2">
          <figcaption className="text-[11px] text-ink-3">the file on disk</figcaption>
          <img src="/source.png" alt="source" className="min-h-0 flex-1 object-contain" />
        </figure>
        <figure className="flex min-w-0 flex-1 flex-col items-center gap-1 p-2">
          <figcaption className="text-[11px] text-ink-3">what gets embedded</figcaption>
          {png ? (
            <img src={png} alt="redacted" className="min-h-0 flex-1 object-contain" />
          ) : (
            <span className="text-xs text-ink-4">press redact</span>
          )}
        </figure>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);

Object.defineProperty(window, "REDACT", {
  get: () => renderRedactedOriginal(doc, annotations),
});
