import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SelectionOverlay, type Box } from "@/components/SelectionOverlay";

/**
 * The screen-recording window, in its two lives.
 *
 * It is born covering one display, where the user says what to record — drag
 * out an area, click a window, or take the whole screen. The moment that is
 * settled, Rust shrinks this same window into a small panel at the bottom of
 * the display: elapsed time, and the two ways out. One window for both phases
 * keeps the capability surface to a single label, exactly as in the
 * scrolling-capture overlay this is modelled on.
 *
 * The panel is invisible to the recording itself — see `hide_from_capture` —
 * so it can sit over the very screen being recorded without ending up in it.
 *
 * Two obligations to Rust, both load-bearing:
 *
 *  1. Report `record_ready` as soon as we have painted. Until then the window
 *     is mouse-transparent and clicks pass through, so a selection overlay that
 *     never draws cannot swallow the desktop.
 *  2. Keep sending `record_beat`. Silence means a hung renderer. Note what Rust
 *     does about it, which is the opposite of everywhere else in the app: while
 *     a recording is running, a dead panel *saves* the recording rather than
 *     cancelling it. Losing the panel should cost the last second, not the take.
 */

const HEARTBEAT_MS = 1000;
const MIN_EDGE = 60;

interface Pickable extends Box {
  id: number;
}

interface Running {
  what: string;
  seconds: number;
}

export function RecordApp() {
  const [phase, setPhase] = useState<"select" | "hud">("select");

  useEffect(() => {
    const un = listen<string>("record:phase", (e) => {
      if (e.payload === "hud") setPhase("hud");
    });
    return () => void un.then((fn) => fn());
  }, []);

  // Mounted here rather than in either phase, so the heartbeat survives the
  // handover from overlay to panel — a gap across it would read as a death.
  useEffect(() => {
    // Two frames, so "painted" means the compositor has actually shown
    // something before Rust hands this window the mouse.
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void invoke("record_ready").catch(() => void invoke("record_cancel"));
      }),
    );

    const beat = window.setInterval(() => {
      void invoke("record_beat").catch(() => {});
    }, HEARTBEAT_MS);

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(beat);
    };
  }, []);

  return phase === "select" ? <Select /> : <Panel />;
}

// ------------------------------------------------------------------ selection

function Select() {
  const [windows, setWindows] = useState<Pickable[]>([]);
  const [error, setError] = useState<string | null>(null);

  const cancel = useCallback(() => void invoke("record_cancel"), []);

  useEffect(() => {
    void invoke<Pickable[]>("record_windows")
      .then(setWindows)
      // Snapping is a convenience over the drag, not a precondition for it.
      .catch(() => {});
  }, []);

  const choose = useCallback(
    async (box: Box, windowIndex: number | null) => {
      try {
        // A window is recorded by id, not by the rectangle it happens to
        // occupy: `screencapture -l` follows it if it moves and leaves out
        // anything dropped in front of it.
        if (windowIndex !== null) {
          await invoke("record_window", { windowId: windows[windowIndex].id });
          return;
        }
        // The drag happened in window coordinates; the recording needs global
        // ones. The window covers exactly one display, so it is one offset.
        const display = await invoke<Box>("record_layout");
        await invoke("record_region", {
          region: {
            x: display.x + box.x,
            y: display.y + box.y,
            width: box.width,
            height: box.height,
          },
        });
      } catch (err) {
        setError(String(err));
      }
    },
    [windows],
  );

  return (
    <SelectionOverlay
      windows={windows}
      minEdge={MIN_EDGE}
      title="Click a window, or drag out an area to record"
      hint={error ?? "Esc cancels · the recording is saved to your Shotly folder"}
      extra={
        <button
          type="button"
          onClick={() => void invoke("record_screen").catch((e) => setError(String(e)))}
          className="rounded-lg bg-white/15 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-white/25"
        >
          Record the whole screen
        </button>
      }
      onChoose={({ box, window }) => void choose(box, window)}
      onCancel={cancel}
    />
  );
}

// ---------------------------------------------------------------------- panel

function Panel() {
  const [what, setWhat] = useState("Recording");
  const [seconds, setSeconds] = useState(0);
  const [stopping, setStopping] = useState(false);
  /** Where the clock started, so it cannot drift with the interval. */
  const origin = useRef<{ at: number; from: number }>({ at: Date.now(), from: 0 });

  useEffect(() => {
    const adopt = (r: Running | null) => {
      if (!r) return;
      setWhat(r.what);
      origin.current = { at: Date.now(), from: r.seconds };
      setSeconds(r.seconds);
    };

    // Both, because the panel can open either before the recording starts (the
    // selection overlay becoming this) or after it (the tray's way in, which
    // opens the panel with a recording already running).
    void invoke<Running | null>("record_running").then(adopt).catch(() => {});
    const un = listen<Running>("record:running", (e) => adopt(e.payload));
    return () => void un.then((fn) => fn());
  }, []);

  useEffect(() => {
    const tick = window.setInterval(() => {
      const { at, from } = origin.current;
      setSeconds(from + Math.floor((Date.now() - at) / 1000));
    }, 250);
    return () => window.clearInterval(tick);
  }, []);

  const stop = useCallback(() => {
    // Writing the movie's index takes a moment on a long recording, and a
    // button that does nothing visible for two seconds reads as a broken one.
    setStopping(true);
    void invoke("record_stop").catch(() => setStopping(false));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void invoke("record_cancel");
      if (e.key === "Enter") stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stop]);

  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <div
      data-tauri-drag-region
      className="flex h-screen flex-col justify-between rounded-2xl border border-white/10 bg-surface px-3 py-2.5 shadow-2xl"
    >
      <div className="pointer-events-none flex items-center gap-2">
        <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-danger" />
        <span className="font-mono text-[15px] font-semibold text-ink tabular-nums">{clock}</span>
        <span className="ml-auto max-w-[120px] truncate text-[11px] text-ink-4">{what}</span>
      </div>

      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => void invoke("record_cancel")}
          className="h-7 flex-1 rounded-lg bg-white/[0.07] text-[12px] font-medium text-ink-2 hover:bg-white/[0.11] hover:text-ink"
        >
          Discard
        </button>
        <button
          type="button"
          onClick={stop}
          disabled={stopping}
          className="h-7 flex-[2] rounded-lg bg-danger text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-60"
        >
          {stopping ? "Saving…" : "Stop and save"}
        </button>
      </div>
    </div>
  );
}
