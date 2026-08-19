import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SelectionOverlay, type Box } from "@/components/SelectionOverlay";

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

interface Progress {
  frames: number;
  height: number;
  preview?: string;
  stalled: boolean;
  /** While stalled: the page is on ground already captured, so the way on is
      down rather than back. */
  behind: boolean;
  /** Nothing on screen to capture: the page has gone blank between sections.
      Not a failure — the counter simply has nothing to add. */
  blank: boolean;
  /** The bottom of what has been captured. Sent only while stalled. */
  anchor?: string;
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

/** A window to snap to, with the id that lets Rust photograph it directly. */
interface Snap extends Box {
  id: number;
}

/** The topmost window that wholly contains the area, if any. */
function holder(windows: Snap[], box: Box): Snap | undefined {
  return windows.find(
    (w) =>
      box.x >= w.x - 1 &&
      box.y >= w.y - 1 &&
      box.x + box.width <= w.x + w.width + 1 &&
      box.y + box.height <= w.y + w.height + 1,
  );
}

function Select() {
  /**
   * The windows this selection can snap to, front to back, in this page's own
   * coordinates. Fetched once: nothing can move while the overlay is up.
   */
  const [windows, setWindows] = useState<Snap[]>([]);

  const cancel = useCallback(() => void invoke("scroll_cancel"), []);

  useEffect(() => {
    void invoke<Snap[]>("scroll_windows")
      .then(setWindows)
      // Snapping is a convenience over the drag, not a precondition for it.
      .catch(() => {});
  }, []);

  const choose = useCallback(
    async (box: Box, picked: number | null) => {
      try {
        // The drag happened in window coordinates; the capture needs global
        // ones. The window covers exactly one display, so it is one offset.
        const display = await invoke<Box>("scroll_layout");
        // Which window this is a picture of, if it is a picture of one: the
        // clicked window, or whichever window a free-hand drag landed inside.
        // Naming it lets Rust photograph the window itself, which comes back
        // whole with the panel sitting on top — so a selection that fills the
        // screen is an ordinary capture rather than an impossible one.
        const window = (
          picked === null ? holder(windows, box) : windows[picked]
        )?.id;
        await invoke("scroll_start", {
          region: {
            x: display.x + box.x,
            y: display.y + box.y,
            width: box.width,
            height: box.height,
          },
          window: window ?? null,
        });
      } catch (err) {
        console.error("could not start the scrolling capture:", err);
        cancel();
      }
    },
    [cancel, windows],
  );

  return (
    <SelectionOverlay
      windows={windows}
      minEdge={MIN_EDGE}
      title="Click a window, or drag out an area — then scroll the page yourself"
      hint="Esc cancels · a window is best: the progress panel can sit on top of it"
      onChoose={({ box, window }) => void choose(box, window)}
      onCancel={cancel}
    />
  );
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
          because that is where the action is: the join they just caused.
          While stalled it is replaced by the one thing that fixes it. */}
      <div className="flex min-h-0 flex-1 items-end justify-center overflow-hidden bg-inset p-2">
        {progress?.stalled && progress.anchor ? (
          <div className="flex h-full flex-col justify-center gap-1.5 px-1">
            {/* Both states stopped capturing, but they are not the same
                trouble and the way out of one is the way further into the
                other. Scrolling back over captured page is something people do
                on purpose, so it is told plainly rather than in alarm. */}
            <p
              className={`text-center text-[11.5px] leading-snug ${
                progress.behind ? "text-ink-2" : "text-danger"
              }`}
            >
              {progress.behind
                ? "This is where the capture ended."
                : "Scrolled too fast — nothing is being captured."}
            </p>
            <p className="text-center text-[11px] leading-snug text-ink-3">
              {progress.behind
                ? "Scroll down past it to carry on:"
                : "Scroll back until this is on screen again:"}
            </p>
            {/* A picture of where the capture ends. "Scroll back a little" was
                the old advice and it was wrong as often as right — how far
                back is a thing you can see and not a thing we can phrase. */}
            <img
              src={progress.anchor}
              alt="The bottom of what has been captured"
              className={`w-full rounded-sm ${
                progress.behind
                  ? "shadow-[0_0_0_1px_var(--color-accent)]"
                  : "shadow-[0_0_0_1px_var(--color-danger)]"
              }`}
            />
          </div>
        ) : preview.current ? (
          <img
            src={preview.current}
            alt="Captured so far"
            className="max-h-full max-w-full rounded-sm object-contain"
          />
        ) : (
          <p className="self-center px-4 text-center text-[12px] text-ink-4">
            Scroll the content behind the area you chose. Any speed is fine — it
            will say so if it loses track.
          </p>
        )}
      </div>

      <div className="shrink-0 border-t border-white/8 px-3 py-2">
        {/* One line, always: the panel is 260pt wide and this sits directly
            above the buttons, so a string long enough to wrap lands on top of
            them. Truncation is the guard; keeping the copy short is the fix. */}
        <p className="mb-2 h-[15px] truncate text-[11px] text-ink-4">
          {progress?.stalled
            ? progress.behind
              ? "Waiting for new page below…"
              : "Waiting for the page to reappear…"
            : progress?.blank
              ? "Blank page · nothing to capture here"
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
