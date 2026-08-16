import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { measurableElement, placeAgainst } from "./anchor";

interface Props {
  /** The control that opens the popover. Receives open state for styling. */
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  /**
   * Panel contents. Given as a function when the contents need to dismiss the
   * popover themselves — a menu of one-shot actions has to close on choice,
   * and the outside-click handler deliberately ignores clicks within the panel.
   */
  children: ReactNode | ((props: { close: () => void }) => ReactNode);
  /** Horizontal alignment relative to the trigger. */
  align?: "start" | "center";
}

/**
 * Click-to-open panel anchored under its trigger.
 *
 * Rendered in a portal so a toolbar's `overflow` can never clip it, and
 * clamped to the viewport so a panel near the window edge stays fully visible.
 */
export function Popover({ trigger, children, align = "center" }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }

    const el = measurableElement(anchor.current);
    if (!el) return;

    // The panel is already mounted (off-screen at -9999), so it can be measured
    // before being placed.
    const place = () =>
      setPos(
        placeAgainst(
          el.getBoundingClientRect(),
          { width: panel.current?.offsetWidth ?? 220, height: panel.current?.offsetHeight ?? 180 },
          align,
        ),
      );

    place();

    // Measuring once is not enough for a panel that fills in after it opens.
    // The palette sits at the bottom of the window, so placement is really the
    // decision to flip above the trigger — made on the panel's height, which
    // for a menu still fetching its contents is the height of the word
    // "Loading". It then grew downward, off the bottom of the window.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    return () => observer.disconnect();
  }, [open, align]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Stop the editor's global Escape from also clearing the selection.
        e.stopPropagation();
        setOpen(false);
      }
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <>
      <span ref={anchor} className="contents">
        {trigger({ open, toggle: () => setOpen((v) => !v) })}
      </span>

      {open &&
        createPortal(
          <div
            ref={panel}
            className="surface-pop animate-in-pop no-drag fixed z-[9000] rounded-xl p-2.5"
            style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999 }}
          >
            {typeof children === "function" ? children({ close: () => setOpen(false) }) : children}
          </div>,
          document.body,
        )}
    </>
  );
}
