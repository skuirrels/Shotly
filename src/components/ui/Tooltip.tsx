import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { measurableElement } from "./anchor";
import { Kbd } from "./Kbd";

type Side = "top" | "bottom";

interface Props {
  label: string;
  shortcut?: string;
  side?: Side;
  children: ReactNode;
}

const OPEN_DELAY = 420;
const GAP = 8;

/**
 * Hover tooltip carrying a label and, when there is one, the shortcut.
 *
 * Pairing them everywhere is deliberate: it's how someone graduates from
 * clicking the toolbar to driving the app from the keyboard.
 */
export function Tooltip({ label, shortcut, side = "bottom", children }: Props) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const trigger = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);

  const close = useCallback(() => {
    window.clearTimeout(timer.current);
    setPos(null);
  }, []);

  const open = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const el = measurableElement(trigger.current);
      if (!el) return;
      const r = el.getBoundingClientRect();

      // Keep the tooltip's centre far enough from the edges that its
      // translate(-50%) can't push it off-screen.
      const MARGIN = 60;
      setPos({
        x: Math.max(MARGIN, Math.min(r.left + r.width / 2, window.innerWidth - MARGIN)),
        y: side === "bottom" ? r.bottom + GAP : r.top - GAP,
      });
    }, OPEN_DELAY);
  }, [side]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Any click means the user has committed to an action; a tooltip lingering
  // over the result is just noise.
  return (
    <>
      <span
        ref={trigger}
        onPointerEnter={open}
        onPointerLeave={close}
        onPointerDown={close}
        className="contents"
      >
        {children}
      </span>

      {pos &&
        createPortal(
          <div
            role="tooltip"
            className="animate-in-fade surface-pop pointer-events-none fixed z-[9999] flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] whitespace-nowrap text-ink"
            style={{
              left: pos.x,
              top: pos.y,
              transform: `translate(-50%, ${side === "bottom" ? "0" : "-100%"})`,
            }}
          >
            {label}
            {shortcut && <Kbd shortcut={shortcut} muted />}
          </div>,
          document.body,
        )}
    </>
  );
}
