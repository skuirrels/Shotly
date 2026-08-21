import { useCallback, useRef } from "react";
import { dragOut } from "./ipc";

/**
 * Dragging a capture out of Shotly and into another app.
 *
 * The gesture everybody already knows: press a thumbnail, move, and let go over
 * Slack, Mail, or a Finder window. It cannot be done with the browser's own
 * drag-and-drop — see `src-tauri/src/platform/macos/dragout.rs` for why — so
 * all this does is *recognise* the gesture and hand it to AppKit, which owns it
 * from that moment on.
 *
 * Which means the events stop coming. Once the native session starts, the web
 * view sees no move and no release, and the click that would otherwise have
 * followed never arrives — which is exactly right, because a drag is not a
 * click. Everything below is about surviving that: the state is reset the
 * instant the drag is handed over, rather than on a `pointerup` that may never
 * come.
 */

/**
 * How far the pointer has to travel before a press becomes a drag.
 *
 * The same figure AppKit uses for its own drag-detect. Below it, a press with
 * a shaky hand is still a click — and on a grid where one click selects and two
 * open, a threshold that is too eager makes both unreliable.
 */
const THRESHOLD = 5;

export interface DragOutHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}

/**
 * Pointer handlers that turn a press-and-move into a file drag.
 *
 * `paths` is asked for at the moment the drag starts rather than captured when
 * the handlers were made, so a selection changed by the very press that begins
 * the drag is the selection that travels.
 */
export function useDragOut(paths: () => string[], onError?: (message: string) => void): DragOutHandlers {
  const from = useRef<{ x: number; y: number } | null>(null);

  const clear = useCallback(() => {
    from.current = null;
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Left button only, and never with a modifier held: ⌘-click and ⇧-click
    // are how a grid is multi-selected, and starting a drag out of the app on
    // one of those would make picking several captures impossible.
    if (e.button !== 0 || e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) {
      from.current = null;
      return;
    }
    from.current = { x: e.clientX, y: e.clientY };
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const start = from.current;
      if (!start) return;
      // The button came up somewhere we never heard about it.
      if ((e.buttons & 1) === 0) {
        from.current = null;
        return;
      }
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < THRESHOLD) return;

      from.current = null;
      const files = paths();
      if (files.length === 0) return;
      void dragOut(files).catch((err) => onError?.(String(err)));
    },
    [paths, onError],
  );

  return { onPointerDown, onPointerMove, onPointerUp: clear, onPointerCancel: clear };
}
