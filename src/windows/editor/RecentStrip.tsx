import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { IconChevronDown, IconCopy, IconFolder, IconImage, IconTrash } from "@/components/icons";
import { ContextMenu, type MenuEntry } from "@/components/ui/ContextMenu";
import * as ipc from "@/lib/ipc";
import type { LibraryItem } from "@/lib/types";
import { formatWhen } from "./format";
import { useThumbnail } from "./thumbnails";
import { nouns } from "../../lib/platform";

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
  /** Paths picked for a bulk action, in the order they were listed. */
  selected: string[];
  onSelect: (paths: string[]) => void;
  onOpen: (path: string) => void;
  onCopy: (paths: string[]) => void;
  onDelete: (paths: string[]) => void;
  onError: (message: string) => void;
}

/** How many to show before the first scroll, and how many each batch adds. */
const PAGE = 12;

const COLLAPSED_KEY = "shotly.recentsCollapsed";

export function RecentStrip({
  refreshKey,
  currentPath,
  selected,
  onSelect,
  onOpen,
  onCopy,
  onDelete,
  onError,
}: Props) {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSED_KEY) === "1",
  );
  /** Ticket of the newest listing, so a slow earlier one cannot win. */
  const request = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);
  /** Where a Shift-range counts from. */
  const anchor = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; targets: string[] } | null>(
    null,
  );

  const reload = useCallback(() => {
    const ticket = ++request.current;
    void ipc
      .listLibrary()
      .then((next) => {
        // Stills only. This rail sits beside the editor and everything in it
        // is one click from being annotated; a recording can be neither, and a
        // row that cannot do what every other row does is a row that looks
        // broken. Recordings live in the library grid, which knows to play them.
        if (ticket === request.current) setItems(next.filter((item) => !item.video));
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

  /**
   * Finder's selection model, with one deliberate departure: **a plain click
   * opens.**
   *
   * The rail sits beside the canvas and exists to move between captures — that
   * is the whole of what it is for, and asking for two clicks to do the only
   * thing it does was a tax on the common case. The library grid keeps
   * double-click, because there a click means "pick this one" for a Copy or a
   * Delete that acts on several.
   *
   * The selection this rail can hold is still reachable: ⌘ toggles one and ⇧
   * extends a range, neither of which opens anything, so "these three, delete"
   * still works.
   */
  const choose = (item: LibraryItem, modifiers: { meta: boolean; shift: boolean }) => {
    const paths = (items ?? []).slice(0, shown).map((i) => i.path);

    if (modifiers.meta) {
      anchor.current = item.path;
      onSelect(
        selected.includes(item.path)
          ? selected.filter((p) => p !== item.path)
          : [...selected, item.path],
      );
      return;
    }

    if (modifiers.shift && anchor.current) {
      const from = paths.indexOf(anchor.current);
      const to = paths.indexOf(item.path);
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        onSelect(paths.slice(lo, hi + 1));
        return;
      }
    }

    anchor.current = item.path;
    onSelect([item.path]);
    // Opening is deliberately last: `onOpen` may refuse — it asks before
    // discarding unsaved annotations — and the click should still have moved
    // the selection either way.
    onOpen(item.path);
  };

  /**
   * Right-click, with Finder's rule: a capture already in the selection opens a
   * menu for the whole selection, one outside it takes over the selection
   * first. Without that rule the right-click needed to reach the menu would
   * throw away the very selection the menu is there to act on.
   */
  const openMenu = (item: LibraryItem, at: { x: number; y: number }) => {
    const inSelection = selected.includes(item.path);
    if (!inSelection) {
      anchor.current = item.path;
      onSelect([item.path]);
    }
    setMenu({ at, targets: inSelection ? selected : [item.path] });
  };

  const menuItems = (targets: string[]): (MenuEntry | false)[] => {
    const many = targets.length > 1;
    return [
      // One editor pane, and revealing several would spray Finder windows
      // across the screen — so both are single-capture actions.
      !many && { label: "Open", icon: <IconImage />, run: () => onOpen(targets[0]) },
      {
        label: many ? `Copy ${targets.length} captures` : "Copy",
        icon: <IconCopy />,
        run: () => onCopy(targets),
      },
      !many && {
        label: nouns.reveal,
        icon: <IconFolder />,
        run: () => void ipc.revealInFinder(targets[0]),
      },
      "separator" as const,
      {
        label: many ? nouns.trashMany(targets.length) : nouns.trash,
        icon: <IconTrash />,
        danger: true,
        run: () => onDelete(targets),
      },
    ];
  };

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
              selected={selected.includes(item.path)}
              onChoose={choose}
              onOpen={onOpen}
              onMenu={openMenu}
            />
          ))}
        </ul>
        <div ref={sentinel} aria-hidden="true" className="h-px" />
      </div>

      {menu && (
        <ContextMenu at={menu.at} items={menuItems(menu.targets)} onClose={() => setMenu(null)} />
      )}
    </aside>
  );
}

function RecentRow({
  item,
  active,
  selected,
  onChoose,
  onOpen,
  onMenu,
}: {
  item: LibraryItem;
  /** The capture currently open in the editor. */
  active: boolean;
  /** Picked for a bulk action, which is a different thing from being open. */
  selected: boolean;
  onChoose: (item: LibraryItem, modifiers: { meta: boolean; shift: boolean }) => void;
  onOpen: (path: string) => void;
  onMenu: (item: LibraryItem, at: { x: number; y: number }) => void;
}) {
  const { url, failed } = useThumbnail(item.path, item.modified, item.cloud);
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
        aria-selected={selected}
        onClick={(e) => onChoose(item, { meta: e.metaKey, shift: e.shiftKey })}
        // A second click lands on a capture that is already open, where opening
        // it again is a no-op — but leaving this here means an impatient
        // double-click is never swallowed.
        onDoubleClick={() => onOpen(item.path)}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(item, { x: e.clientX, y: e.clientY });
        }}
        title={item.name}
        className={clsx(
          "block w-full overflow-hidden rounded-lg border text-left transition-colors duration-100",
          // Selected and open are different states and have to look different:
          // the open capture is where you are, a selection is what a delete
          // would take. A ring says picked; the accent border says you are here.
          selected
            ? "border-accent bg-raised ring-2 ring-accent"
            : active
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
