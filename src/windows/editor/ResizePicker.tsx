import { useEffect, useState } from "react";
import clsx from "clsx";
import { Popover } from "@/components/ui/Popover";
import { type Doc, outputSize, useEditor } from "@/state/editorStore";

/**
 * How big the exported image will be — and, on click, a way to change it.
 *
 * The size readout was already sitting in the middle of the title bar saying
 * exactly what this control edits, so it becomes the control rather than
 * growing a second one beside it. Nothing moves until you click it.
 *
 * Resizing is non-destructive, like cropping: see `Doc.outputScale`.
 */

/** Offered as fractions rather than pixel sizes, which depend on the capture. */
const PRESETS = [
  { label: "100%", value: 1 },
  { label: "75%", value: 0.75 },
  { label: "50%", value: 0.5 },
  { label: "25%", value: 0.25 },
];

const fmt = (n: number) => Math.round(n).toLocaleString();

export function ResizePicker() {
  const doc = useEditor((s) => s.doc);
  const setOutputScale = useEditor((s) => s.setOutputScale);
  if (!doc) return null;

  const out = outputSize(doc);
  const resized = doc.outputScale !== 1;

  return (
    <Popover
      align="center"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          title="Resize the exported image"
          aria-label="Export size"
          className={clsx(
            // The bar around this is `pointer-events-none` so it can't eat
            // title-bar drags; this one element opts back in.
            "no-drag pointer-events-auto truncate rounded-md px-2 py-0.5 font-mono text-[11.5px] tabular-nums transition-colors",
            resized ? "text-accent hover:bg-accent/12" : "text-ink-3 hover:bg-hover hover:text-ink",
            open && "bg-hover",
          )}
        >
          {resized && (
            <span className="text-ink-4 line-through">
              {fmt(doc.crop.width)} × {fmt(doc.crop.height)}
            </span>
          )}
          {resized && <span className="mx-1.5 text-ink-4">→</span>}
          {fmt(out.width)} × {fmt(out.height)}
          <span className="mx-1.5 text-ink-4">·</span>
          {doc.scale * doc.outputScale >= 2 ? "@2x" : "@1x"}
        </button>
      )}
    >
      {() => <ResizeMenu doc={doc} onScale={setOutputScale} />}
    </Popover>
  );
}

function ResizeMenu({ doc, onScale }: { doc: Doc; onScale: (scale: number) => void }) {
  const out = outputSize(doc);

  return (
    <div className="w-[230px] p-2.5">
      <div className="mb-1 text-[10.5px] font-semibold tracking-wider text-ink-4 uppercase">
        Export size
      </div>

      <div className="flex gap-1">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => onScale(preset.value)}
            className={clsx(
              "h-[26px] flex-1 rounded-md text-[11.5px] font-medium transition-colors",
              Math.abs(preset.value - doc.outputScale) < 0.0005
                ? "bg-accent/20 text-accent shadow-[inset_0_0_0_1px_var(--color-accent)]"
                : "bg-white/[0.05] text-ink-3 hover:bg-white/[0.09] hover:text-ink-2",
            )}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {/* A Retina capture is twice the size of what was on screen, which is
          almost never what you want to paste into a document or attach to a
          ticket. It is the single most-wanted resize, so it gets a button of
          its own rather than making people work out that it means 50%. */}
      {doc.scale >= 2 && (
        <button
          type="button"
          onClick={() => onScale(1 / doc.scale)}
          className="mt-1.5 flex h-[30px] w-full items-center justify-between rounded-md bg-white/[0.05] px-2 text-[11.5px] text-ink-2 transition-colors hover:bg-white/[0.09] hover:text-ink"
        >
          <span>Actual screen size</span>
          <span className="font-mono text-ink-4">
            {fmt(doc.crop.width / doc.scale)} × {fmt(doc.crop.height / doc.scale)}
          </span>
        </button>
      )}

      <WidthField doc={doc} onScale={onScale} />

      <p className="mt-2 border-t border-white/8 pt-2 text-[11px] leading-snug text-ink-4">
        {doc.outputScale === 1
          ? "Saved and copied at full size."
          : `Saved and copied at ${fmt(out.width)} × ${fmt(out.height)}. The capture itself is untouched — undo or 100% brings it back.`}
      </p>
    </div>
  );
}

/**
 * An exact width, for when the target is a number someone else chose.
 *
 * Height follows the width; a screenshot squeezed out of proportion is never
 * what was meant. Committed on Enter or on blur rather than per keystroke,
 * so typing "1200" doesn't briefly resize the document to one pixel wide.
 */
function WidthField({ doc, onScale }: { doc: Doc; onScale: (scale: number) => void }) {
  const out = outputSize(doc);
  const [draft, setDraft] = useState(String(out.width));

  // Follow the presets: clicking 50% should move the number in the field too.
  useEffect(() => setDraft(String(out.width)), [out.width]);

  const commit = () => {
    const wanted = Number(draft);
    if (!Number.isFinite(wanted) || wanted < 1) {
      setDraft(String(out.width));
      return;
    }
    onScale(wanted / doc.crop.width);
  };

  return (
    <label className="mt-1.5 flex h-[30px] items-center gap-2 rounded-md bg-white/[0.05] px-2">
      <span className="text-[11.5px] text-ink-3">Width</span>
      <input
        type="number"
        min={1}
        max={Math.round(doc.crop.width)}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        className="min-w-0 flex-1 bg-transparent text-right font-mono text-[11.5px] tabular-nums text-ink outline-none"
      />
      <span className="text-[11.5px] text-ink-4">px</span>
    </label>
  );
}
