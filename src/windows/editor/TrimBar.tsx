import { useCallback, useRef, useState } from "react";
import clsx from "clsx";
import { formatDuration } from "./format";

/**
 * Two marks on a recording's timeline, and what to do about them.
 *
 * The shape Snagit uses, because it is the one people already know: a green
 * handle where the keeper starts, a red one where it ends, everything outside
 * them dimmed. Dragging either handle scrubs the movie to that instant, so you
 * are always looking at the frame you are about to cut on rather than guessing
 * from a time code.
 *
 * The cut itself is in `src-tauri/src/trim.rs`. This only ever produces two
 * numbers.
 */

export interface Range {
  start: number;
  end: number;
}

/**
 * The closest the two handles may get, in seconds.
 *
 * Matches `MIN_SECONDS` in `trim.rs`, which refuses anything shorter. Enforced
 * here as well so the handles simply stop rather than letting someone drag out
 * a selection the Trim button will then reject.
 */
export const MIN_SELECTION = 0.2;

interface TrackProps {
  duration: number;
  /** Where the playhead is, in seconds. */
  time: number;
  range: Range;
  onRange: (range: Range) => void;
  /** Called as a handle moves, so the picture follows it. */
  onSeek: (seconds: number) => void;
}

/**
 * The timeline itself, standing in for the scrubber while a trim is being set.
 *
 * Taller than the scrubber it replaces: three things have to be grabbable in a
 * strip that is otherwise six pixels of decoration, and the extra height is
 * what makes the handles hittable without a steady hand.
 */
export function TrimTrack({ duration, time, range, onRange, onSeek }: TrackProps) {
  const track = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<"start" | "end" | null>(null);

  /** Where a pointer is, in seconds, clamped to the movie. */
  const secondsAt = useCallback(
    (clientX: number) => {
      const box = track.current?.getBoundingClientRect();
      if (!box || box.width <= 0 || duration <= 0) return 0;
      const fraction = (clientX - box.left) / box.width;
      return Math.max(0, Math.min(duration, fraction * duration));
    },
    [duration],
  );

  const percent = (seconds: number) =>
    duration > 0 ? `${Math.max(0, Math.min(100, (seconds / duration) * 100))}%` : "0%";

  const grab = (which: "start" | "end") => (e: React.PointerEvent<HTMLElement>) => {
    // Without this the press falls through to the track below, which would
    // seek — so grabbing a handle would jump the playhead away from it.
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(which);
  };

  const drag = (which: "start" | "end") => (e: React.PointerEvent<HTMLElement>) => {
    if (dragging !== which) return;
    const at = secondsAt(e.clientX);

    // The handles cannot pass each other, and cannot meet: a selection of
    // nothing is not a thing anyone means to drag out.
    const next =
      which === "start"
        ? { start: Math.min(at, range.end - MIN_SELECTION), end: range.end }
        : { start: range.start, end: Math.max(at, range.start + MIN_SELECTION) };

    onRange(next);
    onSeek(which === "start" ? next.start : next.end);
  };

  const release = (e: React.PointerEvent<HTMLElement>) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setDragging(null);
  };

  /** Arrow keys nudge a handle; ⇧ makes it a second, as it does everywhere else. */
  const nudge = (which: "start" | "end") => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 1 : 0.1;
    const delta = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    if (!delta) return;
    e.preventDefault();
    e.stopPropagation();

    const at = (which === "start" ? range.start : range.end) + delta;
    const next =
      which === "start"
        ? { start: Math.max(0, Math.min(at, range.end - MIN_SELECTION)), end: range.end }
        : { start: range.start, end: Math.min(duration, Math.max(at, range.start + MIN_SELECTION)) };

    onRange(next);
    onSeek(which === "start" ? next.start : next.end);
  };

  return (
    <div
      ref={track}
      // Clicking the track seeks, the way the scrubber does. Trimming should
      // not cost you the ability to jump about and look at the recording.
      onPointerDown={(e) => onSeek(secondsAt(e.clientX))}
      className="relative mx-1 h-6 min-w-0 flex-1 cursor-pointer touch-none select-none"
    >
      {/* The strip everything else sits on. */}
      <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-white/10" />

      {/* What is being thrown away, on each side of the selection. */}
      <div
        className="absolute inset-y-0 left-0 rounded-l-md bg-black/45"
        style={{ width: percent(range.start) }}
      />
      <div
        className="absolute inset-y-0 right-0 rounded-r-md bg-black/45"
        style={{ left: percent(range.end) }}
      />

      {/* What is being kept. */}
      <div
        className="absolute inset-y-0 border-y border-accent/60 bg-accent/20"
        style={{ left: percent(range.start), right: `calc(100% - ${percent(range.end)})` }}
      />

      {/* The playhead, so the frame on screen has a place on the timeline. */}
      <div
        className="pointer-events-none absolute inset-y-0 w-px bg-white/90"
        style={{ left: percent(time) }}
      />

      <Handle
        kind="start"
        at={percent(range.start)}
        seconds={range.start}
        dragging={dragging === "start"}
        onPointerDown={grab("start")}
        onPointerMove={drag("start")}
        onPointerUp={release}
        onPointerCancel={release}
        onKeyDown={nudge("start")}
      />
      <Handle
        kind="end"
        at={percent(range.end)}
        seconds={range.end}
        dragging={dragging === "end"}
        onPointerDown={grab("end")}
        onPointerMove={drag("end")}
        onPointerUp={release}
        onPointerCancel={release}
        onKeyDown={nudge("end")}
      />
    </div>
  );
}

/**
 * One end of the selection.
 *
 * Green for the start and red for the end — the colours Snagit uses, which is
 * the only reason to prefer them over the accent: this is a control people
 * arrive already knowing, and recolouring it would cost that.
 */
function Handle({
  kind,
  at,
  seconds,
  dragging,
  ...events
}: {
  kind: "start" | "end";
  at: string;
  seconds: number;
  dragging: boolean;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={kind === "start" ? "Trim start" : "Trim end"}
      aria-valuetext={formatDuration(seconds)}
      style={{ left: at }}
      className={clsx(
        "absolute inset-y-0 -ml-[5px] w-2.5 cursor-ew-resize touch-none rounded-[3px]",
        "shadow-[0_1px_4px_rgb(0_0_0/0.5)] transition-transform duration-100",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white",
        kind === "start" ? "bg-[#3ecf6a]" : "bg-[#f2564d]",
        dragging ? "scale-110" : "hover:scale-110",
      )}
      {...events}
    >
      {/* The two grip lines that say "this is draggable" at 10px wide. */}
      <span className="pointer-events-none absolute inset-y-1.5 left-[3px] w-px bg-black/35" />
      <span className="pointer-events-none absolute inset-y-1.5 right-[3px] w-px bg-black/35" />
    </div>
  );
}

interface ActionsProps {
  range: Range;
  duration: number;
  /** True while `avconvert` is working, which is seconds even on a big file. */
  busy: boolean;
  onCancel: () => void;
  onTrim: () => void;
}

/**
 * The row that says what will happen and offers to do it.
 *
 * Two things in one line, because there is only ever one of them to say. Until
 * a handle has moved there is nothing to confirm and everything to explain, so
 * it explains — including the two keys, which are otherwise undiscoverable.
 * After that it spells the cut out in full, both marks and the resulting
 * length, because this is the last moment before a file is written and
 * "0:03 – 0:21" is checkable in a way that two coloured handles are not.
 */
export function TrimActions({ range, duration, busy, onCancel, onTrim }: ActionsProps) {
  const kept = range.end - range.start;
  const dropped = Math.max(0, duration - kept);
  /** Both marks still at the ends: nothing would come off. */
  const untouched = range.start <= 0 && range.end >= duration - MIN_SELECTION;

  return (
    <div className="flex items-center gap-2 border-t border-line px-1.5 pt-1.5">
      <p className="min-w-0 flex-1 truncate text-[11.5px] text-ink-3">
        {untouched ? (
          <>
            Drag the handles to choose what to keep — or press{" "}
            <Key>I</Key> and <Key>O</Key> to mark where you are
          </>
        ) : (
          <>
            <span className="text-ink">
              Keeping {formatDuration(range.start)} – {formatDuration(range.end)}
            </span>
            <span className="font-mono tabular-nums"> · {formatDuration(kept)}</span>
            {dropped >= 1 && (
              <span className="text-ink-4"> · dropping {formatDuration(dropped)}</span>
            )}
          </>
        )}
      </p>

      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="h-7 rounded-lg px-2.5 text-[12px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onTrim}
        // Trimming nothing off is refused in `trim.rs` too, where it has to be;
        // stopping it here as well means the answer is a greyed-out button
        // rather than a round trip that ends in a red toast.
        disabled={busy || untouched || kept < MIN_SELECTION}
        className="h-7 rounded-lg bg-accent px-3 text-[12px] font-semibold text-accent-fg transition-colors hover:bg-accent-hi disabled:pointer-events-none disabled:opacity-40"
      >
        {busy ? "Trimming…" : "Trim"}
      </button>
    </div>
  );
}

const Key = ({ children }: { children: React.ReactNode }) => (
  <kbd className="rounded border border-line bg-white/[0.06] px-1 py-px font-mono text-[10.5px] text-ink-2">
    {children}
  </kbd>
);
