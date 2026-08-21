import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconClose, IconCopy, IconPen, IconPin } from "@/components/icons";
import { useDragOut } from "@/lib/dragout";

/**
 * The shot that just landed, sitting in the corner.
 *
 * It has a few seconds to be useful and then it is gone, so everything about
 * it is arranged around not needing to be read: the picture is the whole
 * window, one click opens it, one drag sends it somewhere, and the buttons
 * only appear when the pointer does.
 *
 * Nothing here is load-bearing. The capture is already filed in the library by
 * the time this window exists — see `src-tauri/src/shelf.rs` — so ignoring it
 * entirely, which is what will usually happen, loses nothing at all.
 */

/** How long it stays before it takes itself away. */
const LINGER_MS = 6000;

/** How long the fade out runs. Long enough to notice, short enough to ignore. */
const FADE_MS = 320;

export function ShelfApp() {
  const path = decodeURIComponent(new URLSearchParams(window.location.search).get("src") ?? "");
  /**
   * The image, inlined rather than served.
   *
   * Same reason as the pin: the asset protocol's scope does not reach the
   * capture library, and widening it so this window can show a picture would
   * hand every page in the app read access to the whole of Documents.
   */
  const [src, setSrc] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  /** True while the pointer is over it: a shelf being used does not expire. */
  const held = useRef(false);

  useEffect(() => {
    void invoke<string>("image_data_url", { path })
      .then(setSrc)
      .catch(() => setSrc(null));
  }, [path]);

  const close = useCallback(() => {
    setLeaving(true);
    // Closed after the fade rather than with it, so the window is not yanked
    // out from under its own animation.
    window.setTimeout(() => void getCurrentWindow().close(), FADE_MS);
  }, []);

  /**
   * The clock, restarted whenever the shelf is touched.
   *
   * A single timer that checks whether the pointer is on it, rather than one
   * cancelled and recreated on every enter and leave: the shelf is small and
   * the pointer crosses its edge a lot on the way past.
   */
  useEffect(() => {
    const at = Date.now();
    const timer = window.setInterval(() => {
      if (held.current) return;
      if (Date.now() - at < LINGER_MS) return;
      window.clearInterval(timer);
      close();
    }, 250);
    return () => window.clearInterval(timer);
  }, [close]);

  const flash = (text: string) => {
    setNote(text);
    window.setTimeout(() => setNote(null), 1400);
  };

  const copy = useCallback(() => {
    void invoke("copy_file_image_to_clipboard", { path })
      .then(() => {
        flash("Copied");
        // The job is done, and a thumbnail hanging around after it is clutter.
        window.setTimeout(close, 700);
      })
      .catch(() => flash("Could not copy"));
  }, [path, close]);

  const edit = useCallback(() => {
    void invoke("shelf_edit", { path }).catch(() => flash("Could not open it"));
  }, [path]);

  const pin = useCallback(() => {
    void invoke("pin_open", { path })
      .then(close)
      .catch(() => flash("Could not pin it"));
  }, [path, close]);

  // The same gesture the library grid has. Dragging the corner thumbnail
  // straight into a chat window is the shortest path there is from pressing
  // the key to having sent the thing.
  const drag = useDragOut(
    useCallback(() => [path], [path]),
    () => flash("Could not drag it"),
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.metaKey && e.key === "c") copy();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, copy]);

  return (
    <div
      className="group relative h-screen w-screen overflow-hidden rounded-xl bg-black/25 ring-1 ring-white/20 shadow-[0_10px_40px_rgba(0,0,0,0.5)]"
      style={{
        opacity: leaving ? 0 : 1,
        // Slides down and out rather than only fading: the direction says
        // "gone", where a fade alone reads as the window failing to draw.
        transform: leaving ? "translateY(12px) scale(0.96)" : "none",
        transition: `opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms ease`,
      }}
      onPointerEnter={() => (held.current = true)}
      onPointerLeave={() => (held.current = false)}
      onDoubleClick={edit}
      {...drag}
    >
      {src && (
        <img
          src={src}
          alt="The capture that was just taken"
          draggable={false}
          className="pointer-events-none h-full w-full select-none object-cover"
        />
      )}

      {/* Out of the way until the pointer arrives. The picture is the whole
          message; a thumbnail permanently wearing four buttons is something to
          dismiss rather than something to use. */}
      <div className="absolute inset-x-0 bottom-0 flex justify-center gap-1 bg-gradient-to-t from-black/70 to-transparent pt-6 pb-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        <Action label="Copy" title="Copy the image (⌘C)" onClick={copy}>
          <IconCopy />
        </Action>
        <Action label="Edit" title="Open it in the editor" onClick={edit}>
          <IconPen />
        </Action>
        <Action label="Pin" title="Stick it to the front of the screen" onClick={pin}>
          <IconPin />
        </Action>
        <Action label="Dismiss" title="Send it away (esc)" onClick={close}>
          <IconClose />
        </Action>
      </div>

      {note && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="rounded-md bg-black/75 px-2 py-1 text-[11px] text-white backdrop-blur">
            {note}
          </span>
        </div>
      )}
    </div>
  );
}

function Action({
  label,
  title,
  onClick,
  children,
}: {
  label: string;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={label}
      // Stopped here so that pressing a button never starts the drag-out the
      // surface underneath is listening for.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      className="grid size-[26px] place-items-center rounded-md bg-black/55 text-white/85 backdrop-blur transition-colors hover:bg-black/80 hover:text-white"
    >
      {children}
    </button>
  );
}
