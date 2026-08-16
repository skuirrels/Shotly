import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { IconChevronDown } from "@/components/icons";
import * as ipc from "@/lib/ipc";
import type { LibraryItem } from "@/lib/types";
import { formatWhen } from "./format";
import { useThumbnail } from "./thumbnails";

/**
 * Recent captures, alongside the one being edited.
 *
 * Newest first, which the library listing already is — and because saving
 * rewrites the file, a capture you have just annotated returns to the top on
 * its own. So the rail reads as "what I have been working on" rather than
 * strictly "what I have shot".
 */

interface Props {
  /** Bumped to force a re-read: after a save, a capture, a delete. */
  refreshKey: number;
  /** The capture on screen, so the rail can mark where you are. */
  currentPath?: string;
  onOpen: (path: string) => void;
  onError: (message: string) => void;
}

/** How many to show before the first scroll, and how many each batch adds. */
const PAGE = 12;

const COLLAPSED_KEY = "shotly.recentsCollapsed";

export function RecentStrip({ refreshKey, currentPath, onOpen, onError }: Props) {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSED_KEY) === "1",
  );
  /** Ticket of the newest listing, so a slow earlier one cannot win. */
  const request = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);

  const reload = useCallback(() => {
    const ticket = ++request.current;
    void ipc
      .listLibrary()
      .then((next) => {
        if (ticket === request.current) setItems(next);
      })
      .catch((e) => {
        if (ticket !== request.current) return;
        setItems([]);
        onError(`Could not read the library: ${e}`);
      });
  }, [onError]);

  useEffect(reload, [reload, refreshKey]);

  // Captures can arrive behind the app's back — saved from elsewhere, deleted
  // in Finder — so re-read whenever the window comes back.
  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  /**
   * Grow the list as its foot comes into view.
   *
   * The listing itself is one call and already in hand; what this defers is a
   * thumbnail decode per row, which is the part that costs something on a
   * library of a few hundred.
   */
  useEffect(() => {
    const foot = sentinel.current;
    if (!foot || collapsed) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setShown((n) => n + PAGE);
      },
      { root: foot.closest("[data-recents-scroll]"), rootMargin: "200px" },
    );
    observer.observe(foot);
    return () => observer.disconnect();
  }, [collapsed, items]);

  const toggle = () => {
    setCollapsed((was) => {
      const next = !was;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // A full or disabled store costs the memory of this preference and
        // nothing else.
      }
      return next;
    });
  };

  if (collapsed) {
    return (
      <div className="flex w-8 shrink-0 justify-center border-r border-line bg-surface pt-3">
        <button
          type="button"
          onClick={toggle}
          title="Show recent captures"
          aria-label="Show recent captures"
          className="grid size-6 place-items-center rounded-md text-ink-4 hover:bg-hover hover:text-ink"
        >
          <IconChevronDown className="-rotate-90" />
        </button>
      </div>
    );
  }

  // Nothing to show and nothing to say: an empty rail beside an open capture
  // would be chrome explaining that there is no chrome.
  if (items !== null && items.length === 0) return null;

  return (
    <aside className="flex w-[172px] shrink-0 flex-col border-r border-line bg-surface">
      <header className="flex items-center justify-between px-3 pt-3 pb-2">
        <h2 className="text-[11px] font-semibold tracking-wider text-ink-4 uppercase">Recent</h2>
        <button
          type="button"
          onClick={toggle}
          title="Hide recent captures"
          aria-label="Hide recent captures"
          className="grid size-5 place-items-center rounded text-ink-4 hover:bg-hover hover:text-ink"
        >
          <IconChevronDown className="rotate-90" />
        </button>
      </header>

      <div data-recents-scroll className="flex-1 overflow-y-auto px-2 pb-3">
        <ul className="flex flex-col gap-1.5">
          {(items ?? []).slice(0, shown).map((item) => (
            <RecentRow
              key={item.path}
              item={item}
              active={item.path === currentPath}
              onOpen={onOpen}
            />
          ))}
        </ul>
        <div ref={sentinel} aria-hidden="true" className="h-px" />
      </div>
    </aside>
  );
}

function RecentRow({
  item,
  active,
  onOpen,
}: {
  item: LibraryItem;
  active: boolean;
  onOpen: (path: string) => void;
}) {
  const { url, failed } = useThumbnail(item.path, item.modified);
  const row = useRef<HTMLButtonElement>(null);

  // Follow the document: opening a capture from anywhere else — ⌘O, a fresh
  // shot, the library grid — should leave the rail showing where you are.
  useEffect(() => {
    if (active) row.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <li>
      <button
        ref={row}
        type="button"
        aria-current={active}
        onClick={() => onOpen(item.path)}
        title={item.name}
        className={clsx(
          "block w-full overflow-hidden rounded-lg border text-left transition-colors duration-100",
          active
            ? "border-accent bg-raised ring-1 ring-accent/50"
            : "border-line hover:border-accent/50 hover:bg-raised",
        )}
      >
        <div className="grid h-[86px] place-items-center overflow-hidden bg-inset">
          {url && !failed ? (
            <img
              src={url}
              alt=""
              draggable={false}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <span className="text-[10px] text-ink-4">{failed ? "Unreadable" : ""}</span>
          )}
        </div>
        <p className="truncate px-2 pt-1.5 font-mono text-[10px] tabular-nums text-ink-3">
          {formatWhen(item.modified)}
          <span className="mx-1">·</span>
          {item.width} × {item.height}
        </p>
      </button>
    </li>
  );
}
