import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { placeAtPoint } from "./anchor";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  /** Destructive actions get danger colouring and sit below a separator. */
  danger?: boolean;
  run: () => void;
}

export type MenuEntry = MenuItem | "separator";

interface Props {
  at: { x: number; y: number };
  /**
   * Entries top to bottom. Falsy entries are dropped rather than rendered, so
   * callers can write `single && {…}` inline; separators are then collapsed,
   * which means an item disappearing never leaves a divider stranded against
   * the edge of the menu or doubled up against another.
   */
  items: (MenuEntry | false | null | undefined)[];
  onClose: () => void;
}

function tidy(entries: (MenuEntry | false | null | undefined)[]): MenuEntry[] {
  const kept = entries.filter((e): e is MenuEntry => Boolean(e));
  return kept.filter(
    (entry, i) =>
      entry !== "separator" ||
      // Not first, not last, and not immediately after another.
      (i > 0 && i < kept.length - 1 && kept[i - 1] !== "separator"),
  );
}

/**
 * Right-click menu, rendered at the cursor.
 *
 * Dismissal leans on pointer-down outside rather than Escape: this webview
 * never delivers Escape to the page (the same reason the library has a visible
 * Clear button and deletion confirms through a native dialog). Escape is wired
 * anyway in case that ever changes, but nothing depends on it.
 */
export function ContextMenu({ at, items, onClose }: Props) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    // Mounted off-screen first so it can be measured before being placed.
    setPos(
      placeAtPoint(at, {
        width: panel.current?.offsetWidth ?? 220,
        height: panel.current?.offsetHeight ?? 160,
      }),
    );
  }, [at]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    // A menu pinned to a point in the document is wrong the moment anything
    // moves underneath it.
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={panel}
      // Tagged so the library's click-to-clear handler ignores it: a React
      // portal still bubbles events through the React tree, so without this a
      // click on "Copy" would also land on the pane behind it.
      data-context-menu
      role="menu"
      className="surface-pop animate-in-pop no-drag fixed z-[9600] min-w-[196px] rounded-xl p-1.5"
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999 }}
    >
      {tidy(items).map((item, i) =>
        item === "separator" ? (
          <div key={`sep-${i}`} className="my-1.5 h-px bg-line" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              item.run();
            }}
            className={clsx(
              "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors",
              item.danger
                ? "text-danger hover:bg-danger/15"
                : "text-ink hover:bg-hover",
            )}
          >
            <span className={item.danger ? "text-danger" : "text-ink-2"}>{item.icon}</span>
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
