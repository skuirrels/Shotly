import { useCallback, useEffect, useState } from "react";

/**
 * "Point at part of the screen": drag out an area, or click a window.
 *
 * The geometry and the gestures only — every caller keeps its own IPC. Two
 * features ask this question (scrolling capture and recording) and they ask it
 * identically; what they do with the answer is where they differ. Sharing the
 * pixels and not the plumbing is what stops the two overlays drifting into
 * subtly different rules for the same drag.
 *
 * Everything here is in the overlay page's own coordinates. The page covers
 * exactly one display, so a caller turns a choice into screen coordinates with
 * a single offset.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Choice {
  /** The area chosen, page coordinates. */
  box: Box;
  /** Index into `windows` when a window was clicked, else `null`. */
  window: number | null;
}

export function SelectionOverlay({
  windows,
  minEdge = 60,
  title,
  hint,
  extra,
  onChoose,
  onCancel,
}: {
  /** Windows the selection can snap to, front to back, in page coordinates. */
  windows: Box[];
  /** Smaller than this in either direction and the drag is treated as a click. */
  minEdge?: number;
  title: string;
  hint: string;
  /** Anything that is a choice but not an area — a button under the prompt. */
  extra?: React.ReactNode;
  onChoose: (choice: Choice) => void;
  onCancel: () => void;
}) {
  const [drag, setDrag] = useState<{ from: { x: number; y: number }; box: Box } | null>(null);
  /** The window under the pointer, when there is one and nothing is being dragged. */
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const from = { x: e.clientX, y: e.clientY };
    setDrag({ from, box: { ...from, width: 0, height: 0 } });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) {
      // Front to back, so the first window holding the pointer is the one a
      // click would land on — the same rule the capture outline uses.
      const under = windows.findIndex(
        (w) =>
          e.clientX >= w.x &&
          e.clientY >= w.y &&
          e.clientX < w.x + w.width &&
          e.clientY < w.y + w.height,
      );
      setHover(under === -1 ? null : under);
      return;
    }
    setDrag({
      from: drag.from,
      box: {
        x: Math.min(drag.from.x, e.clientX),
        y: Math.min(drag.from.y, e.clientY),
        width: Math.abs(e.clientX - drag.from.x),
        height: Math.abs(e.clientY - drag.from.y),
      },
    });
  };

  const onPointerUp = useCallback(() => {
    if (!drag) return;
    const dragged = drag.box;
    setDrag(null);

    // A drag that never really moved is a click, and a click means "that one" —
    // the window being offered under the pointer. Dragging past the threshold
    // says the area wanted is not any window's, and wins.
    if (dragged.width >= minEdge && dragged.height >= minEdge) {
      onChoose({ box: dragged, window: null });
      return;
    }
    if (hover === null) return;
    const box = windows[hover];
    if (!box || box.width < minEdge || box.height < minEdge) return;
    onChoose({ box, window: hover });
  }, [drag, hover, windows, minEdge, onChoose]);

  const box = drag?.box ?? (hover === null ? null : windows[hover]);
  const big = box && box.width >= minEdge && box.height >= minEdge;

  return (
    <div
      className="fixed inset-0 cursor-crosshair select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* Four shades around the selection rather than one sheet under it, so
          the chosen area shows the desktop at full brightness. */}
      {box ? (
        <>
          <Shade style={{ left: 0, top: 0, right: 0, height: box.y }} />
          <Shade style={{ left: 0, top: box.y, width: box.x, height: box.height }} />
          <Shade
            style={{ left: box.x + box.width, top: box.y, right: 0, height: box.height }}
          />
          <Shade style={{ left: 0, top: box.y + box.height, right: 0, bottom: 0 }} />
          <div
            className="absolute border-2"
            style={{
              left: box.x,
              top: box.y,
              width: box.width,
              height: box.height,
              borderColor: big ? "var(--color-accent)" : "rgba(255,255,255,0.5)",
            }}
          >
            <span className="absolute -bottom-7 left-0 rounded-md bg-black/70 px-2 py-0.5 font-mono text-[12px] whitespace-nowrap text-white tabular-nums">
              {Math.round(box.width)} × {Math.round(box.height)}
            </span>
          </div>
        </>
      ) : (
        <Shade style={{ inset: 0 }} />
      )}

      <div className="pointer-events-none absolute top-8 left-1/2 -translate-x-1/2 rounded-xl bg-black/75 px-4 py-2.5 text-center shadow-lg">
        <p className="text-[13.5px] font-medium text-white">{title}</p>
        <p className="mt-0.5 text-[11.5px] text-white/60">{hint}</p>
        {/* The prompt itself ignores the pointer so a drag can start on top of
            it; anything put here has to take it back. */}
        {extra && <div className="pointer-events-auto mt-2">{extra}</div>}
      </div>
    </div>
  );
}

function Shade({ style }: { style: React.CSSProperties }) {
  return <div className="absolute bg-black/40" style={style} />;
}
