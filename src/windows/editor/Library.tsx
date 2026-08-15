import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { IconCopy, IconFolder, IconImage, IconTrash } from "@/components/icons";
import { ContextMenu, type MenuEntry } from "@/components/ui/ContextMenu";
import { Tooltip } from "@/components/ui/Tooltip";
import * as ipc from "@/lib/ipc";
import type { LibraryItem } from "@/lib/types";

interface Props {
  onOpen: (path: string) => void;
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
  onCopy,
  onDelete,
  refreshKey,
  onError,
  empty,
  selected,
  onSelect,
  onItems,
}: Props) {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
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

  // Tell the parent what's on screen, and drop any selection that refers to a
  // file which has since disappeared.
  useEffect(() => {
    if (!items) return;
    const paths = items.map((i) => i.path);
    onItems(paths);

    const surviving = selected.filter((p) => paths.includes(p));
    if (surviving.length !== selected.length) onSelect(surviving);
    // `selected` is deliberately absent: this reconciles against a *new* list,
    // and re-running whenever the selection changes would fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, onItems, onSelect]);

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
    const paths = items?.map((i) => i.path) ?? [];

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
    return [
      // Open and Reveal are single-capture actions: there is one editor pane,
      // and revealing several would spray Finder windows across the screen.
      !many && { label: "Open", icon: <IconImage />, run: () => onOpen(targets[0]) },
      {
        label: many ? `Copy ${targets.length} captures` : "Copy",
        icon: <IconCopy />,
        run: () => onCopy(targets),
      },
      !many && {
        label: "Show in Finder",
        icon: <IconFolder />,
        run: () => void ipc.revealInFinder(targets[0]),
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

  return (
    <section className="w-full max-w-[1100px] px-1 pb-8">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[12px] font-semibold tracking-wider text-ink-4 uppercase">
          Library
          <span className="ml-2 font-sans text-[11px] tracking-normal normal-case text-ink-4">
            {items.length} {items.length === 1 ? "capture" : "captures"}
          </span>
        </h2>
        <p className="flex items-center font-sans text-[11px] text-ink-4">
          {selected.length > 0 ? (
            <>
              {selected.length} selected
              <span className="mx-1.5">·</span>
              {/* An explicit control rather than relying on Escape, which this
                  webview swallows before the page ever sees it. */}
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
      </header>

      <ul className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
        {items.map((item) => (
          <LibraryCard
            key={item.path}
            item={item}
            selected={selected.includes(item.path)}
            onChoose={choose}
            onOpen={onOpen}
            onTrash={trash}
            onMenu={openMenu}
          />
        ))}
      </ul>

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
  onTrash,
  onMenu,
}: {
  item: LibraryItem;
  selected: boolean;
  onChoose: (item: LibraryItem, modifiers: { meta: boolean; shift: boolean }) => void;
  onOpen: (path: string) => void;
  onTrash: (item: LibraryItem) => void;
  onMenu: (item: LibraryItem, at: { x: number; y: number }) => void;
}) {
  const [thumb, setThumb] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void ipc
      .libraryThumbnail(item.path)
      .then((p) => !cancelled && setThumb(ipc.assetUrl(p)))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
    // `modified` matters as much as the path: the thumbnail cache is keyed on
    // mtime, so re-saving a capture yields a *new* thumbnail file. Without this
    // the card keeps showing the version from before you annotated it.
  }, [item.path, item.modified]);

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
        onDoubleClick={() => onOpen(item.path)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onOpen(item.path);
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
            <span className="text-[11px] text-ink-4">{failed ? "Unreadable" : ""}</span>
          )}
        </div>

        <div className="px-2.5 py-2">
          <p className="truncate text-[12px] font-medium text-ink" title={item.name}>
            {item.name.replace(/\.(png|jpe?g)$/i, "")}
          </p>
          <p className="mt-0.5 font-mono text-[10.5px] tabular-nums text-ink-4">
            {item.width} × {item.height}
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatWhen(ms: number): string {
  if (!ms) return "";
  const date = new Date(ms);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();

  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  const thisYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(thisYear ? {} : { year: "numeric" }),
  });
}
