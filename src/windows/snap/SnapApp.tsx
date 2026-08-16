import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * The outline that follows the pointer during window capture.
 *
 * This page decides nothing. Rust asks the accessibility API what is under the
 * cursor, works out which level of it to frame, and sends a rectangle already
 * converted into this window's coordinates; all that happens here is drawing.
 * That split is deliberate — the click is owned by an event tap rather than by
 * this window, so the page cannot be in the input path even by accident. See
 * `src-tauri/src/snap.rs`.
 *
 * The one obligation to Rust is the heartbeat. An outline nobody can see, while
 * a tap is swallowing every click, is the worst state this feature has; so
 * silence here ends the session and gives the mouse back.
 */

const HEARTBEAT_MS = 1000;

/** Height of the caption plus its gap, for deciding whether it fits below. */
const CAPTION_SPACE = 34;

interface Highlight {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  size: string;
  /** How far into the window's contents the outline has been scrolled. */
  level: number;
  /** How many levels there are, or 0 while the outline is on the window. */
  depth: number;
  window: boolean;
}

export function SnapApp() {
  const [target, setTarget] = useState<Highlight | null>(null);

  useEffect(() => {
    // Two frames, so "painted" means the compositor has actually shown
    // something rather than that React has run.
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => void invoke("snap_ready").catch(() => {})),
    );

    const beat = window.setInterval(() => {
      void invoke("snap_beat").catch(() => {});
    }, HEARTBEAT_MS);

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(beat);
    };
  }, []);

  useEffect(() => {
    const un = listen<Highlight | null>("snap:target", (e) => setTarget(e.payload));
    return () => void un.then((fn) => fn());
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 select-none overflow-hidden">
      {target ? <Outline target={target} /> : <div className="absolute inset-0 bg-black/25" />}
      <Hint />
    </div>
  );
}

function Outline({ target }: { target: Highlight }) {
  // The caption sits below the outline, unless that would put it off the
  // bottom of the screen — in which case it goes inside the bottom edge, which
  // is always somewhere it can be read.
  const below = target.y + target.height + CAPTION_SPACE < window.innerHeight;

  return (
    <div
      className="absolute rounded-md border-2 border-accent"
      style={{
        left: target.x,
        top: target.y,
        width: target.width,
        height: target.height,
        // Everything outside the target, dimmed in one stroke. A spread this
        // large covers every display no matter where the outline is.
        boxShadow: "0 0 0 9999px rgba(0,0,0,0.28), inset 0 0 0 1px rgba(255,255,255,0.22)",
        backgroundColor: "rgba(255,107,53,0.06)",
        // Slides between windows instead of teleporting, which is most of why
        // this reads as snapping to something rather than blinking.
        transition:
          "left 90ms cubic-bezier(0.2,0.8,0.2,1), top 90ms cubic-bezier(0.2,0.8,0.2,1), width 90ms cubic-bezier(0.2,0.8,0.2,1), height 90ms cubic-bezier(0.2,0.8,0.2,1)",
      }}
    >
      <span
        className="absolute left-0 flex max-w-full items-center gap-2 overflow-hidden rounded-md bg-black/80 px-2 py-1 text-[12px] whitespace-nowrap text-white shadow-lg"
        style={below ? { top: "100%", marginTop: 6 } : { bottom: 6, left: 6 }}
      >
        <span className="truncate font-medium">{target.label}</span>
        <span className="font-mono text-white/70 tabular-nums">{target.size}</span>
        {target.depth > 0 ? (
          <span className="rounded bg-white/15 px-1.5 py-px text-[11px] text-white/80">
            {target.level + 1} of {target.depth}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function Hint() {
  return (
    <div className="absolute top-8 left-1/2 -translate-x-1/2 rounded-xl bg-black/75 px-4 py-2.5 text-center shadow-lg">
      <p className="text-[13.5px] font-medium text-white">
        Point at a window, then click to capture it
      </p>
      <p className="mt-0.5 text-[11.5px] text-white/60">
        Scroll to tighten onto what's inside · Esc cancels · for a window that's
        hidden behind another, use Capture Window from List in the menu bar
      </p>
    </div>
  );
}
