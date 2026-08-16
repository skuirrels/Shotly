import clsx from "clsx";
import { IconCanvas } from "@/components/icons";
import { Popover } from "@/components/ui/Popover";
import { hasBareCanvas, useEditor } from "@/state/editorStore";

/**
 * Room to put things next to the capture.
 *
 * The crop was always a window onto the source image; nothing said the window
 * had to be inside it. Pushing an edge outward is how two screenshots end up
 * side by side rather than one on top of the other — see `Doc.canvasFill`.
 *
 * Deliberately not a numeric size field. Nobody knows how many pixels of blank
 * space they want; they want *enough for the thing they are about to put
 * there*, which is what a step and a shrink-wrap answer.
 */

/** A step of space, as a fraction of the capture's shorter side. */
const STEP = 0.25;

const FILLS = [
  { id: "#FFFFFF", name: "White" },
  { id: "#F2F2F0", name: "Paper" },
  { id: "#1C1C1E", name: "Charcoal" },
  { id: "#0A84FF", name: "Blue" },
  { id: "transparent", name: "Transparent" },
];

const EDGES = [
  { edge: "top", label: "Top", d: "M8 3v10 M4.5 6.5L8 3l3.5 3.5" },
  { edge: "bottom", label: "Bottom", d: "M8 13V3 M4.5 9.5L8 13l3.5-3.5" },
  { edge: "left", label: "Left", d: "M3 8h10 M6.5 4.5L3 8l3.5 3.5" },
  { edge: "right", label: "Right", d: "M13 8H3 M9.5 4.5L13 8l-3.5 3.5" },
] as const;

export function CanvasPicker({ disabled }: { disabled?: boolean }) {
  const doc = useEditor((s) => s.doc);
  const expandCanvas = useEditor((s) => s.expandCanvas);
  const fitCanvasToContent = useEditor((s) => s.fitCanvasToContent);
  const setCanvasFill = useEditor((s) => s.setCanvasFill);

  const on = doc ? hasBareCanvas(doc) : false;
  const step = doc ? Math.round(Math.min(doc.crop.width, doc.crop.height) * STEP) : 0;

  return (
    <Popover
      align="center"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          disabled={disabled}
          title="Make room beside the capture"
          aria-label="Canvas"
          className={clsx(
            "flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium transition-colors disabled:opacity-40",
            on
              ? "bg-accent/18 text-accent shadow-[inset_0_0_0_1px_var(--color-accent)]"
              : "text-ink-2 hover:bg-hover hover:text-ink",
            open && !on && "bg-hover",
          )}
        >
          <IconCanvas />
          Canvas
        </button>
      )}
    >
      {() => (
        <div className="w-[236px] p-2.5">
          <Row label="Add space">
            <div className="flex gap-1">
              {EDGES.map((e) => (
                <button
                  key={e.edge}
                  type="button"
                  onClick={() => expandCanvas(e.edge, step)}
                  title={`Add space at the ${e.label.toLowerCase()}`}
                  aria-label={`Add space at the ${e.label.toLowerCase()}`}
                  className="grid h-[30px] flex-1 place-items-center rounded-md bg-white/[0.05] text-ink-3 transition-colors hover:bg-white/[0.09] hover:text-ink"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d={e.d} />
                  </svg>
                </button>
              ))}
            </div>
          </Row>

          {/* The other half of the gesture: drag a pasted screenshot off the
              edge, then have the canvas take the shape of what is on it. */}
          <button
            type="button"
            onClick={fitCanvasToContent}
            className="mb-2.5 h-[30px] w-full rounded-md bg-white/[0.05] text-[11.5px] text-ink-2 transition-colors hover:bg-white/[0.09] hover:text-ink"
          >
            Shrink-wrap to what's on it
          </button>

          <Row label="Background">
            <div className="flex flex-wrap gap-1.5">
              {FILLS.map((fill) => (
                <button
                  key={fill.id}
                  type="button"
                  onClick={() => setCanvasFill(fill.id)}
                  title={fill.name}
                  aria-label={fill.name}
                  className={clsx(
                    "size-[22px] rounded-md ring-1 ring-white/15 ring-inset",
                    fill.id === "transparent" &&
                      "bg-[linear-gradient(135deg,transparent_45%,rgba(255,255,255,0.5)_45%,rgba(255,255,255,0.5)_55%,transparent_55%)]",
                    doc?.canvasFill === fill.id && "ring-2 ring-white",
                  )}
                  style={fill.id === "transparent" ? undefined : { background: fill.id }}
                />
              ))}
            </div>
          </Row>

          <p className="mt-1 border-t border-white/8 pt-2 text-[11px] leading-snug text-ink-4">
            {on
              ? "Paste another capture with ⌘V and drag it into the space."
              : "Adds blank canvas beside the capture, to arrange other things on."}
          </p>
        </div>
      )}
    </Popover>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2.5">
      <div className="mb-1 text-[10.5px] font-semibold tracking-wider text-ink-4 uppercase">
        {label}
      </div>
      {children}
    </div>
  );
}
