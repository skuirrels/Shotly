import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import clsx from "clsx";
import {
  IconFolder,
  IconLoop,
  IconMute,
  IconPause,
  IconPlay,
  IconSkipBack,
  IconSkipForward,
  IconTrim,
  IconVolume,
} from "@/components/icons";
import { IconButton } from "@/components/ui/IconButton";
import { Popover } from "@/components/ui/Popover";
import { Tooltip } from "@/components/ui/Tooltip";
import * as ipc from "@/lib/ipc";
import type { Trimmed, TrimMode, TrimPrecision } from "@/lib/types";
import { formatDuration } from "./format";
import { useThumbnail } from "./thumbnails";
import { MIN_SELECTION, TrimActions, TrimTrack, type Range } from "./TrimBar";
import { nouns } from "../../lib/platform";

/**
 * What the player needs to know about a recording.
 *
 * A `LibraryItem` satisfies it, and so does the little that's known about a
 * recording the moment it is saved — which is why this is its own shape rather
 * than the full library row.
 */
export interface Movie {
  path: string;
  name: string;
  modified: number;
  /** Running time as Rust read it, used until the movie reports its own. */
  seconds: number;
  /**
   * The bytes are in the cloud rather than on this disk.
   *
   * The player refuses these outright. Streaming happens through Tauri's asset
   * protocol, whose handler is synchronous and runs on the **main thread**, so
   * a movie a file provider has to fetch would freeze the whole app for the
   * length of the download — the exact failure the hang reports of 17 Aug were
   * all made of. QuickTime downloads it properly, with a progress bar and a
   * cancel, so that is what this offers.
   */
  cloud?: boolean;
}

interface Props {
  movie: Movie;
  /** Where to pick the movie up, in seconds. Read once, when the pane opens. */
  startAt?: number;
  /** Where it got to, reported as the pane closes so the tab can hold a place. */
  onLeave?: (seconds: number) => void;
  /** Leave the player — Escape, ⌘W, or the Library tab. */
  onClose: () => void;
  /**
   * A trim landed in the library as a new recording.
   *
   * The player does not switch to it itself: the editor owns which movie is
   * open and has a library listing to refresh, so it is told and decides.
   */
  onTrimmed?: (trimmed: Trimmed) => void;
  onError: (message: string) => void;
}

/** What ← and → move by. ⇧ makes it one second, for finding an exact moment. */
const STEP = 5;
/** What the transport's two skip buttons move by. */
const SKIP = 10;

const RATES = [0.5, 1, 1.25, 1.5, 2] as const;

/**
 * Watch a recording without leaving Shotly.
 *
 * The file is streamed off disk by `media.rs`, a scheme of Shotly's own that
 * answers range requests from a worker thread — so a seven-minute, 300 MB
 * recording starts playing at once, is never held in memory, and cannot block
 * the interface however slow the disk is. It serves the capture folder and
 * nothing else; a recording kept anywhere else will fail to load, which is what
 * the fallback below is for.
 */
export function Player({ movie, startAt = 0, onLeave, onClose, onTrimmed, onError }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  /** Seconds, once the movie itself says. `movie.seconds` until then. */
  const [duration, setDuration] = useState(movie.seconds);
  const [buffered, setBuffered] = useState(0);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(false);
  /**
   * Silent recordings are the norm — `screencapture -v` writes no audio track
   * — so the mute control only appears when there is something to mute.
   */
  const [hasAudio, setHasAudio] = useState(false);
  const [failed, setFailed] = useState(false);
  /**
   * The two marks, while a trim is being set up. `null` the rest of the time,
   * which is also what "not trimming" means — there is no second flag to keep
   * in step with this one.
   */
  const [range, setRange] = useState<Range | null>(null);
  /** Which side of the marks goes. */
  const [mode, setMode] = useState<TrimMode>("keep");
  /**
   * Encode the frames again, or copy the samples.
   *
   * Exact by default: the cut lands on the mark and nothing hidden survives,
   * which is what someone reaching for scissors expects — the surprise should
   * be "this takes a minute", not "it took two seconds more than I marked".
   * Fast is one click away in the summary, for when the wait is the thing
   * that matters; the striped overshoot appears the moment it is chosen, so
   * the trade is visible before it is paid.
   */
  const [precision, setPrecision] = useState<TrimPrecision>("exact");
  /**
   * Instants a segment may begin at — the recording's keyframes.
   *
   * Read once when the scissors are pressed, because a cut can only start
   * where a frame decodes on its own and the handles have to land on those
   * instants for what is shown to be what happens. Empty until it arrives, and
   * empty for good if the recording will not give them up, in which case
   * nothing snaps. Costs about 17 ms on a seven-minute recording.
   */
  const [syncPoints, setSyncPoints] = useState<number[]>([]);
  /**
   * How far the export has got, 0..1, or `null` when none is running.
   *
   * One value for both questions — is it working, and how far — because two
   * would be two things to keep in step, and the answer to the first is
   * exactly "the second is not null".
   */
  const [progress, setProgress] = useState<number | null>(null);
  /** True between pointer-down and pointer-up on the scrubber. */
  const scrubbing = useRef(false);
  /**
   * The last position seen, kept in a ref so the unmount cleanup can report it
   * after the element has gone. A movie watched to the end reports zero: the
   * next visit wants the beginning, not four frames of the credits.
   */
  const at = useRef(0);

  useEffect(
    () => () => onLeave?.(at.current),
    // Deliberately unconditional: this fires once, when the pane closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // The poster frame the library already made. It paints in the first frame
  // rather than leaving a black rectangle while the movie's own first frame is
  // decoded, which on a large recording is long enough to look broken.
  const { url: poster } = useThumbnail(movie.path, movie.modified, movie.cloud);
  const src = useMemo(() => ipc.mediaUrl(movie.path), [movie.path]);

  const seek = useCallback((to: number) => {
    const el = video.current;
    if (!el) return;
    const end = Number.isFinite(el.duration) ? el.duration : to;
    const next = Math.max(0, Math.min(end, to));
    el.currentTime = next;
    setTime(next);
  }, []);

  const toggle = useCallback(() => {
    const el = video.current;
    if (!el) return;
    // `play()` rejects if the movie can't be decoded; the error event has
    // already put the fallback on screen, so there is nothing to say here.
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  }, []);

  // ----------------------------------------------------------------- trim

  /**
   * Start marking a trim, with the marks at the two ends of the recording.
   *
   * Deliberately not a selection around the playhead: the recording is what
   * you have, and every drag from here takes something off it. Starting from
   * "keep everything" means one handle moved is one honest edit.
   */
  const startTrim = useCallback(() => {
    const length = duration || movie.seconds;
    if (length <= MIN_SELECTION) {
      onError("That recording is too short to trim.");
      return;
    }
    video.current?.pause();
    setRange({ start: 0, end: length });
    // Both ends of a fresh selection are already legal — zero is always a
    // keyframe, and the far end is an end — so this is only needed by the time
    // a handle moves, and the drag will read whatever has arrived by then.
    void ipc
      .videoSyncPoints(movie.path)
      .then(setSyncPoints)
      .catch(() => setSyncPoints([]));
  }, [duration, movie.path, movie.seconds, onError]);

  const cancelTrim = useCallback(() => {
    setRange(null);
    setSyncPoints([]);
  }, []);

  // Rust says how far the export has got. Subscribed only while one is being
  // set up, so the player is not listening to an event nobody is sending for
  // the whole time a recording is merely being watched.
  useEffect(() => {
    if (!range) return;
    const stop = listen<number>("trim:progress", (event) =>
      setProgress((running) => (running === null ? running : event.payload)),
    );
    return () => void stop.then((off) => off());
  }, [range]);

  /**
   * Cut the recording down to the marks.
   *
   * The result is a new file — the original is never overwritten, for the
   * reason `trim.rs` gives — so the answer goes back to the editor, which
   * switches the player onto it and re-reads the library.
   */
  const applyTrim = useCallback(async () => {
    if (!range || progress !== null) return;
    // Stop playing first, for two reasons and the second is the serious one.
    // A movie carrying on underneath a progress bar reads as two things
    // happening rather than one — and, more to the point, when this finishes
    // the editor swaps `movie.path` to the file just written. Changing the
    // source of a *playing* element cancels whatever range request is in
    // flight, and `media.rs` answers those from a worker thread; replying to a
    // task WebKit has already stopped is what WKWebView throws on. Paused,
    // there is nothing in flight to cancel.
    video.current?.pause();
    setProgress(0);
    try {
      const trimmed = await ipc.videoTrim(movie.path, range.start, range.end, mode, precision);
      setRange(null);
      onTrimmed?.(trimmed);
    } catch (err) {
      onError(String(err));
    } finally {
      setProgress(null);
    }
  }, [mode, movie.path, onError, onTrimmed, precision, progress, range]);

  // ------------------------------------------------------------- keyboard

  /**
   * The player owns the keyboard while it's on screen.
   *
   * The editor's keymap is switched off in this view (see `EditorApp`), so the
   * handful of keys a player needs are bound here rather than being threaded
   * through a command list where every entry would have to learn to stand
   * aside. Escape and ⌘W come along because leaving is part of watching.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = video.current;
      if (!el || e.isComposing) return;

      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      if (e.metaKey) {
        // ⌘W and ⌘L both mean "leave this". Everything else with ⌘ belongs to
        // the menu bar, which the webview never sees.
        if (e.key === "w" || e.key === "l") {
          handled();
          onClose();
        }
        return;
      }

      switch (e.key) {
        case " ":
        case "k":
          handled();
          toggle();
          break;
        case "ArrowLeft":
          handled();
          seek(el.currentTime - (e.shiftKey ? 1 : STEP));
          break;
        case "ArrowRight":
          handled();
          seek(el.currentTime + (e.shiftKey ? 1 : STEP));
          break;
        case "Home":
          handled();
          seek(0);
          break;
        case "End":
          handled();
          seek(Number.isFinite(el.duration) ? el.duration : 0);
          break;
        case "m":
          handled();
          el.muted = !el.muted;
          setMuted(el.muted);
          break;
        // In and out points, from every editor that has ever had them. They
        // set a mark without moving the picture, which is what makes "play
        // until it looks right, press o" work.
        case "i": {
          if (!range) break;
          handled();
          const at = el.currentTime;
          setRange({ start: Math.min(at, range.end - MIN_SELECTION), end: range.end });
          break;
        }
        case "o": {
          if (!range) break;
          handled();
          const at = el.currentTime;
          setRange({ start: range.start, end: Math.max(at, range.start + MIN_SELECTION) });
          break;
        }
        case "Escape":
          handled();
          // Escape backs out of one thing at a time. Marking a trim and then
          // losing the whole pane to a stray Escape would be the wrong trade.
          if (range) setRange(null);
          else onClose();
          break;
      }
    };

    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose, range, seek, toggle]);

  // Playback rate is a property, not an attribute — React can't set it.
  useEffect(() => {
    if (video.current) video.current.playbackRate = rate;
  }, [rate]);

  // --------------------------------------------------------------- render

  const percent = (seconds: number) =>
    duration > 0 ? `${Math.min(100, (seconds / duration) * 100)}%` : "0%";

  return (
    <div className="relative flex min-w-0 flex-1 flex-col bg-inset">
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-6 pb-24">
        {failed || movie.cloud ? (
          <Unplayable movie={movie} onError={onError} />
        ) : (
          <video
            ref={video}
            src={src}
            poster={poster ?? undefined}
            // The double-click that opened this asked for it to play; wry
            // leaves WKWebView's autoplay policy open, so it does.
            autoPlay
            playsInline
            loop={loop}
            controls={false}
            className="max-h-full max-w-full rounded-xl bg-black shadow-[0_16px_48px_rgb(0_0_0/0.6)]"
            onClick={toggle}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onLoadedMetadata={(e) => {
              const el = e.currentTarget as HTMLVideoElement & {
                audioTracks?: { length: number };
              };
              if (Number.isFinite(el.duration)) setDuration(el.duration);
              // Pick up where the last visit left off, unless that was the
              // very end of the movie.
              if (startAt > 0 && startAt < el.duration - 0.5) {
                el.currentTime = startAt;
                setTime(startAt);
              }
              // `audioTracks` is WebKit's, and this only ever runs in WebKit —
              // but if it ever isn't there, showing a mute button for a silent
              // movie is the harmless half of being wrong.
              setHasAudio(el.audioTracks ? el.audioTracks.length > 0 : true);
            }}
            onTimeUpdate={(e) => {
              const el = e.currentTarget;
              at.current = el.currentTime >= el.duration - 0.5 ? 0 : el.currentTime;
              if (!scrubbing.current) setTime(el.currentTime);

              // While marks are set, the selection *is* the movie: playing
              // past the out point behaves the way reaching the end does, so
              // pressing play reviews exactly what the Trim button will keep.
              if (range && el.currentTime >= range.end) {
                if (loop) el.currentTime = range.start;
                else {
                  el.pause();
                  el.currentTime = range.end;
                }
              }
            }}
            onProgress={(e) => {
              const ranges = e.currentTarget.buffered;
              setBuffered(ranges.length > 0 ? ranges.end(ranges.length - 1) : 0);
            }}
            // Anything the movie can't do — a missing file, a codec WebKit
            // won't touch, a path outside the asset protocol's scope — lands
            // here, and the fallback offers the app that can.
            onError={() => setFailed(true)}
          />
        )}

        {/* A recording opens playing, so the big centre button is only there
            when it isn't: it says "paused", and it's the easiest possible
            target for starting again. */}
        {!failed && !movie.cloud && !playing && (
          <button
            type="button"
            onClick={toggle}
            aria-label="Play"
            className="animate-in-fade absolute inset-0 grid place-items-center"
          >
            <span className="grid size-16 place-items-center rounded-full bg-black/55 text-white shadow-[0_8px_32px_rgb(0_0_0/0.5)] backdrop-blur-[2px] transition-transform duration-100 hover:scale-105">
              <IconPlay className="size-7" width={28} height={28} />
            </span>
          </button>
        )}
      </div>

      {!failed && !movie.cloud && (
        <div className="pointer-events-none absolute inset-x-0 bottom-5 z-40 flex justify-center px-6">
          <div className="surface-float pointer-events-auto flex w-full max-w-[720px] flex-col gap-1.5 rounded-2xl px-2.5 py-1.5">
            <div className="flex items-center gap-1.5">
              <IconButton
                icon={<IconSkipBack />}
                label={`Back ${SKIP} seconds`}
                shortcut="ArrowLeft"
                tooltipSide="top"
                onClick={() => seek((video.current?.currentTime ?? 0) - SKIP)}
              />
              <IconButton
                icon={playing ? <IconPause /> : <IconPlay />}
                label={playing ? "Pause" : "Play"}
                shortcut="Space"
                tooltipSide="top"
                onClick={toggle}
              />
              <IconButton
                icon={<IconSkipForward />}
                label={`Forward ${SKIP} seconds`}
                shortcut="ArrowRight"
                tooltipSide="top"
                onClick={() => seek((video.current?.currentTime ?? 0) + SKIP)}
              />

              <span className="ml-1 shrink-0 font-mono text-[11px] tabular-nums text-ink-2">
                {formatDuration(time)}
              </span>

              {/* Marking a trim takes the scrubber's place rather than sitting
                  beside it. Both are the same timeline, and two of them would be
                  two playheads to keep in step and twice the width to aim at. */}
              {range ? (
                <TrimTrack
                  duration={duration}
                  time={time}
                  range={range}
                  mode={mode}
                  precision={precision}
                  syncPoints={syncPoints}
                  onRange={setRange}
                  onSeek={seek}
                />
              ) : (
                <div className="relative mx-1 h-1.5 min-w-0 flex-1 rounded-full bg-white/10">
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-white/15"
                    style={{ width: percent(buffered) }}
                  />
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-accent"
                    style={{ width: percent(time) }}
                  />
                  <input
                    type="range"
                    min={0}
                    max={duration || 0}
                    step={0.05}
                    value={time}
                    aria-label="Seek"
                    onPointerDown={() => (scrubbing.current = true)}
                    onPointerUp={() => (scrubbing.current = false)}
                    onBlur={() => (scrubbing.current = false)}
                    onChange={(e) => seek(Number(e.target.value))}
                    className={clsx(
                      "absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent",
                      "[&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none",
                      "[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white",
                      "[&::-webkit-slider-thumb]:shadow-[0_1px_4px_rgb(0_0_0/0.5)]",
                    )}
                  />
                </div>
              )}

              <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-4">
                {formatDuration(duration)}
              </span>

              <span className="mx-1 h-5 w-px shrink-0 bg-line" />

              <Popover
                align="center"
                trigger={({ open, toggle: openMenu }) => (
                  <Tooltip label="Playback speed" side="top">
                    <button
                      type="button"
                      onClick={openMenu}
                      aria-expanded={open}
                      className={clsx(
                        "no-drag h-[30px] shrink-0 rounded-lg px-2 font-mono text-[11px] tabular-nums transition-colors",
                        rate === 1
                          ? "text-ink-2 hover:bg-hover hover:text-ink"
                          : "bg-accent/18 text-accent",
                        open && "bg-hover text-ink",
                      )}
                    >
                      {rate}×
                    </button>
                  </Tooltip>
                )}
              >
                {({ close }) => (
                  <div className="w-[104px]">
                    {RATES.map((r) => (
                      <button
                        key={r}
                        type="button"
                        aria-current={r === rate}
                        onClick={() => {
                          setRate(r);
                          close();
                        }}
                        className={clsx(
                          "flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-hover",
                          r === rate ? "text-accent" : "text-ink",
                        )}
                      >
                        <span className="font-mono tabular-nums">{r}×</span>
                        {r === 1 && <span className="text-[11px] text-ink-4">Normal</span>}
                      </button>
                    ))}
                  </div>
                )}
              </Popover>

              <IconButton
                icon={<IconLoop />}
                label="Loop"
                active={loop}
                tooltipSide="top"
                onClick={() => setLoop((v) => !v)}
              />

              {hasAudio && (
                <IconButton
                  icon={muted ? <IconMute /> : <IconVolume />}
                  label={muted ? "Unmute" : "Mute"}
                  shortcut="M"
                  active={muted}
                  tooltipSide="top"
                  onClick={() => {
                    const el = video.current;
                    if (!el) return;
                    el.muted = !el.muted;
                    setMuted(el.muted);
                  }}
                />
              )}

              <IconButton
                icon={<IconTrim />}
                label={range ? "Stop trimming" : "Trim"}
                active={Boolean(range)}
                disabled={progress !== null}
                tooltipSide="top"
                onClick={range ? cancelTrim : startTrim}
              />
            </div>

            {range && (
              <TrimActions
                range={range}
                duration={duration}
                mode={mode}
                precision={precision}
                onPrecision={setPrecision}
                syncPoints={syncPoints}
                onMode={setMode}
                progress={progress}
                onCancel={cancelTrim}
                onTrim={() => void applyTrim()}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * What the pane shows when the movie won't load.
 *
 * Never a blank rectangle: the two things that can go wrong here — a file
 * moved out from under the library, and a codec WebKit declines — both have
 * the same answer, which is the app that does play it.
 */
function Unplayable({ movie, onError }: { movie: Movie; onError: (message: string) => void }) {
  return (
    <div className="max-w-[380px] text-center">
      <p className="text-[13.5px] font-medium text-ink">
        {movie.cloud ? "This recording isn’t downloaded" : "Shotly can’t play this one"}
      </p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
        {movie.cloud
          ? "Its contents are in the cloud. Playing it here would freeze Shotly until the whole file had come down, so open it in the movie player instead — that downloads it properly, and you can watch it as it arrives."
          : "The file may have moved, or it may be in a format this window can’t decode. It should still open in whatever plays movies on this Mac."}
      </p>
      <div className="mt-4 flex justify-center gap-2">
        <button
          type="button"
          onClick={() =>
            void ipc
              .openExternally(movie.path)
              .catch((e) => onError(`Could not open that recording: ${e}`))
          }
          className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12.5px] font-semibold text-accent-fg transition-colors hover:bg-accent-hi"
        >
          <IconPlay />
          Open in the movie player
        </button>
        <button
          type="button"
          onClick={() => void ipc.revealInFinder(movie.path)}
          className="flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.07] px-3 text-[12.5px] font-medium text-ink transition-colors hover:bg-white/[0.11]"
        >
          <IconFolder />
          {nouns.reveal}
        </button>
      </div>
    </div>
  );
}
