import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize, PhysicalPosition } from "@tauri-apps/api/window";
import { IconClose, IconCopy } from "@/components/icons";

/**
 * One capture, stuck to the front of the screen.
 *
 * The whole window is the image: no title bar, no chrome, nothing to read.
 * A pin earns its place by being a picture you can put beside your work, and
 * every pixel spent on furniture is a pixel not spent on the picture.
 */

/** How much one wheel notch or key press changes the size. */
const ZOOM_STEP = 1.12;
const MIN_SCALE = 0.15;
const MAX_SCALE = 4;

export function PinApp() {
  const path = decodeURIComponent(new URLSearchParams(window.location.search).get("src") ?? "");
  /**
   * The image, inlined.
   *
   * Not the asset protocol: its scope does not reach the capture library, and
   * widening it so a pin can show a picture would hand every page in the app
   * read access to the whole of Documents.
   */
  const [src, setSrc] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void invoke<string>("image_data_url", { path })
      .then(setSrc)
      .catch(() => setSrc(null));
  }, [path]);

  /**
   * The size the window opened at, and the factor applied to it.
   *
   * Zooming resizes the *window* rather than scaling the image inside it —
   * a pin with empty space around its picture, or a picture cropped by its
   * own window, would both look like a bug.
   */
  const base = useRef<{ width: number; height: number } | null>(null);
  const scale = useRef(1);

  /**
   * Where the window is, and how many device pixels a point is worth.
   *
   * Both are cached rather than asked for mid-drag. Every call across the
   * bridge is a round trip, and a pointer move cannot wait for one — the
   * first version did, and the drag dropped every move that arrived before
   * the answer came back.
   */
  const at = useRef<{ x: number; y: number } | null>(null);
  const factor = useRef(1);

  useEffect(() => {
    const win = getCurrentWindow();
    void Promise.all([win.innerSize(), win.outerPosition(), win.scaleFactor()]).then(
      ([size, position, scale]) => {
        const logical = size.toLogical(scale);
        base.current = { width: logical.width, height: logical.height };
        at.current = { x: position.x, y: position.y };
        factor.current = scale;
      },
    );
  }, []);

  const resize = useCallback((next: number) => {
    const start = base.current;
    if (!start) return;
    scale.current = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
    void getCurrentWindow().setSize(
      new LogicalSize(
        Math.round(start.width * scale.current),
        Math.round(start.height * scale.current),
      ),
    );
  }, []);

  const close = useCallback(() => void getCurrentWindow().close(), []);

  const copy = useCallback(() => {
    // Rust reads the file: the pin knows the path, and shipping the pixels
    // back through the bridge to put them on the clipboard would be silly.
    void invoke("copy_file_image_to_clipboard", { path })
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  }, [path]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || (e.metaKey && e.key === "w")) {
        e.preventDefault();
        close();
      } else if (e.metaKey && e.key === "c") {
        e.preventDefault();
        copy();
      } else if (e.key === "+" || e.key === "=") {
        resize(scale.current * ZOOM_STEP);
      } else if (e.key === "-") {
        resize(scale.current / ZOOM_STEP);
      } else if (e.key === "0") {
        resize(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, copy, resize]);

  /**
   * Pick the pin up and carry it.
   *
   * The window is moved from here rather than by `data-tauri-drag-region` or
   * `startDragging`, both of which hand the job to AppKit's own drag loop:
   * that loop follows the hardware cursor, so it cannot be exercised without
   * a hand on the mouse. Doing the arithmetic here behaves the same for a
   * user and can actually be tested.
   *
   * Pointer capture, because a quick drag outruns the window and the pointer
   * ends up over whatever is beside it.
   */
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();

    const origin = at.current;
    if (!origin) return;

    const surface = e.currentTarget as HTMLElement;
    const from = { x: e.screenX, y: e.screenY };
    surface.setPointerCapture(e.pointerId);

    const win = getCurrentWindow();
    const start = { ...origin };

    const onMove = (m: PointerEvent) => {
      // Screen coordinates from the page are logical; window positions are
      // physical. On a retina display those differ by a factor of two, and
      // getting it wrong makes the pin run at twice the speed of the hand.
      const next = {
        x: Math.round(start.x + (m.screenX - from.x) * factor.current),
        y: Math.round(start.y + (m.screenY - from.y) * factor.current),
      };
      at.current = next;
      void win.setPosition(new PhysicalPosition(next.x, next.y));
    };
    const onUp = () => {
      surface.removeEventListener("pointermove", onMove);
      surface.removeEventListener("pointerup", onUp);
      surface.removeEventListener("pointercancel", onUp);
    };

    surface.addEventListener("pointermove", onMove);
    surface.addEventListener("pointerup", onUp);
    surface.addEventListener("pointercancel", onUp);
  };

  // Ctrl or ⌘ with the wheel, not the wheel alone: a pin sitting over a
  // document should not resize itself every time the page under it scrolls
  // past — and the pointer is over the pin more often than you would think.
  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    resize(scale.current * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
  };

  return (
    <div
      // The whole surface drags the window. A pin has no title bar to grab,
      // and picking it up anywhere is what people try first.
      onPointerDown={onPointerDown}
      onWheel={onWheel}
      className="group relative h-screen w-screen overflow-hidden rounded-xl bg-black/20 ring-1 ring-white/15"
    >
      {src && (
        <img
          src={src}
          alt=""
          draggable={false}
          className="pointer-events-none h-full w-full select-none object-contain"
        />
      )}

      {/* Out of the way until wanted: the picture is the point, and a pin
          wearing buttons all the time is a pin you notice instead of use. */}
      <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          onClick={copy}
          title="Copy the image (⌘C)"
          aria-label="Copy"
          className="grid size-[22px] place-items-center rounded-md bg-black/55 text-white/80 backdrop-blur hover:bg-black/75 hover:text-white"
        >
          <IconCopy />
        </button>
        <button
          type="button"
          onClick={close}
          title="Close this pin (esc)"
          aria-label="Close"
          className="grid size-[22px] place-items-center rounded-md bg-black/55 text-white/80 backdrop-blur hover:bg-black/75 hover:text-white"
        >
          <IconClose />
        </button>
      </div>

      {copied && (
        <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
          <span className="rounded-md bg-black/70 px-2 py-1 text-[11px] text-white backdrop-blur">
            Copied
          </span>
        </div>
      )}
    </div>
  );
}
