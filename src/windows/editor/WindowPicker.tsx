import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { IconClose, IconWindow } from "@/components/icons";
import { IconButton } from "@/components/ui/IconButton";
import * as ipc from "@/lib/ipc";
import type { WindowInfo } from "@/lib/types";

/**
 * Choose a window to capture, by looking at it.
 *
 * This replaces the red outline that used to follow the pointer during
 * `screencapture -i -w`. That outline read the window list and framed the
 * topmost entry under the cursor — and the window list contains windows that
 * report themselves frontmost and on screen while not being drawn anywhere.
 * Nothing in their metadata gives them away, so the outline could point
 * confidently at a window nobody could see. See `docs/DEVELOPING.md`.
 *
 * A picture cannot lie in the same way. Every window is shown as it actually
 * is, taken from its own backing store, so a phantom is simply an entry whose
 * thumbnail you don't recognise — and you pick a different one. It also gets
 * you windows the pointer could never reach: behind others, on another Space,
 * or fully covered.
 *
 * An ordinary panel rather than an overlay, deliberately. Capturing by window
 * id photographs the window itself, so Shotly's own window sitting in front of
 * the target is irrelevant — which means none of the full-screen always-on-top
 * machinery, and none of its risks, is needed here at all.
 */

/** Ignore windows smaller than this; they are helper panels, not documents. */
const MIN_EDGE = 80;

export function WindowPicker({
  onCapture,
  onClose,
  onError,
}: {
  onCapture: (id: number) => void;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [windows, setWindows] = useState<WindowInfo[] | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void ipc
      .listWindows()
      .then((all) =>
        setWindows(
          all.filter((w) => w.bounds.width >= MIN_EDGE && w.bounds.height >= MIN_EDGE),
        ),
      )
      .catch((e) => {
        onError(`Could not list windows: ${e}`);
        onClose();
      });
  }, [onClose, onError]);

  useEffect(() => search.current?.focus(), [windows]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!windows) return [];
    if (!q) return windows;
    return windows.filter(
      (w) =>
        w.appName.toLowerCase().includes(q) || w.title.toLowerCase().includes(q),
    );
  }, [windows, query]);

  // Keep the highlight inside the list as it filters down.
  useEffect(() => setActive((i) => Math.min(i, Math.max(0, shown.length - 1))), [shown.length]);

  const take = useCallback(
    (w: WindowInfo) => {
      // A full-screen window is not capturable by id: macOS hands back its
      // drop shadow and an empty middle. Since such a window *is* the whole
      // display, Capture Screen is the thing that actually works.
      if (w.fullScreen) {
        onError(`${w.appName} is full screen — capture it with Capture Screen (⌃⇧3).`);
        return;
      }
      onCapture(w.id);
    },
    [onCapture, onError],
  );

  // Escape is hung on the window as well as on the panel: WKWebView has its
  // own handling for that key and can eat it before a bubbled React handler
  // ever runs — the same reason the annotation layer listens twice for it.
  useEffect(() => {
    const bail = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", bail, { capture: true });
    window.addEventListener("keyup", bail, { capture: true });
    return () => {
      window.removeEventListener("keydown", bail, { capture: true });
      window.removeEventListener("keyup", bail, { capture: true });
    };
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      setActive((i) => (i + 1) % Math.max(1, shown.length));
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      setActive((i) => (i - 1 + shown.length) % Math.max(1, shown.length));
    } else if (e.key === "Enter" && shown[active]) {
      e.preventDefault();
      take(shown[active]);
    }
  };

  return (
    <div
      className="animate-in-fade fixed inset-0 z-[8000] flex items-center justify-center bg-black/50 p-8"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={onKeyDown}
    >
      <div
        className="surface-pop animate-in-pop flex max-h-full w-[min(760px,95vw)] flex-col overflow-hidden rounded-2xl"
        role="dialog"
        aria-label="Choose a window"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-white/8 px-4 py-3">
          <h2 className="shrink-0 text-[14px] font-semibold">Capture a window</h2>
          <input
            ref={search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by app or title…"
            className="h-8 min-w-0 flex-1 rounded-lg bg-black/25 px-2.5 text-[12.5px] text-ink outline-none placeholder:text-ink-4 focus:shadow-[inset_0_0_0_1px_var(--color-accent)]"
          />
          <IconButton icon={<IconClose />} label="Close" onClick={onClose} bare />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {windows === null ? (
            <p className="py-10 text-center text-[12.5px] text-ink-4">Looking…</p>
          ) : shown.length === 0 ? (
            <p className="py-10 text-center text-[12.5px] text-ink-4">
              {query ? "No window matches that." : "No windows to capture."}
            </p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(216px,1fr))] gap-2.5">
              {shown.map((w, i) => (
                <WindowCard
                  key={w.id}
                  window={w}
                  active={i === active}
                  onHover={() => setActive(i)}
                  onChoose={() => take(w)}
                />
              ))}
            </div>
          )}
        </div>

        <p className="shrink-0 border-t border-white/8 px-4 py-2 text-[11px] text-ink-4">
          Windows are shown as they actually are — including ones hidden behind
          others. ↑↓ to move, ⏎ to capture, Esc to cancel.
        </p>
      </div>
    </div>
  );
}

function WindowCard({
  window: w,
  active,
  onHover,
  onChoose,
}: {
  window: WindowInfo;
  active: boolean;
  onHover: () => void;
  onChoose: () => void;
}) {
  const [thumb, setThumb] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const card = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // No picture for a full-screen window: the capture would be its shadow
    // and a transparent hole, which reads as "broken" rather than "can't".
    if (w.fullScreen) return setFailed(true);

    let cancelled = false;
    void ipc
      .windowThumbnail(w.id)
      .then((url) => !cancelled && setThumb(url))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [w.id, w.fullScreen]);

  // Follow the keyboard, so arrowing past the fold scrolls rather than
  // silently moving a highlight nobody can see.
  useEffect(() => {
    if (active) card.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <button
      ref={card}
      type="button"
      onClick={onChoose}
      onPointerEnter={onHover}
      aria-current={active}
      className={clsx(
        "flex flex-col overflow-hidden rounded-xl border bg-surface text-left transition-colors",
        active ? "border-accent bg-raised ring-1 ring-accent/60" : "border-line hover:border-accent/50",
        w.fullScreen && "opacity-60",
      )}
    >
      <div className="grid h-[132px] place-items-center overflow-hidden bg-inset p-1.5 text-center">
        {thumb ? (
          <img
            src={thumb}
            alt=""
            className="max-h-full max-w-full rounded-sm object-contain shadow-[0_1px_6px_rgba(0,0,0,0.5)]"
          />
        ) : w.fullScreen ? (
          <span className="px-3 text-[11px] leading-snug text-ink-4">
            <IconWindow />
            <span className="mt-1 block">
              Full screen — macOS won't hand this one over. Use Capture Screen.
            </span>
          </span>
        ) : (
          <span className="text-ink-4">
            {failed ? <IconWindow /> : <span className="text-[11px]">…</span>}
          </span>
        )}
      </div>
      <div className="min-w-0 border-t border-line-subtle px-2.5 py-1.5">
        <span className="block truncate text-[12.5px] font-medium text-ink">{w.appName}</span>
        <span className="block truncate text-[11px] text-ink-4">
          {w.title || "Untitled"}
          <span className="mx-1">·</span>
          <span className="font-mono tabular-nums">
            {Math.round(w.bounds.width)}×{Math.round(w.bounds.height)}
          </span>
        </span>
      </div>
    </button>
  );
}
