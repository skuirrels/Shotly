import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * The scrolling-capture window, in its two lives.
 *
 * It is born covering the whole display, where the user drags out the region
 * to capture. The moment the drag ends, Rust shrinks this same window into a
 * small floating panel beside the region — the HUD — which narrates the
 * session: how much page has been stitched, a live thumbnail of it, and the
 * two ways out. One window for both phases keeps the capability surface to a
 * single label.
 *
 * The user does the scrolling; Shotly only watches. That is a feature — no
 * Accessibility permission, no guessing at how any given app scrolls — and it
 * is why the HUD's job is narration. The one thing the user cannot otherwise
 * see is whether the stitcher is keeping up.
 *
 * Two obligations to Rust, both load-bearing — the selection phase is a
 * full-screen window that accepts the mouse, so a rendering failure here would
 * cover the desktop in an invisible click target:
 *
 *  1. Report `scroll_ready` as soon as we have painted. Until then the window
 *     is mouse-transparent and clicks pass through.
 *  2. Keep sending `scroll_beat`. If these stop, Rust tears the session down —
 *     a hung renderer cannot report that it hung, so silence is the signal.
 *     This matters just as much once we are the HUD: the capture loop only
 *     stops when this page asks it to.
 */

const HEARTBEAT_MS = 1000;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Progress {
  frames: number;
  height: number;
  preview?: string;
  stalled: boolean;
}

const MIN_EDGE = 60;

export function ScrollApp() {
  const [phase, setPhase] = useState<"select" | "hud">("select");

  useEffect(() => {
    const un = listen<string>("scroll:phase", (e) => {
      if (e.payload === "hud") setPhase("hud");
    });
    return () => void un.then((fn) => fn());
  }, []);

  // Mounted here rather than in either phase, so the promise below survives
  // the switch from selection overlay to HUD — that is one window throughout,
  // and a gap in the heartbeat across the handover would read as a death.
  useEffect(() => {
    // Two frames, so "painted" means the compositor has actually shown
    // something before Rust hands this window the mouse.
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void invoke("scroll_ready").catch(() => void invoke("scroll_cancel"));
      }),
    );

    const beat = window.setInterval(() => {
      void invoke("scroll_beat").catch(() => {});
    }, HEARTBEAT_MS);

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(beat);
    };
  }, []);

  return phase === "select" ? <Select /> : <Hud />;
}

// ------------------------------------------------------------------ selection

function Select() {
  const [drag, setDrag] = useState<{ from: { x: number; y: number }; box: Box } | null>(null);

  const cancel = useCallback(() => void invoke("scroll_cancel"), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel]);

  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const from = { x: e.clientX, y: e.clientY };
    setDrag({ from, box: { ...from, width: 0, height: 0 } });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const box = {
      x: Math.min(drag.from.x, e.clientX),
      y: Math.min(drag.from.y, e.clientY),
      width: Math.abs(e.clientX - drag.from.x),
      height: Math.abs(e.clientY - drag.from.y),
    };
    setDrag({ from: drag.from, box });
  };

  const onPointerUp = async () => {
    if (!drag) return;
    const box = drag.box;
    setDrag(null);
    if (box.width < MIN_EDGE || box.height < MIN_EDGE) return;

    try {
      // The drag happened in window coordinates; the capture needs global
      // ones. The window covers exactly one display, so it is one offset.
      const display = await invoke<Box>("scroll_layout");
      await invoke("scroll_start", {
        region: {
          x: display.x + box.x,
          y: display.y + box.y,
          width: box.width,
          height: box.height,
        },
      });
    } catch (err) {
      console.error("could not start the scrolling capture:", err);
      cancel();
    }
  };

  const box = drag?.box ?? null;
  const big = box && box.width >= MIN_EDGE && box.height >= MIN_EDGE;

  return (
    <div
      className="fixed inset-0 cursor-crosshair select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => void onPointerUp()}
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
        <p className="text-[13.5px] font-medium text-white">
          Drag out the area to capture, then scroll the page yourself
        </p>
        <p className="mt-0.5 text-[11.5px] text-white/60">
          Esc cancels · leave room to see the content you'll be scrolling
        </p>
      </div>
    </div>
  );
}

function Shade({ style }: { style: React.CSSProperties }) {
  return <div className="absolute bg-black/40" style={style} />;
}

// ------------------------------------------------------------------------ hud

function Hud() {
  const [progress, setProgress] = useState<Progress | null>(null);
  /** The last thumbnail that arrived; progress events without one keep it. */
  const preview = useRef<string | null>(null);

  useEffect(() => {
    const un = listen<Progress>("scroll:progress", (e) => {
      if (e.payload.preview) preview.current = e.payload.preview;
      setProgress(e.payload);
    });
    return () => void un.then((fn) => fn());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void invoke("scroll_cancel");
      if (e.key === "Enter") void invoke("scroll_finish");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden rounded-2xl border border-white/10 bg-surface shadow-2xl">
      <div
        data-tauri-drag-region
        className="flex shrink-0 items-center justify-between border-b border-white/8 px-3 py-2"
      >
        <span className="pointer-events-none text-[12.5px] font-semibold text-ink">
          Scrolling capture
        </span>
        <span className="pointer-events-none font-mono text-[11px] text-ink-4 tabular-nums">
          {progress ? `${progress.height.toLocaleString()}px` : "…"}
        </span>
      </div>

      {/* The page so far, growing as the user scrolls. Anchored to the bottom
          because that is where the action is: the join they just caused. */}
      <div className="flex min-h-0 flex-1 items-end justify-center overflow-hidden bg-inset p-2">
        {preview.current ? (
          <img
            src={preview.current}
            alt="Captured so far"
            className="max-h-full max-w-full rounded-sm object-contain"
          />
        ) : (
          <p className="self-center px-4 text-center text-[12px] text-ink-4">
            Scroll the content behind the area you chose. Slow and steady
            stitches best.
          </p>
        )}
      </div>

      <div className="shrink-0 border-t border-white/8 px-3 py-2">
        <p className="mb-2 h-[15px] text-[11px] text-ink-4">
          {progress?.stalled
            ? "Lost the thread — scroll back a little so the pictures overlap."
            : progress
              ? `${progress.frames} ${progress.frames === 1 ? "look" : "looks"} so far · keep scrolling`
              : "Starting…"}
        </p>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => void invoke("scroll_cancel")}
            className="h-8 flex-1 rounded-lg bg-white/[0.07] text-[12.5px] font-medium text-ink-2 hover:bg-white/[0.11] hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void invoke("scroll_finish")}
            className="h-8 flex-[2] rounded-lg bg-accent text-[12.5px] font-semibold text-accent-fg hover:bg-accent-hi"
          >
            Done — open it
          </button>
        </div>
      </div>
    </div>
  );
}
