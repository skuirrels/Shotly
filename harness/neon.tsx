import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./harness.css";
import { AnnotationLayer } from "@/windows/editor/AnnotationLayer";
import { renderToPng } from "@/lib/export";
import { NO_BACKDROP } from "@/lib/backdrop";
import { NEON_SWATCHES } from "@/windows/editor/tools";
import { DEFAULT_STYLE, type Doc } from "@/state/editorStore";
import type { Annotation } from "@/lib/types";

/**
 * The neon style, drawn twice: once by the SVG renderer the editor uses, and
 * once by the Canvas2D renderer that writes the PNG.
 *
 * Two renderers drawing the same shape is the standing risk in this codebase,
 * and a glow is the easiest thing in it to get subtly different — CSS
 * `drop-shadow` and canvas `shadowBlur` are not the same primitive. Showing
 * them one above the other, over a *bright* screenshot, is the check: the
 * boxes should match, and the white text should be readable on both.
 */

const doc: Doc = {
  id: 1,
  src: "/source.png",
  path: "/source.png",
  naturalWidth: 800,
  naturalHeight: 600,
  crop: { x: 0, y: 0, width: 800, height: 600 },
  scale: 2,
  outputScale: 1,
  canvasFill: "#FFFFFF",
};

const label = (
  id: string,
  text: string,
  color: string,
  x: number,
  y: number,
): Annotation =>
  ({
    id,
    kind: "callout",
    x,
    y,
    width: 300,
    height: 92,
    text,
    style: { ...DEFAULT_STYLE, color, fontSize: 34, neon: true },
  }) as Annotation;

const annotations: Annotation[] = [
  label("a", "Index", NEON_SWATCHES[0].value, 40, 40),
  label("b", "Data pages", NEON_SWATCHES[1].value, 420, 40),
  label("c", "Metadata", NEON_SWATCHES[3].value, 40, 200),
  label("d", "Other…", NEON_SWATCHES[6].value, 420, 200),
  // A two-line box, to prove the wrapping and the centring survive the border.
  label("e", "A longer neon label that wraps onto two lines", NEON_SWATCHES[5].value, 40, 360),
  // A bare neon ring: no scrim, because it must not wash down what it circles.
  {
    id: "f",
    kind: "rect",
    x: 420,
    y: 360,
    width: 300,
    height: 92,
    style: { ...DEFAULT_STYLE, color: NEON_SWATCHES[2].value, strokeWidth: 6, neon: true },
  } as Annotation,
  // The flat callout, unchanged, for comparison.
  {
    id: "g",
    kind: "callout",
    x: 40,
    y: 490,
    width: 300,
    height: 80,
    text: "Flat callout",
    style: { ...DEFAULT_STYLE, color: "#FF9500", fontSize: 34 },
  } as Annotation,
];

function Harness() {
  const [png, setPng] = useState<string | null>(null);

  useEffect(() => {
    void renderToPng(doc, annotations, NO_BACKDROP).then((bytes) =>
      setPng(URL.createObjectURL(new Blob([bytes], { type: "image/png" }))),
    );
  }, []);

  return (
    <div className="bg-canvas p-4 text-ink">
      <p className="mb-1 text-[11px] tracking-wider text-ink-4 uppercase">SVG — the editor</p>
      <div className="relative w-[800px]" style={{ height: 600 }}>
        <img src="/source.png" alt="" width={800} height={600} className="absolute inset-0" />
        <AnnotationLayer
          doc={doc}
          annotations={annotations}
          selectedIds={[]}
          zoom={1}
          editingId={null}
          shapeCursor="move"
          onShapePointerDown={() => {}}
          onHandlePointerDown={() => {}}
        />
      </div>

      <p className="mt-5 mb-1 text-[11px] tracking-wider text-ink-4 uppercase">
        Canvas — the exported PNG
      </p>
      {png && <img id="exported" src={png} alt="" width={800} height={600} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
