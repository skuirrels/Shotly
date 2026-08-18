import { useCallback, useRef, useState } from "react";
import clsx from "clsx";
import type { TrimMode, TrimPrecision } from "@/lib/types";
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

/**
 * Where a cut actually resumes, given the mark the handle is on.
 *
 * The keyframe *after* the first one past `mark`, matching `resume` in
 * `trim.rs` — see that module for why it is two keyframes and not one. In
 * short: the export hides a run-up spanning the keyframe before the resume
 * point up to it, and only the second step puts that run-up entirely on the
 * far side of the mark, where it holds nothing anybody asked to lose.
 *
 * `null` when nothing is far enough along — the cut then runs to the end of the
 * recording — and when the recording gave up no keyframes at all.
 *
 * The handle is deliberately **not** moved onto this. The mark is what somebody
 * chose; the resume point is a consequence of it. Snapping the handle here
 * would throw the mark away, and the next drag would round it on again.
 */
/**
 * How far a shortening really reaches, which is not always the red handle.
 *
 * A Fast cut has to resume on a keyframe past the mark, so it takes more than
 * it was asked for; an Exact cut re-encodes and lands on the mark. Everything
 * that draws or describes the selection goes through here, so the band, the
 * summary and the file cannot disagree with each other.
 */
export function extentOf(
  mode: TrimMode,
  precision: TrimPrecision,
  range: Range,
  syncPoints: number[],
  duration: number,
): number {
  if (mode !== "cut" || precision === "exact") return range.end;
  return resumePoint(syncPoints, range.end) ?? duration;
}

/**
 * A mark written out to a tenth of a second: `0:06.4`.
 *
 * `formatDuration` rounds to whole seconds, which is right for a running time
 * and wrong here — a handle nudged by a tenth would not appear to move, and the
 * two marks either side of a one-second cut would read the same. The seconds
 * part is floored rather than rounded so the tenth after it is the tenth that
 * is actually there.
 */
export function markLabel(seconds: number): string {
  const safe = Math.max(0, seconds);
  const whole = Math.floor(safe);
  return `${formatDuration(whole)}.${Math.floor((safe - whole) * 10)}`;
}

export function resumePoint(points: number[], mark: number): number | null {
  const EPSILON = 0.001;
  const first = points.find((p) => p >= mark - EPSILON);
  if (first === undefined) return null;
  return points.find((p) => p > first + EPSILON) ?? null;
}

interface TrackProps {
  duration: number;
  /** Where the playhead is, in seconds. */
  time: number;
  range: Range;
  /** Which side of the marks is being thrown away. */
  mode: TrimMode;
  /** Copy the samples, or encode them again. Only Fast has to round. */
  precision: TrimPrecision;
  /** Instants a segment may begin at. Empty means snapping is off. */
  syncPoints: number[];
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
export function TrimTrack({
  duration,
  time,
  range,
  mode,
  precision,
  syncPoints,
  onRange,
  onSeek,
}: TrackProps) {
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
    duration > 0
      ? `${Math.max(0, Math.min(100, (seconds / duration) * 100))}%`
      : "0%";

  /** How far a cut really reaches: its resume point, or the end of the movie. */
  const losesUntil = extentOf(mode, precision, range, syncPoints, duration);

  /** A label's position, kept far enough inside that it is not half cut off. */
  const clamped = (seconds: number) =>
    duration > 0
      ? `${Math.max(6, Math.min(94, (seconds / duration) * 100))}%`
      : "6%";

  const grab =
    (which: "start" | "end") => (e: React.PointerEvent<HTMLElement>) => {
      // Without this the press falls through to the track below, which would
      // seek — so grabbing a handle would jump the playhead away from it.
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(which);
    };

  const drag =
    (which: "start" | "end") => (e: React.PointerEvent<HTMLElement>) => {
      if (dragging !== which) return;
      // The handle goes exactly where it is dragged. It is the mark somebody
      // chose; where a cut resumes is worked out from it and drawn separately.
      const at = secondsAt(e.clientX);

      // The handles cannot pass each other, and cannot meet: a selection of
      // nothing is not a thing anyone means to drag out.
      const next =
        which === "start"
          ? { start: Math.min(at, range.end - MIN_SELECTION), end: range.end }
          : {
              start: range.start,
              end: Math.max(at, range.start + MIN_SELECTION),
            };

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
    const delta =
      e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    if (!delta) return;
    e.preventDefault();
    e.stopPropagation();

    const at = (which === "start" ? range.start : range.end) + delta;
    const next =
      which === "start"
        ? {
            start: Math.max(0, Math.min(at, range.end - MIN_SELECTION)),
            end: range.end,
          }
        : {
            start: range.start,
            end: Math.min(duration, Math.max(at, range.start + MIN_SELECTION)),
          };

    onRange(next);
    onSeek(which === "start" ? next.start : next.end);
  };

  return (
    <div className="mx-1 min-w-0 flex-1 select-none">
      <div
        ref={track}
        // Clicking the track seeks, the way the scrubber does. Trimming should
        // not cost you the ability to jump about and look at the recording.
        onPointerDown={(e) => onSeek(secondsAt(e.clientX))}
        className="relative h-6 cursor-pointer touch-none"
      >
        {/* The strip everything else sits on. */}
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-white/10" />

        {/* The two ends. Kept in Keep mode, thrown away in Cut. */}
        <div
          className={clsx(
            "absolute inset-y-0 left-0 rounded-l-md",
            surface(mode === "cut"),
          )}
          style={{ width: percent(range.start) }}
        />
        <div
          className={clsx(
            "absolute inset-y-0 right-0 rounded-r-md",
            surface(mode === "cut"),
          )}
          style={{ left: percent(losesUntil) }}
        />

        {/* The middle — the other way round. Which is the whole difference
          between the two modes, and the reason the track is worth looking at
          before pressing the button.

          In Cut it runs past the red handle to where playback really resumes.
          Drawing it only as far as the handle would understate the cut by up
          to two seconds, which is the kind of quiet difference that makes
          people stop trusting a tool. */}
        <div
          className={clsx("absolute inset-y-0", surface(mode === "keep"))}
          style={{
            left: percent(range.start),
            right: `calc(100% - ${percent(losesUntil)})`,
          }}
        />

        {/* Where the recording picks up again, when that is not the handle. */}
        {mode === "cut" && losesUntil > range.end + 0.01 && (
          <div
            className="pointer-events-none absolute inset-y-0 w-0.5 rounded bg-accent"
            style={{ left: percent(losesUntil) }}
          />
        )}

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

      {/* Where the handles actually are, in time, directly under them. The
          summary says the same numbers, but rounded to whole seconds and in a
          sentence several inches away; while you are dragging, the thing you
          want to read is below your thumb. */}
      <div className="pointer-events-none relative h-3.5 pt-1 font-mono text-[9.5px] leading-none tabular-nums">
        <span
          className="absolute -translate-x-1/2 whitespace-nowrap text-[#3ecf6a]"
          style={{ left: clamped(range.start) }}
        >
          {markLabel(range.start)}
        </span>
        <span
          className="absolute -translate-x-1/2 whitespace-nowrap text-[#f2564d]"
          style={{ left: clamped(range.end) }}
        >
          {markLabel(range.end)}
        </span>
        {/* And where a Fast cut really resumes, which is not the red handle. */}
        {losesUntil > range.end + 0.05 && (
          <span
            className="absolute -translate-x-1/2 whitespace-nowrap text-accent"
            style={{ left: clamped(losesUntil) }}
          >
            {markLabel(losesUntil)}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * How a stretch of the timeline is painted: lit if it survives, dimmed if not.
 *
 * A dimmed stretch is drawn over rather than merely left plain, so "this is
 * going" is a positive mark on the timeline instead of an absence to infer.
 */
const surface = (kept: boolean) =>
  kept ? "border-y border-accent/60 bg-accent/20" : "bg-black/45";

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
      // A second way to find the keys. The hint below says them once, and once
      // is easy to miss on a control you came to with the mouse.
      title={
        kind === "start"
          ? "Start of the selection — drag it, or press I to put it where the playhead is"
          : "End of the selection — drag it, or press O to put it where the playhead is"
      }
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
  mode: TrimMode;
  precision: TrimPrecision;
  onPrecision: (precision: TrimPrecision) => void;
  /** Instants a cut may resume at, so the summary can say the real extent. */
  syncPoints: number[];
  onMode: (mode: TrimMode) => void;
  /** 0..1 while the export runs, or `null` when nothing is running. */
  progress: number | null;
  onCancel: () => void;
  onTrim: () => void;
}

/**
 * The row that says what will happen and offers to do it.
 *
 * Two things in one line, because there is only ever one of them to say. Until
 * a handle has moved there is nothing to confirm and everything to explain, so
 * it explains — including the two keys, which are otherwise undiscoverable.
 * After that it spells the result out in full, both marks and the resulting
 * length, because this is the last moment before a file is written and
 * "0:03 – 0:21" is checkable in a way that two coloured handles are not.
 */
export function TrimActions({
  range,
  duration,
  mode,
  precision,
  onPrecision,
  syncPoints,
  onMode,
  progress,
  onCancel,
  onTrim,
}: ActionsProps) {
  // A cut runs to its resume point, not to the handle. Everything the row says
  // is worked out from that, so the numbers agree with the shading above them
  // and with the file that comes out.
  const losesUntil = extentOf(mode, precision, range, syncPoints, duration);
  const rounded = losesUntil > range.end + 0.01;
  const selected = losesUntil - range.start;
  const kept = mode === "keep" ? selected : Math.max(0, duration - selected);
  const dropped = Math.max(0, duration - kept);
  /** Both marks still at the ends: nothing would come off. */
  const untouched = range.start <= 0 && range.end >= duration - MIN_SELECTION;
  const busy = progress !== null;

  return (
    <div className="flex items-start gap-2 border-t border-line px-1.5 pt-2">
      <Modes mode={mode} onMode={onMode} disabled={busy} />

      {/* Never `truncate`. This line is the only place the two keys are named,
          and the first version clipped it to "…press I and O to mar…" — which
          is worse than not mentioning them, because it tells you something is
          being kept from you. It wraps instead, and the bar grows by a line. */}
      <p className="min-w-0 flex-1 text-[11.5px] leading-snug text-ink-3">
        {untouched ? (
          <>
            Drag a handle, or press <Key>I</Key> / <Key>O</Key> to mark where
            you are
          </>
        ) : (
          <>
            <span className="text-ink">
              {mode === "keep" ? "Keeping" : "Cutting"}{" "}
              {formatDuration(range.start)} – {formatDuration(losesUntil)}
            </span>
            <span className="font-mono tabular-nums">
              {" "}
              · {formatDuration(kept)} left
            </span>
            {dropped >= 1 && (
              <span className="text-ink-4">
                {" "}
                · losing {formatDuration(dropped)}
              </span>
            )}
            {/* The rounding is said out loud rather than left to be noticed —
                and the sentence that explains it is also the way to switch it
                off. A note you can act on beats a note plus a control
                somewhere else, in a row this narrow. */}
            {(rounded || precision === "exact") && (
              <>
                {" · "}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    onPrecision(precision === "exact" ? "fast" : "exact")
                  }
                  title={
                    precision === "exact"
                      ? "Cutting on the mark, by encoding the video again. Slower to write — several minutes on a long recording. Click for the quick way."
                      : "Video only cuts cleanly at a keyframe, so this reaches past your mark. Click to cut exactly there instead, which takes longer to write."
                  }
                  className="rounded text-ink-4 underline decoration-dotted underline-offset-2 transition-colors hover:text-ink disabled:no-underline disabled:opacity-60"
                >
                  {precision === "exact"
                    ? "exact, slower to write"
                    : "to the next keyframe"}
                </button>
              </>
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
        // Removing nothing is refused in `trim.rs` too, where it has to be;
        // stopping it here as well means the answer is a greyed-out button
        // rather than a round trip that ends in a red toast.
        disabled={busy || untouched || selected < MIN_SELECTION}
        className={clsx(
          "relative h-7 w-[104px] overflow-hidden rounded-lg text-[12px] font-semibold",
          "bg-accent text-accent-fg transition-colors hover:bg-accent-hi",
          "disabled:pointer-events-none disabled:opacity-40",
          busy && "disabled:opacity-100",
        )}
      >
        {/* The export fills the button rather than moving a bar somewhere else.
            0.9.5 shipped this as a word that never even had a chance to paint —
            the work was on the main thread — and it read as a dead app. A
            button that is visibly filling up cannot read that way. */}
        {busy && (
          <span
            className="absolute inset-y-0 left-0 bg-white/25 transition-[width] duration-150 ease-linear"
            style={{ width: `${Math.round(Math.max(0.04, progress) * 100)}%` }}
          />
        )}
        <span className="relative">
          {busy ? "Working…" : mode === "keep" ? "Trim" : "Cut out"}
        </span>
      </button>
    </div>
  );
}

/** Which side of the marks goes. Two words, because there are exactly two. */
function Modes({
  mode,
  onMode,
  disabled,
}: {
  mode: TrimMode;
  onMode: (mode: TrimMode) => void;
  disabled: boolean;
}) {
  return (
    <div
      className="flex shrink-0 rounded-lg bg-white/[0.06] p-0.5"
      role="group"
    >
      {(["keep", "cut"] as const).map((option) => (
        <button
          key={option}
          type="button"
          disabled={disabled}
          aria-pressed={mode === option}
          onClick={() => onMode(option)}
          title={
            option === "keep"
              ? "Keep what is between the handles"
              : "Cut out what is between the handles and close the gap"
          }
          className={clsx(
            "h-6 rounded-[6px] px-2 text-[11.5px] font-medium transition-colors disabled:opacity-40",
            mode === option
              ? "bg-accent/20 text-accent"
              : "text-ink-3 hover:text-ink",
          )}
        >
          {option === "keep" ? "Keep" : "Cut out"}
        </button>
      ))}
    </div>
  );
}

const Key = ({ children }: { children: React.ReactNode }) => (
  <kbd className="rounded border border-line bg-white/[0.06] px-1 py-px font-mono text-[10.5px] text-ink-2">
    {children}
  </kbd>
);
