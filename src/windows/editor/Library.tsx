import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import {
  IconClose,
  IconCopy,
  IconExternal,
  IconFolder,
  IconImage,
  IconLink,
  IconCanvas,
  IconPin,
  IconPlay,
  IconSearch,
  IconTrash,
} from "@/components/icons";
import { ContextMenu, type MenuEntry } from "@/components/ui/ContextMenu";
import { Kbd } from "@/components/ui/Kbd";
import { Tooltip } from "@/components/ui/Tooltip";
import * as ipc from "@/lib/ipc";
import type { LibraryItem } from "@/lib/types";
import { type Scope, groupByDate, inScope, scopeExists } from "./dates";
import { formatDuration, formatSize, formatWhen } from "./format";
import { LibraryFilter } from "./LibraryFilter";
import { useThumbnail } from "./thumbnails";

interface Props {
  onOpen: (path: string) => void;
  /** Watch a recording in Shotly's own player. */
  onPlay: (item: LibraryItem) => void;
  /** Copy captures to the clipboard. Confirms nothing; see `onDelete`. */
  onCopy: (paths: string[]) => void;
  /** Move captures to the Trash. Asks first — this can act on a whole selection. */
  onDelete: (paths: string[]) => void;
  /** Bumping this forces a reload — e.g. after a save. */
  refreshKey: number;
  onError: (message: string) => void;
  /** Shown instead of the grid when nothing has been captured. */
  empty: ReactNode;
  /** Paths of the currently selected captures, in the order they were listed. */
  selected: string[];
  onSelect: (paths: string[]) => void;
  /** Reports the visible order, so ⌘A upstairs can select everything. */
  onItems: (paths: string[]) => void;
  /** Lay several captures out on one canvas and open the result. */
  onCombine: (paths: string[], layout: "row" | "column" | "grid") => void;
  /** Stick one capture to the front of the screen. */
  onPin: (path: string) => void;
  /** Put a Google Drive link to this capture on the clipboard. */
  onShareLink: (path: string) => void;
}

/**
 * Grid of everything in ~/Documents/Shotly.
 *
 * Thumbnails are fetched per card rather than up front, so a large library
 * paints immediately and fills in progressively instead of blocking on a few
 * hundred image decodes.
 */
export function Library({
  onOpen,
  onPlay,
  onCopy,
  onDelete,
  refreshKey,
  onError,
  empty,
  selected,
  onSelect,
  onItems,
  onPin,
  onCombine,
  onShareLink,
}: Props) {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [scope, setScope] = useState<Scope>(null);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  /** Where a Shift-range starts. Cleared by a plain click. */
  const anchor = useRef<string | null>(null);
  /** Ticket of the newest listing, so a slow earlier one can't win. */
  const request = useRef(0);
  /** Open right-click menu: where it is, and what it acts on. */
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; targets: string[] } | null>(
    null,
  );

  const reload = useCallback(() => {
    // Reloads overlap — a focus event and a post-delete refresh can be in
    // flight together — and nothing guarantees they resolve in order. Without
    // this the older listing can land last and put a just-deleted capture
    // back on screen.
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

  // Files can arrive or vanish behind the app's back — saved from elsewhere,
  // deleted in Finder — so re-read whenever the window regains focus.
  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  const groups = useMemo(() => groupByDate(items ?? []), [items]);

  /**
   * What the grid shows: the date scope first, then the search text.
   *
   * The text is matched against the filename, which for Shotly's own captures
   * carries the date — so "08-15" finds a day, and the tree is left to handle
   * the coarser question of which month you were in.
   */
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (items ?? []).filter(
      (item) =>
        inScope(item, scope) && (needle === "" || item.name.toLowerCase().includes(needle)),
    );
  }, [items, scope, query]);

  /** Path to item, so the menu can ask what kind of thing it is acting on. */
  const byPath = useMemo(
    () => new Map((items ?? []).map((item) => [item.path, item])),
    [items],
  );

  // A scope can outlive the captures that made it: delete the last shot of a
  // month and its row disappears from the tree, leaving the grid filtered to
  // nothing by a rule with nothing on screen to explain it.
  useEffect(() => {
    if (!scopeExists(scope, groups)) setScope(null);
  }, [scope, groups]);

  // Tell the parent what's on screen, and drop any selection that isn't. Both
  // halves matter: a capture deleted in Finder, and one filtered out of view —
  // ⌘C acting on captures you can no longer see would be the same surprise
  // either way.
  useEffect(() => {
    if (!items) return;
    const paths = visible.map((i) => i.path);
    onItems(paths);

    const surviving = selected.filter((p) => paths.includes(p));
    if (surviving.length !== selected.length) onSelect(surviving);
    // `selected` is deliberately absent: this reconciles against a *new* list,
    // and re-running whenever the selection changes would fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, visible, onItems, onSelect]);

  // ⌘F reaches the field wherever focus happens to be. Bound here rather than
  // as a global command because the field only exists while this pane does.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "f" || !e.metaKey) return;
      e.preventDefault();
      search.current?.focus();
      search.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /**
   * The per-card trash button deletes straight away.
   *
   * No confirmation on purpose: it acts on the one capture you are pointing at,
   * and the file goes to the Trash rather than being destroyed, so the undo is
   * the Trash itself. The toolbar's Delete does ask, because it acts on a
   * selection you can't see all of at a glance.
   */
  const trash = async (item: LibraryItem) => {
    try {
      await ipc.trashCaptures([item.path]);
      // Drop it locally rather than re-listing, so the grid doesn't flicker.
      setItems((prev) => prev?.filter((i) => i.path !== item.path) ?? prev);
      onSelect(selected.filter((p) => p !== item.path));
    } catch (e) {
      onError(String(e));
    }
  };

  /**
   * Finder's selection model, because that's what a grid of files should do:
   * plain click replaces, ⌘ toggles one, ⇧ extends from the last anchor.
   */
  const choose = (item: LibraryItem, modifiers: { meta: boolean; shift: boolean }) => {
    // Ranges run over what is on screen, so a Shift-click inside March can't
    // quietly take in the captures a filter is hiding between the two ends.
    const paths = visible.map((i) => i.path);

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
  };

  /**
   * Right-click, with Finder's rule: a capture already in the selection opens a
   * menu for the whole selection, one outside it takes over the selection first.
   *
   * That rule is what makes "delete these three" possible — without it, the
   * right-click needed to reach the menu would have thrown the selection away
   * before the menu could act on it.
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
    // Everything below the Open line is picture work — annotating, copying an
    // image to the clipboard, laying several out on one canvas, pinning one to
    // the screen. A movie can do none of it, so a selection containing one
    // offers only what applies to it.
    const videos = targets.filter((p) => byPath.get(p)?.video);
    const anyVideo = videos.length > 0;
    const allVideo = videos.length === targets.length;

    return [
      // Open and Reveal are single-capture actions: there is one editor pane,
      // and revealing several would spray Finder windows across the screen.
      !many && {
        label: allVideo ? "Play" : "Open",
        icon: allVideo ? <IconPlay /> : <IconImage />,
        run: () => {
          const item = byPath.get(targets[0]);
          if (allVideo && item) onPlay(item);
          else onOpen(targets[0]);
        },
      },
      // Shotly plays it in its own pane; this is for when you want the movie
      // somewhere it can be trimmed, shared, or watched full screen.
      !many && allVideo && {
        label: "Open in the movie player",
        icon: <IconExternal />,
        run: () => void ipc.openExternally(targets[0]),
      },
      !anyVideo && {
        label: many ? `Copy ${targets.length} captures` : "Copy",
        icon: <IconCopy />,
        run: () => onCopy(targets),
      },
      // Only with something to combine *with*. The submenu is the layout,
      // because "side by side" and "stacked" are different enough answers
      // that guessing one would be wrong half the time.
      many && !anyVideo && "separator" as const,
      many && !anyVideo && {
        label: `Combine ${targets.length} side by side`,
        icon: <IconCanvas />,
        run: () => onCombine(targets, "row"),
      },
      many && !anyVideo && {
        label: `Combine ${targets.length} stacked`,
        icon: <IconCanvas />,
        run: () => onCombine(targets, "column"),
      },
      many && !anyVideo && targets.length > 2 && {
        label: `Combine ${targets.length} as a grid`,
        icon: <IconCanvas />,
        run: () => onCombine(targets, "grid"),
      },
      many && "separator" as const,
      // One at a time: pinning a selection of twelve would bury the screen
      // under the very thing the pins are meant to sit beside.
      !many && !anyVideo && {
        label: "Pin to screen",
        icon: <IconPin />,
        run: () => void onPin(targets[0]),
      },
      !many && {
        label: "Show in Finder",
        icon: <IconFolder />,
        run: () => void ipc.revealInFinder(targets[0]),
      },
      // The point of a link rather than the file itself: a recording is
      // hundreds of megabytes, and nobody wants that in their inbox.
      !many && {
        label: "Copy Drive link",
        icon: <IconLink />,
        run: () => onShareLink(targets[0]),
      },
      "separator" as const,
      {
        label: many ? `Move ${targets.length} captures to Trash` : "Move to Trash",
        icon: <IconTrash />,
        danger: true,
        run: () => onDelete(targets),
      },
    ];
  };

  // `null` is "not read yet" — rendering the empty hero here would flash it on
  // every visit to a library that turns out to be full.
  if (items === null) return null;

  if (items.length === 0) return <>{empty}</>;

  const filtered = scope !== null || query.trim() !== "";

  const clearFilters = () => {
    setScope(null);
    setQuery("");
  };

  return (
    <section className="flex w-full max-w-[1292px] gap-6 px-1 pb-8">
      {/* Sticky rather than in its own scroller: the pane scrolls as one
          column, and the tree has to stay reachable from the foot of a long
          library without turning the page into two competing scroll areas. */}
      <aside className="sticky top-0 hidden w-[168px] shrink-0 self-start pt-1 md:block">
        <LibraryFilter groups={groups} total={items.length} scope={scope} onScope={setScope} />
      </aside>

      <div className="min-w-0 flex-1">
        <header className="mb-3 flex items-center justify-between gap-4">
          <h2 className="shrink-0 text-[12px] font-semibold tracking-wider text-ink-4 uppercase">
            Library
            <span className="ml-2 font-sans text-[11px] tracking-normal normal-case text-ink-4">
              {/* Under a filter, the total is the number worth knowing — "12 of
                  164" answers both "what am I looking at" and "how much is
                  hidden" in one line. */}
              {filtered
                ? `${visible.length} of ${items.length}`
                : `${items.length} ${items.length === 1 ? "capture" : "captures"}`}
            </span>
          </h2>

          <div className="flex min-w-0 items-center gap-3">
            <p className="flex shrink-0 items-center font-sans text-[11px] text-ink-4">
              {selected.length > 0 ? (
                <>
                  {selected.length} selected
                  <span className="mx-1.5">·</span>
                  {/* An explicit control rather than relying on Escape, which
                      this webview swallows before the page ever sees it. */}
                  <button
                    type="button"
                    onClick={() => onSelect([])}
                    className="rounded px-1 text-ink-3 underline decoration-dotted underline-offset-2 hover:text-ink"
                  >
                    Clear
                  </button>
                </>
              ) : (
                "Click to select · double-click to open"
              )}
            </p>

            <div className="relative w-[184px] shrink-0">
              <IconSearch className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-ink-4" />
              <input
                ref={search}
                // Deliberately not type="search": macOS gives that one a menu
                // of everything previously typed into it, which turns a filter
                // box into a small history of what you went looking for.
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                aria-label="Search captures by name"
                className="h-7 w-full rounded-lg border border-line bg-surface pr-9 pl-7 text-[12px] text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none"
              />
              {/* The key that reaches the field, shown on the field itself —
                  there is no command palette entry to carry it, because the
                  field only exists while this pane does. */}
              {query === "" ? (
                <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">
                  <Kbd shortcut="Mod+F" muted />
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    search.current?.focus();
                  }}
                  aria-label="Clear search"
                  className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded text-ink-4 hover:bg-hover hover:text-ink"
                >
                  <IconClose className="size-3" />
                </button>
              )}
            </div>
          </div>
        </header>

        {visible.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line py-10 text-center text-[12px] text-ink-4">
            No captures match.
            <button
              type="button"
              onClick={clearFilters}
              className="ml-1.5 rounded px-1 text-ink-3 underline decoration-dotted underline-offset-2 hover:text-ink"
            >
              Show all
            </button>
          </p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
            {visible.map((item) => (
              <LibraryCard
                key={item.path}
                item={item}
                selected={selected.includes(item.path)}
                onChoose={choose}
                onOpen={onOpen}
                onPlay={onPlay}
                onTrash={trash}
                onMenu={openMenu}
              />
            ))}
          </ul>
        )}
      </div>

      {menu && (
        <ContextMenu at={menu.at} items={menuItems(menu.targets)} onClose={() => setMenu(null)} />
      )}
    </section>
  );
}

function LibraryCard({
  item,
  selected,
  onChoose,
  onOpen,
  onPlay,
  onTrash,
  onMenu,
}: {
  item: LibraryItem;
  selected: boolean;
  onChoose: (item: LibraryItem, modifiers: { meta: boolean; shift: boolean }) => void;
  onOpen: (path: string) => void;
  onPlay: (item: LibraryItem) => void;
  onTrash: (item: LibraryItem) => void;
  onMenu: (item: LibraryItem, at: { x: number; y: number }) => void;
}) {
  const { url: thumb, failed } = useThumbnail(item.path, item.modified, item.cloud);
  // Double-click means "open this" whichever kind it is; a still goes to the
  // editor and a recording to the player, and neither leaves the app.
  const open = () => (item.video ? onPlay(item) : onOpen(item.path));

  return (
    // Tagged so a click anywhere else in the pane can clear the selection.
    // The context handler sits on the whole card rather than the button, so
    // right-clicking the hover actions in the corner opens the menu too.
    <li
      data-capture-card
      className="group relative"
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(item, { x: e.clientX, y: e.clientY });
      }}
    >
      <button
        type="button"
        aria-pressed={selected}
        onClick={(e) => onChoose(item, { meta: e.metaKey, shift: e.shiftKey })}
        onDoubleClick={open}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            open();
          }
        }}
        className={clsx(
          "block w-full overflow-hidden rounded-xl border bg-surface text-left transition-colors duration-100 focus-visible:border-accent",
          selected
            ? "border-accent bg-raised ring-1 ring-accent/60"
            : "border-line hover:border-accent/50 hover:bg-raised",
        )}
      >
        <div className="relative grid h-[124px] place-items-center overflow-hidden bg-inset">
          {thumb && !failed ? (
            <img
              src={thumb}
              alt=""
              draggable={false}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <span className="px-3 text-center text-[11px] text-ink-4">
              {item.cloud ? "In the cloud" : failed ? "Unreadable" : ""}
            </span>
          )}

          {/* A recording's poster frame is just a screenshot of the screen —
              nothing about it says "this one moves". The badge does, and it
              doubles as the hint that double-clicking will play it. */}
          {item.video && (
            <span className="pointer-events-none absolute inset-0 grid place-items-center">
              <span className="grid size-9 place-items-center rounded-full bg-black/55 text-white shadow-lg backdrop-blur-[2px]">
                <IconPlay />
              </span>
            </span>
          )}
        </div>

        <div className="px-2.5 py-2">
          <p className="truncate text-[12px] font-medium text-ink" title={item.name}>
            {item.name.replace(/\.(png|jpe?g|mov|mp4|m4v)$/i, "")}
          </p>
          {/* Never wraps: the sidebar took width off the cards, and a metadata
              line that folds onto a second row makes the grid ragged. */}
          <p className="mt-0.5 truncate font-mono text-[10.5px] tabular-nums text-ink-4">
            {item.cloud
              ? "Not downloaded"
              : item.video && item.seconds > 0
                ? formatDuration(item.seconds)
                : `${item.width} × ${item.height}`}
            <span className="mx-1.5">·</span>
            {formatSize(item.size)}
            <span className="mx-1.5">·</span>
            {formatWhen(item.modified)}
          </p>
        </div>
      </button>

      {/* Row actions stay hidden until hover so the grid reads as images. */}
      <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 transition-opacity duration-100 group-hover:opacity-100 focus-within:opacity-100">
        <Tooltip label="Show in Finder">
          <button
            type="button"
            onClick={() => void ipc.revealInFinder(item.path)}
            aria-label="Show in Finder"
            className="grid size-6 place-items-center rounded-md bg-black/65 text-ink-2 backdrop-blur hover:text-ink"
          >
            <IconFolder />
          </button>
        </Tooltip>
        <Tooltip label="Move to Trash">
          <button
            type="button"
            onClick={() => void onTrash(item)}
            aria-label="Move to Trash"
            className="grid size-6 place-items-center rounded-md bg-black/65 text-ink-2 backdrop-blur hover:text-danger"
          >
            <IconTrash />
          </button>
        </Tooltip>
      </div>
    </li>
  );
}

