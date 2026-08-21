import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import clsx from "clsx";
import {
  angleFrom,
  calloutLayout,
  CALLOUT_PADDING,
  centreOf,
  contrastInk,
  FREEHAND_MIN_STEP,
  handleAnchor,
  holdsHeight,
  holdsWidth,
  measureText,
  normalizeAngle,
  resizedBox,
  respunBox,
  rotatePoint,
  snapTurn,
  spunBoundsOf,
  stepRadius,
  unspun,
  unspunBox,
  wrapText,
} from "@/lib/shapes";
import {
  IconBrush,
  IconCopy,
  IconImage,
  IconLayers,
  IconOverlay,
  IconSelect,
  IconTrash,
} from "@/components/icons";
import { ContextMenu, type MenuEntry } from "@/components/ui/ContextMenu";
import { isEditingText } from "@/lib/keys/keys";
import { forgetPixels, preloadPixels, sampleColor, snapToEdge } from "@/lib/pick";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  type Annotation,
  type BoxKind,
  type Point,
  type Rect,
  angleOf,
  boundsOf,
  isBox,
  isImage,
  isLine,
  isPen,
  isStep,
  movedBy,
} from "@/lib/types";
import {
  type GapGuide,
  type Guide,
  NO_SNAP,
  SNAP_REACH,
  snapBox,
  snapPoint,
  targetsFor,
  unionOf,
} from "@/lib/guides";
import { fitToBox } from "@/lib/overlay";
import { backdropMetrics, fillById, fillToCss, hasBackdrop } from "@/lib/backdrop";
import { docSize, hasBareCanvas, useEditor } from "@/state/editorStore";
import { AnnotationLayer, type HandleId } from "./AnnotationLayer";

type Drag =
  | { kind: "create"; id: string; origin: Point }
  | { kind: "move"; ids: string[]; origin: Point; snapshot: Annotation[] }
  | { kind: "resize"; id: string; handle: Exclude<HandleId, "rotate">; snapshot: Annotation }
  // `grab` is how far the pointer already led the shape when the grip was
  // taken, so the shape turns with the hand instead of snapping its top edge
  // under it on the first pixel of the drag.
  | { kind: "rotate"; id: string; grab: number; snapshot: Annotation }
  | { kind: "crop"; origin: Point }
  | { kind: "grab"; origin: Point };

const BOX_TOOLS: BoxKind[] = ["rect", "ellipse", "blur", "highlight", "spotlight", "callout"];

/** A callout dragged out smaller than this gets a usable size instead. */
const CALLOUT_MIN = { width: 160, height: 56 };

/**
 * Grow a callout so every line of its text is inside it.
 *
 * Applied to the stored geometry rather than at draw time, so the selection
 * box and handles agree with what is on screen. Dragging the box narrower
 * rewraps the text and pushes the height back out, which is the behaviour you
 * want: a callout that hides its own words is broken.
 */
function fitCallout(a: Annotation): Annotation {
  if (a.kind !== "callout" || !isBox(a)) return a;
  const deg = angleOf(a);
  const { needed } = calloutLayout(a.text ?? "", a.style.fontSize, boundsOf(a).width);
  // Grown in unspun space, where "down" is the callout's own down and holding
  // x and y holds its top edge. Growing a turned box in place would move its
  // centre, and a turned shape hangs off its centre — so the box would swing
  // as it grew, which is not what rewrapping a line of text should look like.
  const box = unspunBox(boundsOf(a), deg);
  return {
    ...a,
    ...respunBox({ ...box, height: Math.max(box.height, needed) }, deg),
  };
}
const PAD = 48;

/**
 * How fast a wheel notch or a pinch changes the zoom.
 *
 * Exponential rather than additive, because zoom is multiplicative: a step
 * that adds 0.1 is a third of the picture at 0.3 and a rounding error at 8.
 * The figure gives about 15% per notch of an ordinary mouse wheel, which is
 * fine enough to land on a number you meant and coarse enough to cross the
 * range in a flick.
 */
const ZOOM_SENSITIVITY = 0.0015;

/** What one line of a `deltaMode: 1` wheel is worth in pixels. */
const WHEEL_LINE = 16;

/**
 * WebKit's own pinch event, which `lib.dom` has never had a type for.
 *
 * `scale` is cumulative from the start of the gesture — 1 at `gesturestart`,
 * 1.5 when the fingers are half again as far apart — rather than a step.
 */
interface GestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

interface CanvasProps {
  onNotify?: (text: string) => void;
  /**
   * The document-wide actions the right-click menu offers.
   *
   * Passed in rather than reached for: they belong to the editor shell — they
   * put up dialogs, write files, and show toasts — and the canvas only knows
   * where the pointer was.
   */
  actions?: {
    pasteImage: () => void;
    copy: () => void;
    exportFlat: () => void;
  };
  /**
   * Read the text in this part of the capture, in document coordinates, or in
   * the whole of it when the marquee was only a click.
   *
   * The editor shell owns it for the same reason as the actions above: the
   * recognising happens in Rust and the result goes to the clipboard and into
   * a panel, none of which is the canvas's business.
   */
  onScan?: (area: Rect | null) => void;
}

export function Canvas({ onNotify, actions, onScan }: CanvasProps) {
  const doc = useEditor((s) => s.doc);
  const annotations = useEditor((s) => s.annotations);
  const selectedIds = useEditor((s) => s.selectedIds);
  const tool = useEditor((s) => s.tool);
  const style = useEditor((s) => s.style);
  const zoomSetting = useEditor((s) => s.zoom);
  const fitToWindow = useEditor((s) => s.fitToWindow);
  const pendingCrop = useEditor((s) => s.pendingCrop);
  const backdrop = useEditor((s) => s.backdrop);

  const viewport = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  const [fitZoom, setFitZoom] = useState(1);
  const [editingId, setEditingId] = useState<string | null>(null);
  /** The last press on any shape, for the hand-rolled double-press above. */
  const lastShapePress = useRef<{ id: string; at: number } | null>(null);
  /** Alt turns a press on a shape into a draw-through — see `onShapePointerDown`. */
  const [altDown, setAltDown] = useState(false);
  /** The eyedropper's live readout: what is under the cursor right now. */
  const [swatch, setSwatch] = useState<{ x: number; y: number; hex: string } | null>(null);
  /** The text-grab marquee while it is being dragged out. */
  const [grabbing, setGrabbing] = useState<Rect | null>(null);
  /** Last pointer position in document space, for sampling without a move. */
  const pointer = useRef<Point | null>(null);
  /** The alignment lines to draw for the gesture in progress. */
  const [guides, setGuides] = useState<Guide[]>([]);
  /** Space is down: the canvas is a thing to push around rather than draw on. */
  const [handOpen, setHandOpen] = useState(false);
  /** True only while a pan is actually under way, for the closed-hand cursor. */
  const [panning, setPanning] = useState(false);
  /** Where a pan started, and where the pane was scrolled to at the time. */
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  /**
   * The point the next zoom has to keep still, if there is one.
   *
   * Set by the wheel handler and consumed by the layout effect below, because
   * the correction can only be worked out once the new size is on the page.
   */
  const anchor = useRef<{ doc: Point; client: { x: number; y: number } } | null>(null);
  /** The pane's own centre, in document coordinates, as of the last commit. */
  const middle = useRef<Point | null>(null);
  /** Open right-click menu: where it is, and which shape it was opened on. */
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; id: string | null } | null>(
    null,
  );

  const zoom = fitToWindow ? fitZoom : zoomSetting;

  // ----------------------------------------------------------- fit to window

  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el || !doc) return;

    const recompute = () => {
      const { width, height } = doc.crop;
      const available = el.getBoundingClientRect();
      const scale = Math.min(
        (available.width - PAD * 2) / width,
        (available.height - PAD * 2) / height,
      );
      // Never upscale on fit: a small capture blown up looks like a mistake.
      setFitZoom(Math.max(0.05, Math.min(scale, 1)));
    };

    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(el);
    return () => observer.disconnect();
  }, [doc]);

  // ------------------------------------------------------- zoom and pan

  /**
   * ⌘ with the wheel zooms, and so does a trackpad pinch.
   *
   * A native listener rather than React's `onWheel`, and that is not a style
   * choice: React attaches wheel handlers passively at the root, where
   * `preventDefault` does nothing — so the pane would zoom *and* scroll, and
   * the WebView would zoom itself underneath both.
   *
   * A pinch arrives as a wheel event with `ctrlKey` set, on every platform and
   * in every engine. It is not a real Control key and there is nothing else it
   * could mean here, so the two share a path.
   */
  useEffect(() => {
    const el = viewport.current;
    if (!el || !doc) return;

    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      e.preventDefault();

      const r = stage.current?.getBoundingClientRect();
      if (!r) return;

      // Some mice report their notches in lines rather than pixels, and a
      // line's worth of `deltaY` is about 3 — which without this would zoom by
      // half a percent and feel broken.
      const delta = e.deltaMode === 1 ? e.deltaY * WHEEL_LINE : e.deltaY;

      // The zoom *on the page*, measured rather than remembered. A flick of
      // the wheel delivers several events inside one frame, and React has not
      // re-rendered between them — so a value read from this closure would be
      // the same stale number every time and all but one notch would be lost.
      const shown = r.width / doc.crop.width;
      const store = useEditor.getState();

      // Remembered in document coordinates, which is the only frame that does
      // not move when the zoom changes.
      anchor.current = {
        doc: { x: (e.clientX - r.left) / shown, y: (e.clientY - r.top) / shown },
        client: { x: e.clientX, y: e.clientY },
      };
      // The store, on the other hand, *is* current: zustand writes on the
      // spot, so notches inside one frame compound instead of overwriting.
      const from = store.fitToWindow ? shown : store.zoom;
      store.setZoom(from * Math.exp(-delta * ZOOM_SENSITIVITY));
    };

    /**
     * A trackpad pinch, the way WebKit reports one.
     *
     * Chromium turns a pinch into a wheel event with `ctrlKey` set, which the
     * handler above already takes. WebKit — and therefore the WebView this app
     * actually ships in — sends its own `gesturestart` / `gesturechange`
     * instead, carrying a cumulative `scale` rather than a delta. Without
     * these, pinching does nothing in the built app while working perfectly in
     * the harness browser, which is the most misleading way for a gesture to
     * be broken.
     *
     * Not in `lib.dom`, because they are WebKit's alone.
     */
    let from = 1;

    const onGestureStart = (raw: Event) => {
      raw.preventDefault();
      const e = raw as GestureEvent;
      const r = stage.current?.getBoundingClientRect();
      if (!r) return;
      const shown = r.width / doc.crop.width;
      anchor.current = {
        doc: { x: (e.clientX - r.left) / shown, y: (e.clientY - r.top) / shown },
        client: { x: e.clientX, y: e.clientY },
      };
      const store = useEditor.getState();
      from = store.fitToWindow ? shown : store.zoom;
    };

    const onGestureChange = (raw: Event) => {
      raw.preventDefault();
      const e = raw as GestureEvent;
      const r = stage.current?.getBoundingClientRect();
      if (!r) return;
      // Re-aimed on every step: a pinch drifts across the trackpad, and the
      // point being magnified should follow the fingers.
      const shown = r.width / doc.crop.width;
      anchor.current = {
        doc: { x: (e.clientX - r.left) / shown, y: (e.clientY - r.top) / shown },
        client: { x: e.clientX, y: e.clientY },
      };
      // `scale` is measured from the start of the gesture, not the last event,
      // so this multiplies the zoom the pinch began at rather than compounding.
      useEditor.getState().setZoom(from * e.scale);
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
    };
  }, [doc]);

  /**
   * Put the point that was under the cursor back under the cursor.
   *
   * Zooming about the middle of the pane is the thing that makes a canvas feel
   * like a map you are lost on: you aim at a detail, magnify, and it slides
   * away. Here the correction is measured off the page rather than calculated,
   * so it is right whether the capture is scrolled, centred in a pane bigger
   * than itself, or wearing a frame that insets it.
   *
   * A layout effect because it has to land in the same frame as the resize.
   * One tick later and the capture visibly jumps.
   */
  useLayoutEffect(() => {
    const el = viewport.current;
    const r = stage.current?.getBoundingClientRect();
    const v = el?.getBoundingClientRect();
    // A zoom nobody aimed — the toolbar's buttons, ⌘+, the menu — keeps the
    // middle of the pane instead. Without it every step of the toolbar zoom
    // walks off towards the top-left corner, since that is where a scroll
    // container's origin is and there is nothing else asking to be kept.
    const held =
      anchor.current ??
      (middle.current && v && { doc: middle.current, client: { x: v.left + v.width / 2, y: v.top + v.height / 2 } });
    anchor.current = null;

    if (!held || !el || !r) return;

    el.scrollLeft += r.left + held.doc.x * zoom - held.client.x;
    el.scrollTop += r.top + held.doc.y * zoom - held.client.y;
  }, [zoom]);

  /**
   * Where the middle of the pane is, in the capture's own coordinates.
   *
   * Recorded after every commit — and after the correction above, so what it
   * holds during the next zoom is where the pane was actually looking when that
   * zoom began. A layout effect declared *after* the one that reads it, because
   * within a component they run in the order they are written.
   */
  useLayoutEffect(() => {
    const el = viewport.current;
    const r = stage.current?.getBoundingClientRect();
    if (!el || !r) return;
    const v = el.getBoundingClientRect();
    middle.current = {
      x: (v.left + v.width / 2 - r.left) / zoom,
      y: (v.top + v.height / 2 - r.top) / zoom,
    };
  });

  /**
   * Space picks the canvas up.
   *
   * Held rather than toggled, which is what every canvas app does and what the
   * hand cursor promises. `preventDefault` on the way down stops two things:
   * the pane scrolling a page, and — the one that looks like a bug — the last
   * button clicked being pressed again, since a focused button treats space as
   * a click.
   */
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      if (isEditingText(document.activeElement)) return;
      e.preventDefault();
      setHandOpen(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setHandOpen(false);
    };
    // Switching away with space held would otherwise leave the canvas showing
    // a hand it will not honour.
    const clear = () => setHandOpen(false);

    // On the way down, not on the way back up. A window listener in the bubble
    // phase is the *last* thing a key reaches, and anything that claims a chord
    // on the capture phase — `useKeymap` does, for every shortcut it owns —
    // stops the event dead before it ever gets there. The hand has to be
    // claimed where nothing can have swallowed it yet.
    window.addEventListener("keydown", down, { capture: true });
    window.addEventListener("keyup", up, { capture: true });
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", down, { capture: true });
      window.removeEventListener("keyup", up, { capture: true });
      window.removeEventListener("blur", clear);
    };
  }, []);

  /**
   * Start a pan, before the canvas underneath can start anything else.
   *
   * On the capture phase and stopping there: a press with space held must not
   * also reach the stage, or letting go would leave a rectangle behind
   * wherever the pan happened to end.
   */
  const onViewportPointerDown = (e: React.PointerEvent) => {
    const el = viewport.current;
    if (!el) return;
    // The middle button is the same gesture with the other hand, and is what
    // people who came from a CAD package or a browser reach for first.
    if (!handOpen && e.button !== 1) return;

    e.preventDefault();
    e.stopPropagation();

    const from = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    pan.current = from;
    setPanning(true);

    // Listeners on the window rather than `setPointerCapture` on this element,
    // and that is the whole of the bug this replaced: capture on a *scroll
    // container* is not something to rely on. The pointer is being used to
    // change the very thing it is captured by, and a pan that outruns the
    // scroll leaves the pointer over a different element mid-gesture. The pin
    // window learned the same lesson about AppKit's drag loop — see `PinApp`.
    //
    // The window also keeps the drag alive past the edge of the pane, which is
    // exactly where a pan wants to end up.
    const move = (m: PointerEvent) => {
      // The canvas follows the hand, so the scroll goes the other way.
      el.scrollLeft = from.left - (m.clientX - from.x);
      el.scrollTop = from.top - (m.clientY - from.y);
    };
    // Deliberately not ended by letting go of space: a pan that stopped
    // halfway because a thumb lifted early would be its own small annoyance.
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      pan.current = null;
      setPanning(false);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // The hover cursor has to say which gesture Alt is about to produce — the
  // whole bug being fixed here was a cursor promising a move that never came.
  // Reset on blur: switching away with Alt held would otherwise leave the
  // canvas advertising a draw-through that is no longer armed.
  useEffect(() => {
    const sync = (e: KeyboardEvent) => setAltDown(e.altKey);
    const clear = () => setAltDown(false);

    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
  }, []);

  // --------------------------------------------------------------- picking

  // Decode up front, while the user is still moving the cursor towards what
  // they want: the readout has to keep up with the pointer, so the first
  // sample can't be the one that waits for the file to be read.
  //
  // Sampling once it lands matters as much as starting it early. Arming the
  // picker over the thing you already wanted is the natural way to use it, and
  // without this the readout stays blank until the pointer happens to twitch.
  useEffect(() => {
    if (tool !== "pick") setSwatch(null);
    // Measuring reads the same decoded copy, to find the edges a dimension
    // line should snap to — so it wants the pixels ready just as early.
    if ((tool !== "pick" && tool !== "measure") || !doc) return;

    let live = true;
    void preloadPixels(doc.path)
      .then(() => {
        const p = pointer.current;
        if (!live || !p || tool !== "pick") return;
        const hex = sampleColor(doc.path, doc.crop.x + p.x, doc.crop.y + p.y);
        if (hex) setSwatch({ ...p, hex });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [tool, doc]);

  // Hand the decoded copy back when the document changes or the editor closes.
  // Keyed on the path alone so it survives every other change to the document —
  // a crop or a zoom must not throw away megabytes and re-read the file.
  useEffect(() => () => forgetPixels(), [doc?.path]);

  /**
   * Take the colour under the cursor.
   *
   * The hex goes to the clipboard as well as to the ink: the reason to pick a
   * colour off a screenshot is usually to paste it into a stylesheet, not only
   * to draw with it.
   */
  const pickAt = useCallback(
    async (p: Point) => {
      if (!doc) return;
      const at = () => sampleColor(doc.path, doc.crop.x + p.x, doc.crop.y + p.y);

      // A click can beat the decode: press the shortcut and click straight
      // through, and the pixels aren't there yet. Waiting is much better than
      // a click that silently does nothing.
      let hex = at();
      if (!hex) {
        await preloadPixels(doc.path).catch(() => {});
        hex = at();
      }
      if (!hex) return;

      const store = useEditor.getState();
      store.setStyle({ color: hex });
      store.setTool(store.pickReturn);
      setSwatch(null);
      void writeText(hex)
        .then(() => onNotify?.(`Picked ${hex} — copied`))
        .catch(() => onNotify?.(`Picked ${hex}`));
    },
    [doc, onNotify],
  );

  // ------------------------------------------------------------- coordinates

  const toDoc = useCallback(
    (e: { clientX: number; clientY: number }): Point => {
      const r = stage.current?.getBoundingClientRect();
      if (!r) return { x: 0, y: 0 };
      return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
    },
    [zoom],
  );

  const clampToDoc = useCallback(
    (p: Point): Point => {
      if (!doc) return p;
      return {
        x: Math.max(0, Math.min(p.x, doc.crop.width)),
        y: Math.max(0, Math.min(p.y, doc.crop.height)),
      };
    },
    [doc],
  );

  /**
   * Everything the shapes being dragged could line up with.
   *
   * Rebuilt on every pointer move rather than cached at the start of the drag.
   * It is a handful of rectangles even on a heavily marked-up capture, and the
   * cache would have to be invalidated by anything that adds, deletes or
   * restyles a shape mid-gesture — which is exactly the sort of bookkeeping
   * that goes wrong quietly.
   */
  const snapTargets = useCallback(
    (moving: Iterable<string>) =>
      doc
        ? targetsFor(useEditor.getState().annotations, new Set(moving), docSize(doc))
        : [],
    [doc],
  );

  // ------------------------------------------------------------- interactions

  const startCreate = (e: React.PointerEvent) => {
    const store = useEditor.getState();
    const origin = clampToDoc(toDoc(e));
    const id = crypto.randomUUID();

    store.snapshot();

    if (tool === "step") {
      store.add({
        id,
        kind: "step",
        x: origin.x,
        y: origin.y,
        radius: stepRadius(style),
        label: store.nextStepLabel(),
        style: { ...style },
      });
      return;
    }

    if (tool === "text") {
      store.add({
        id,
        kind: "text",
        x: origin.x,
        y: origin.y,
        width: 0,
        height: 0,
        text: "",
        style: { ...style },
      });
      setEditingId(id);
      return;
    }

    if (tool === "pen") {
      store.add({ id, kind: "pen", points: [origin], style: { ...style } });
      drag.current = { kind: "create", id, origin };
      return;
    }

    if (tool === "crop") {
      drag.current = { kind: "crop", origin };
      store.setPendingCrop({ x: origin.x, y: origin.y, width: 0, height: 0 });
      return;
    }

    if (tool === "grab") {
      drag.current = { kind: "grab", origin };
      setGrabbing({ x: origin.x, y: origin.y, width: 0, height: 0 });
      return;
    }

    if (tool === "arrow" || tool === "line" || tool === "measure") {
      store.add({
        id,
        kind: tool,
        x1: origin.x,
        y1: origin.y,
        x2: origin.x,
        y2: origin.y,
        style: { ...style },
      });
    } else if (BOX_TOOLS.includes(tool as BoxKind)) {
      store.add({
        id,
        kind: tool as BoxKind,
        x: origin.x,
        y: origin.y,
        width: 0,
        height: 0,
        style: { ...style },
      });
    } else {
      return;
    }

    drag.current = { kind: "create", id, origin };
  };

  const onStagePointerDown = (e: React.PointerEvent) => {
    if (!doc || e.button !== 0) return;

    // Committing a text edit by clicking away should not also start a new
    // shape, so absorb this click.
    if (editingId) {
      setEditingId(null);
      return;
    }

    if (tool === "pick") {
      void pickAt(clampToDoc(toDoc(e)));
      return;
    }

    if (tool === "select") {
      useEditor.getState().clearSelection();
      return;
    }

    // Text places a caret instead of dragging out a shape.
    //
    // `preventDefault` is what makes it work at all: without it the browser
    // moves focus to the stage as this same click finishes, which blurs the
    // textarea we are about to mount — and a blurred empty text annotation is
    // discarded, so the box vanishes the instant it appears. Capturing the
    // pointer would compound it, and text needs no drag anyway.
    if (tool === "text") {
      e.preventDefault();
      startCreate(e);
      return;
    }

    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    startCreate(e);
  };

  /**
   * Press on an existing annotation to move it, whatever tool is active.
   *
   * Previously this only worked with the select tool, so a press on a shape
   * while (say) the rectangle tool was up drew a new rectangle on top of it —
   * even though the shape has always shown a move cursor on hover. The cursor
   * was telling the truth about what should happen; the handler wasn't.
   *
   * Holding Alt draws straight through instead. Without that escape hatch a
   * highlight covering most of the capture would make everything beneath it
   * unreachable: there would be nowhere left to start a drag.
   */
  const onShapePointerDown = (e: React.PointerEvent, id: string) => {
    if (!doc || e.button !== 0) return;
    // The eyedropper reads the capture underneath, so a press on a shape must
    // fall through to the stage rather than pick the shape up.
    if (tool === "pick") return;
    if (e.altKey && tool !== "select") return;

    // Double-press on a text box, detected by hand. The container's
    // onDoubleClick below works in a plain browser but not in WKWebView, where
    // the first press selects the shape, the selection handles re-render it,
    // and the click counter dies with the old element — so in the shipped app
    // a text annotation could be selected, moved, deleted, but never edited
    // again. Two presses on the same shape inside the double-click window are
    // the same gesture, whatever the engine makes of it.
    const now = Date.now();
    const again =
      lastShapePress.current !== null &&
      lastShapePress.current.id === id &&
      now - lastShapePress.current.at < 450;
    lastShapePress.current = { id, at: now };
    if (again) {
      const target = annotations.find((a) => a.id === id);
      if (target && (target.kind === "text" || target.kind === "callout")) {
        e.stopPropagation();
        setEditingId(id);
        return;
      }
    }

    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);

    const store = useEditor.getState();
    const already = store.selectedIds.includes(id);

    // Shift extends the selection; a plain click on an unselected shape
    // replaces it, but on an already-selected one preserves the group so a
    // multi-shape drag isn't broken by the click that starts it.
    const ids = e.shiftKey
      ? already
        ? store.selectedIds.filter((x) => x !== id)
        : [...store.selectedIds, id]
      : already
        ? store.selectedIds
        : [id];

    store.select(ids);
    if (ids.length === 0) return;

    store.snapshot();
    drag.current = {
      kind: "move",
      ids,
      origin: toDoc(e),
      snapshot: store.annotations.filter((a) => ids.includes(a.id)),
    };
  };

  // Resize handles follow the same rule as the shapes they belong to: if the
  // chrome is on screen and showing a resize cursor, dragging it must resize,
  // whichever tool happens to be selected.
  const onHandlePointerDown = (e: React.PointerEvent, id: string, handle: HandleId) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);

    const store = useEditor.getState();
    const target = store.annotations.find((a) => a.id === id);
    if (!target) return;

    store.snapshot();

    if (handle === "rotate") {
      const centre = centreOf(boundsOf(target));
      drag.current = {
        kind: "rotate",
        id,
        grab: angleFrom(centre, toDoc(e)) - angleOf(target),
        snapshot: target,
      };
      return;
    }

    drag.current = { kind: "resize", id, handle, snapshot: target };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    pointer.current = toDoc(e);

    if (tool === "pick" && doc) {
      const p = pointer.current;
      const hex = sampleColor(doc.path, doc.crop.x + p.x, doc.crop.y + p.y);
      setSwatch(hex ? { x: p.x, y: p.y, hex } : null);
      return;
    }

    const active = drag.current;
    if (!active || !doc) return;

    const store = useEditor.getState();
    const point = clampToDoc(toDoc(e));

    switch (active.kind) {
      case "crop": {
        store.setPendingCrop({
          x: Math.min(active.origin.x, point.x),
          y: Math.min(active.origin.y, point.y),
          width: Math.abs(point.x - active.origin.x),
          height: Math.abs(point.y - active.origin.y),
        });
        break;
      }

      case "grab": {
        setGrabbing({
          x: Math.min(active.origin.x, point.x),
          y: Math.min(active.origin.y, point.y),
          width: Math.abs(point.x - active.origin.x),
          height: Math.abs(point.y - active.origin.y),
        });
        break;
      }

      case "create": {
        const target = store.annotations.find((a) => a.id === active.id);
        if (!target) break;
        // Cleared up front so that letting go of Shift, or taking hold of
        // Command, drops the lines from the previous move as well as the pull.
        setGuides([]);

        if (isPen(target)) {
          const last = target.points[target.points.length - 1];
          // Drop samples the hand didn't really make. Pointer events arrive far
          // faster than the wrist moves, and every duplicate point is another
          // coordinate pair carried inside the saved PNG for ever.
          if (Math.hypot(point.x - last.x, point.y - last.y) >= FREEHAND_MIN_STEP) {
            store.update(active.id, { points: [...target.points, point] });
          }
        } else if (isLine(target)) {
          let end = point;
          if (e.shiftKey) end = snapAngle(active.origin, point);
          // The head is the part being aimed, so it lines up with the document
          // like any other moving edge — unless Shift is holding it to an
          // angle, which is a stronger statement about where it should point.
          else if (!e.metaKey) {
            const snap = snapPoint(end, snapTargets([active.id]), SNAP_REACH / zoom);
            end = { x: end.x + snap.dx, y: end.y + snap.dy };
            setGuides(snap.guides);
          }
          if (target.kind === "measure" && doc) {
            // Both ends are pulled onto real edges, live, so the number
            // settles on the gap that is actually there rather than on where
            // the hand happened to stop. Alt holds the raw drag, for measuring
            // something the image gives no edge for.
            const snapped = e.altKey ? null : snapEnds(doc, active.origin, end);
            store.update(active.id, {
              x1: snapped?.from.x ?? active.origin.x,
              y1: snapped?.from.y ?? active.origin.y,
              x2: snapped?.to.x ?? end.x,
              y2: snapped?.to.y ?? end.y,
            });
          } else {
            store.update(active.id, { x2: end.x, y2: end.y });
          }
        } else if (isBox(target)) {
          let end = point;
          if (e.shiftKey) end = snapSquare(active.origin, point);
          else if (!e.metaKey) {
            // Only the corner under the hand snaps. Snapping the whole box
            // would move the corner it was started from, which is nailed to
            // the spot the drag began.
            const snap = snapPoint(end, snapTargets([active.id]), SNAP_REACH / zoom);
            end = { x: end.x + snap.dx, y: end.y + snap.dy };
            setGuides(snap.guides);
          }
          store.update(active.id, {
            x: Math.min(active.origin.x, end.x),
            y: Math.min(active.origin.y, end.y),
            width: Math.abs(end.x - active.origin.x),
            height: Math.abs(end.y - active.origin.y),
          });
        }
        break;
      }

      case "move": {
        const raw = toDoc(e);
        let dx = raw.x - active.origin.x;
        let dy = raw.y - active.origin.y;
        // Shift locks movement to the dominant axis.
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }

        // Where the whole selection would land, as one box: dragging three
        // shapes at once lines *the group* up with the page, which is what the
        // marching rectangle on screen looks like it should do.
        const base = unionOf(active.snapshot.map(spunBoundsOf));
        const snap =
          base && !e.metaKey
            ? snapBox(
                { ...base, x: base.x + dx, y: base.y + dy },
                snapTargets(active.ids),
                SNAP_REACH / zoom,
              )
            : NO_SNAP;
        // Shift has already pinned one axis to zero. Letting a snap pull on
        // that axis would quietly undo the constraint the user is holding down.
        const lockX = e.shiftKey && dx === 0;
        const lockY = e.shiftKey && dy === 0;
        if (!lockX) dx += snap.dx;
        if (!lockY) dy += snap.dy;
        setGuides(snap.guides.filter((g) => (g.axis === "x" ? !lockX : !lockY)));

        store.replaceAll(
          store.annotations.map((a) => {
            const original = active.snapshot.find((s) => s.id === a.id);
            // Moved from where the shape stood when the drag began, not from
            // where it is now, so the pointer can't drift away from it.
            return original ? movedBy(original, dx, dy) : a;
          }),
        );
        break;
      }

      case "resize": {
        const original = active.snapshot;

        // The two ends of a line are the only handles that are not on a box,
        // and a line is the only shape that has them.
        if (active.handle === "start" || active.handle === "end") {
          if (!isLine(original)) break;
          const end = e.shiftKey
            ? snapAngle(
                active.handle === "start" ? { x: original.x2, y: original.y2 } : { x: original.x1, y: original.y1 },
                point,
              )
            : point;
          store.update(
            active.id,
            active.handle === "start" ? { x1: end.x, y1: end.y } : { x2: end.x, y2: end.y },
          );
          break;
        }

        const handle = active.handle;
        const deg = angleOf(original);

        // Only a shape still square to the page can line up with anything: a
        // turned edge is neither vertical nor horizontal, so there would be no
        // honest line to draw and nothing for the dragged corner to meet.
        setGuides([]);
        let at = point;
        if (deg === 0 && !e.shiftKey && !e.metaKey) {
          const snap = snapPoint(point, snapTargets([active.id]), SNAP_REACH / zoom);
          // A side handle is already holding one axis still, and a pull on
          // that axis would draw a line the shape never moved to.
          at = {
            x: point.x + (holdsWidth(handle) ? 0 : snap.dx),
            y: point.y + (holdsHeight(handle) ? 0 : snap.dy),
          };
          setGuides(
            snap.guides.filter((g) =>
              g.axis === "x" ? !holdsWidth(handle) : !holdsHeight(handle),
            ),
          );
        }

        // Everything from here happens in unspun space, where the shape is
        // square to the axes again and this is the corner-drag arithmetic it
        // always was. Only the way in and the way back out know about angles.
        const local = boundsOf(original);
        const b = unspunBox(local, deg);
        const anchor = handleAnchor(b, handle);
        const to = unspun(at, deg);
        // Shift squares the shape, which only means anything on a corner: a
        // side handle is already holding one axis still.
        const corner = !holdsWidth(handle) && !holdsHeight(handle);
        const asked = resizedBox(b, handle, anchor, e.shiftKey && corner ? snapSquare(anchor, to) : to);
        const box = respunBox(asked, deg);
        // The shape turns about its own centre and the resize just moved that
        // centre; this is the nudge that puts the dragged edge back under the
        // pointer. Anything positioned alongside the box takes it too.
        const back = { x: box.x - asked.x, y: box.y - asked.y };

        if (isPen(original)) {
          // A scribble has no width and height of its own, so it is fitted into
          // the new box instead: every sample keeps its position within the
          // stroke. A flat stroke keeps its axis rather than collapsing to a
          // point it could never be dragged back out of.
          const sx = b.width < 0.5 ? 1 : asked.width / b.width;
          const sy = b.height < 0.5 ? 1 : asked.height / b.height;
          const skew = { x: b.x - local.x, y: b.y - local.y };
          store.update(active.id, {
            points: original.points.map((p) => ({
              x: asked.x + (p.x + skew.x - b.x) * sx + back.x,
              y: asked.y + (p.y + skew.y - b.y) * sy + back.y,
            })),
          });
          break;
        }

        // An overlay holds its proportions: a stretched screenshot looks like a
        // mistake, and there is no reason to want one. Shift is already taken
        // by the square snap above, so distorting is simply not offered.
        if (isImage(original)) {
          const fitted = fitToBox(original, asked, anchor);
          // Holding the ratio means a side drag grows the other axis as well,
          // and it has to grow both ways from the middle or the picture walks
          // sideways as it is pulled.
          if (holdsWidth(handle)) fitted.x = anchor.x - fitted.width / 2;
          if (holdsHeight(handle)) fitted.y = anchor.y - fitted.height / 2;
          store.update(active.id, {
            ...fitted,
            x: fitted.x + back.x,
            y: fitted.y + back.y,
          });
          break;
        }

        if (isBox(original)) store.update(active.id, box);
        break;
      }

      case "rotate": {
        const centre = centreOf(boundsOf(active.snapshot));
        // Deliberately the raw point rather than the clamped one: the grip
        // swings well outside the capture at any angle off the vertical, and
        // clamping it would stick the shape at the edge of the page.
        let deg = angleFrom(centre, toDoc(e)) - active.grab;
        // `grab` already carries the shape's own angle, so what comes out here
        // is where it ends up rather than how far it has come — and that is
        // what Shift lands on a right angle.
        if (e.shiftKey) deg = snapTurn(0, deg);
        store.update(active.id, { angle: normalizeAngle(deg) });
        break;
      }
    }
  };

  const onPointerUp = () => {
    const active = drag.current;
    drag.current = null;
    setGuides([]);
    if (!active) return;

    const store = useEditor.getState();

    if (active.kind === "grab") {
      // A click rather than a drag reads the whole capture. Dragging a box
      // over one paragraph is the point of the tool, but "just read all of
      // it" is the other half of the job and shouldn't need a careful drag
      // from corner to corner.
      const area = grabbing && grabbing.width > 4 && grabbing.height > 4 ? grabbing : null;
      setGrabbing(null);
      onScan?.(area);
      return;
    }

    if (active.kind === "create") {
      const created = store.annotations.find((a) => a.id === active.id);

      if (created?.kind === "callout") {
        // A callout is a box you then type into, so it goes straight into edit
        // rather than waiting to be double-clicked. A click that dragged no
        // box still makes one: unlike a rectangle, an empty callout is a
        // perfectly good starting point — it is about to be filled with words.
        const b = boundsOf(created);
        store.update(created.id, {
          width: Math.max(b.width, CALLOUT_MIN.width),
          height: Math.max(b.height, CALLOUT_MIN.height),
        });
        setEditingId(created.id);
        return;
      }

      // A click with a drawing tool that produced nothing leaves an empty shape
      // behind; drop it and the history entry that came with it.
      if (created && isDegenerate(created)) {
        store.remove([active.id]);
        store.undo();
      }
    }

    // Narrowing a callout rewraps its text, which may now need more height
    // than the drag left it.
    if (active.kind === "resize") {
      const shape = store.annotations.find((a) => a.id === active.id);
      if (shape?.kind === "callout") store.update(shape.id, fitCallout(shape));
    }
  };

  // ------------------------------------------------------------ text editing

  useEffect(() => {
    if (!editingId) return;
    const exists = annotations.some((a) => a.id === editingId);
    if (!exists) setEditingId(null);
  }, [annotations, editingId]);

  const commitEdit = useCallback(() => {
    const store = useEditor.getState();
    const target = store.annotations.find((a) => a.id === editingId);
    setEditingId(null);
    if (!target) return;

    // An empty box of either sort is a mis-click, not content.
    if ((target.kind === "text" || target.kind === "callout") && !(target.text ?? "").trim()) {
      store.remove([target.id]);
      return;
    }

    if (target.kind === "callout") store.update(target.id, fitCallout(target));
  }, [editingId]);

  // Double-click a text annotation to edit it again. Not gated on the select
  // tool either: a press on a shape no longer starts a new one, so there is
  // nothing for this to collide with.
  const onDoubleClick = (e: React.MouseEvent) => {
    const hit = [...annotations].reverse().find((a) => {
      if (a.kind !== "text" && a.kind !== "callout") return false;
      const b = boundsOf(a);
      // Asked of the shape as it is stored, with the click turned back the
      // same way — a box tested against a spun shape would catch clicks off
      // its corners and miss ones squarely on it.
      const p = rotatePoint(toDoc(e), centreOf(b), -angleOf(a));
      return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
    });
    if (hit) setEditingId(hit.id);
  };

  /**
   * Right-click on the canvas.
   *
   * Follows the library's rule: a shape already in the selection keeps it, one
   * outside takes it over first. Otherwise "delete these three" would be
   * impossible — the click needed to reach the menu would have thrown the
   * selection away before the menu could act on it.
   */
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const id = (e.target as Element).closest("[data-annotation]")?.getAttribute("data-annotation");

    if (id && !selectedIds.includes(id)) useEditor.getState().select([id]);
    setMenu({ at: { x: e.clientX, y: e.clientY }, id: id ?? null });
  };

  const menuItems = (id: string | null): (MenuEntry | false | undefined)[] => {
    const store = useEditor.getState();
    const count = store.selectedIds.length;

    return [
      // First, and present whether or not there is a shape under the pointer:
      // this menu exists because pasting had no home outside the keyboard.
      actions && {
        label: "Paste image",
        icon: <IconOverlay />,
        shortcut: "Mod+V",
        run: actions.pasteImage,
      },
      Boolean(id) && "separator",
      Boolean(id) && {
        label: count > 1 ? `Duplicate ${count} annotations` : "Duplicate",
        icon: <IconCopy />,
        shortcut: "Mod+D",
        run: () => store.duplicateSelection(),
      },
      Boolean(id) && {
        label: "Copy style",
        icon: <IconBrush />,
        shortcut: "Mod+Alt+C",
        run: () => onNotify?.(store.copyStyle() ? "Style copied" : "Nothing selected"),
      },
      Boolean(id) &&
        store.clipboardStyle !== null && {
          label: count > 1 ? `Paste style onto ${count}` : "Paste style",
          icon: <IconBrush />,
          shortcut: "Mod+Alt+V",
          run: () => store.pasteStyle(),
        },
      Boolean(id) && "separator",
      Boolean(id) && {
        label: "Bring to front",
        icon: <IconLayers />,
        shortcut: "Mod+Shift+]",
        run: () => store.reorder("front"),
      },
      Boolean(id) && {
        label: "Send to back",
        icon: <IconLayers />,
        shortcut: "Mod+Shift+[",
        run: () => store.reorder("back"),
      },
      Boolean(id) && "separator",
      Boolean(id) && {
        label: count > 1 ? `Delete ${count} annotations` : "Delete",
        icon: <IconTrash />,
        shortcut: "Backspace",
        danger: true,
        run: () => store.deleteSelection(),
      },
      "separator",
      annotations.length > 0 && {
        label: "Select all annotations",
        icon: <IconSelect />,
        shortcut: "Mod+A",
        run: () => store.selectAll(),
      },
      actions && {
        label: "Copy image",
        icon: <IconCopy />,
        shortcut: "Mod+C",
        run: actions.copy,
      },
      actions && {
        label: "Export flattened PNG…",
        icon: <IconImage />,
        shortcut: "Mod+E",
        run: actions.exportFlat,
      },
    ];
  };

  if (!doc) return null;

  const editing = annotations.find((a) => a.id === editingId);
  // The hand outranks every tool's cursor: while space is down the canvas is
  // not something you can draw on, and saying otherwise would be a lie the
  // very next click exposes.
  const hand = panning ? "grabbing" : handOpen ? "grab" : null;
  const cursor =
    hand ?? (tool === "select" ? "default" : tool === "text" ? "text" : "crosshair");
  const showSwatch = tool === "pick" && swatch;

  // The frame wraps the stage rather than being drawn inside it. Every
  // annotation coordinate is relative to the capture's top-left, and a margin
  // painted *within* the stage would move that origin — so the margin lives
  // one element out, where nothing has to know about it.
  const frame = hasBackdrop(backdrop)
    ? backdropMetrics(backdrop, doc.crop.width, doc.crop.height)
    : null;
  const frameFill = frame ? fillById(backdrop.fill) : null;
  const bareCanvas = hasBareCanvas(doc);

  return (
    <div
      ref={viewport}
      className={clsx(
        "relative flex-1 overflow-auto bg-inset",
        // Every shape, handle and grip inside says something about itself with
        // a cursor of its own, and while the canvas is being pushed around
        // none of them is true. A descendant rule is the only thing that
        // outranks an SVG `cursor` attribute and an inline style at once.
        hand === "grab" && "[&_*]:cursor-grab",
        hand === "grabbing" && "[&_*]:cursor-grabbing",
      )}
      style={{ cursor: hand ?? undefined }}
      onPointerDownCapture={onViewportPointerDown}
    >
      {/* Centred, but never at the cost of the far edge. A plain
          `justify-center` on a scroll container throws away the overflow on the
          *start* side: once the capture is wider than the pane, its left-hand
          third sits at a negative offset that no scroll position can reach, and
          the pane opens somewhere in the middle of the picture with no way back.
          Every gesture that steers by scrolling then dies against the clamp —
          which is what a pan that "does nothing" and a canvas that "jumps" both
          actually were. The safe keyword says centre it while it fits and pin it
          to the start once it does not. */}
      <div
        className="flex min-h-full min-w-full items-center-safe justify-center-safe"
        style={{ padding: PAD }}
      >
        <div
          className={clsx("shrink-0", !frame && "contents")}
          style={
            frame && frameFill
              ? {
                  padding: frame.pad * zoom,
                  background: fillToCss(frameFill),
                  lineHeight: 0,
                }
              : undefined
          }
        >
        <div
          ref={stage}
          className={clsx(
            "relative shrink-0 ring-1 ring-white/10",
            // The framed capture gets its own shadow, sized to the frame; the
            // unframed one keeps the editor's flat drop shadow.
            !frame && "shadow-[0_16px_60px_rgba(0,0,0,0.6)]",
          )}
          style={{
            width: doc.crop.width * zoom,
            height: doc.crop.height * zoom,
            cursor,
            ...(frame && {
              borderRadius: frame.radius * zoom,
              boxShadow: backdrop.shadow
                ? `0 ${frame.shadowOffset * zoom}px ${frame.shadowBlur * zoom}px rgba(0,0,0,0.45)`
                : "none",
            }),
            // Checkerboard shows through any transparency in the capture.
            backgroundImage:
              "linear-gradient(45deg,#1a1d22 25%,transparent 25%,transparent 75%,#1a1d22 75%)," +
              "linear-gradient(45deg,#1a1d22 25%,transparent 25%,transparent 75%,#1a1d22 75%)",
            backgroundSize: "16px 16px",
            backgroundPosition: "0 0, 8px 8px",
            backgroundColor: "#101216",
          }}
          onPointerDown={onStagePointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
        >
          {/* The capture itself, windowed by the current crop — which may be
              larger than the capture, in which case the fill behind it is what
              shows in the part with no picture. */}
          <div
            className="absolute inset-0 overflow-hidden"
            style={{
              imageRendering: zoom > 1.5 ? "pixelated" : "auto",
              borderRadius: frame ? frame.radius * zoom : undefined,
              background:
                bareCanvas && doc.canvasFill !== "transparent" ? doc.canvasFill : undefined,
            }}
          >
            <img
              src={doc.src}
              alt="Capture"
              draggable={false}
              className="absolute max-w-none select-none"
              style={{
                left: -doc.crop.x * zoom,
                top: -doc.crop.y * zoom,
                width: doc.naturalWidth * zoom,
                height: doc.naturalHeight * zoom,
              }}
            />
          </div>

          <AnnotationLayer
            doc={doc}
            annotations={annotations}
            selectedIds={selectedIds}
            zoom={zoom}
            editingId={editingId}
            shapeCursor={altDown && tool !== "select" ? "crosshair" : "move"}
            onShapePointerDown={onShapePointerDown}
            onHandlePointerDown={onHandlePointerDown}
          />

          <GuideLayer guides={guides} zoom={zoom} size={doc.crop} />

          {pendingCrop && <CropOverlay rect={pendingCrop} doc={doc} zoom={zoom} />}

          {/* The text-grab marquee. Deliberately unlike the crop overlay:
              nothing outside it is dimmed, because this box takes a copy of
              what it covers rather than throwing the rest away. */}
          {grabbing && grabbing.width > 0 && grabbing.height > 0 && (
            <div
              className="pointer-events-none absolute border border-accent bg-accent/10"
              style={{
                left: grabbing.x * zoom,
                top: grabbing.y * zoom,
                width: grabbing.width * zoom,
                height: grabbing.height * zoom,
              }}
            />
          )}

          {/* Follows the cursor rather than sitting in the toolbar: the whole
              job is telling you what is under the pointer *before* you commit
              to it, and the toolbar is nowhere near where you are looking. */}
          {showSwatch && (
            <div
              className="surface-pop pointer-events-none absolute flex items-center gap-1.5 rounded-md py-1 pr-2 pl-1"
              style={{ left: swatch.x * zoom + 16, top: swatch.y * zoom + 16 }}
            >
              <span
                className="size-3.5 rounded-[4px] ring-1 ring-white/25 ring-inset"
                style={{ background: swatch.hex }}
              />
              <span className="font-mono text-[11px] tabular-nums text-ink">{swatch.hex}</span>
            </div>
          )}

          {editing && (editing.kind === "text" || editing.kind === "callout") && (
            <TextEditor
              key={editing.id}
              value={editing.text ?? ""}
              x={boundsOf(editing).x * zoom}
              y={boundsOf(editing).y * zoom}
              // Typed at the angle it will be read at. The box is turned about
              // its own centre in both renderers, so the origin here is the
              // middle of the box rather than of the textarea, which on bare
              // text is not quite the same rectangle.
              spin={{
                deg: angleOf(editing),
                originX: (boundsOf(editing).width / 2) * zoom,
                originY: (boundsOf(editing).height / 2) * zoom,
              }}
              // On a callout the words sit on the fill, so they take the same
              // automatic ink the drawn shape would — typing has to look like
              // the result, or committing is a jump-cut.
              color={
                editing.kind === "callout"
                  ? contrastInk(editing.style.color)
                  : editing.style.color
              }
              fontSize={editing.style.fontSize * zoom}
              box={
                editing.kind === "callout"
                  ? {
                      width: boundsOf(editing).width * zoom,
                      height: boundsOf(editing).height * zoom,
                      padding: CALLOUT_PADDING * zoom,
                    }
                  : undefined
              }
              onChange={(text) => useEditor.getState().update(editing.id, { text })}
              onCommit={commitEdit}
            />
          )}
        </div>
        </div>
      </div>

      {menu && (
        <ContextMenu at={menu.at} items={menuItems(menu.id)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------- helpers

function isDegenerate(a: Annotation): boolean {
  if (isStep(a)) return false;
  if (a.kind === "text") return false;
  const b = boundsOf(a);
  return b.width < 2 && b.height < 2;
}

/** Snap a line to the nearest 15° increment. */
function snapAngle(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  const step = Math.PI / 12;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: from.x + Math.cos(angle) * len, y: from.y + Math.sin(angle) * len };
}

/**
 * Pull both ends of a measurement onto the edges they were aimed at.
 *
 * Each end is drawn *outwards* along the line, so the two searches look in
 * opposite directions: the start reaches back past itself and the end reaches
 * on past itself, which is how a rough drag across a gap lands on the two
 * facing edges rather than both snapping to the same one.
 *
 * Document coordinates in, document coordinates out — the sampler works in
 * source-image pixels, so the crop offset goes on and comes back off here.
 */
function snapEnds(
  doc: { path: string; crop: Rect },
  from: Point,
  to: Point,
): { from: Point; to: Point } | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  // Too short to have a direction worth trusting.
  if (len < 6) return null;

  const dir = { x: dx / len, y: dy / len };
  const back = { x: -dir.x, y: -dir.y };
  const { x: ox, y: oy } = doc.crop;

  const snap = (p: Point, d: { x: number; y: number }): Point => {
    const hit = snapToEdge(doc.path, ox + p.x, oy + p.y, d);
    return hit ? { x: hit.x - ox, y: hit.y - oy } : p;
  };

  return { from: snap(from, back), to: snap(to, dir) };
}

/** Force a box to a square, sized by the larger axis. */
function snapSquare(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: from.x + Math.sign(dx) * side, y: from.y + Math.sign(dy) * side };
}

/**
 * The lines that appear while something is being dragged into line.
 *
 * Magenta because every other mark on this canvas is either the user's ink or
 * the accent the selection chrome is drawn in, and a guide has to be legible
 * as *not part of the picture* at a glance — including over an annotation
 * drawn in the accent colour itself.
 */
const GUIDE_INK = "#FF2D9E";

function GuideLayer({
  guides,
  zoom,
  size,
}: {
  guides: Guide[];
  zoom: number;
  size: { width: number; height: number };
}) {
  if (guides.length === 0) return null;

  return (
    <svg
      className="pointer-events-none absolute top-0 left-0 overflow-visible"
      width={size.width * zoom}
      height={size.height * zoom}
    >
      {guides.map((g, i) =>
        g.kind === "align" ? (
          <line
            key={i}
            x1={(g.axis === "x" ? g.at : g.from) * zoom}
            y1={(g.axis === "x" ? g.from : g.at) * zoom}
            x2={(g.axis === "x" ? g.at : g.to) * zoom}
            y2={(g.axis === "x" ? g.to : g.at) * zoom}
            stroke={GUIDE_INK}
            strokeWidth={1}
            // A guide is a statement about a single coordinate, so it has to
            // land on a single row of pixels rather than being smeared across
            // two by the half-pixel the zoom happens to leave it on.
            shapeRendering="crispEdges"
          />
        ) : (
          <GapBar key={i} gap={g} zoom={zoom} />
        ),
      )}
    </svg>
  );
}

/** One matched gap: a bar with a tick at each end and its size beside it. */
function GapBar({ gap, zoom }: { gap: GapGuide; zoom: number }) {
  const flat = gap.axis === "x";
  const x1 = (flat ? gap.from : gap.at) * zoom;
  const y1 = (flat ? gap.at : gap.from) * zoom;
  const x2 = (flat ? gap.to : gap.at) * zoom;
  const y2 = (flat ? gap.at : gap.to) * zoom;

  const CAP = 4;
  const label = String(Math.round(gap.size));
  const boxWidth = label.length * 6 + 8;
  // Off the bar rather than on it: the number is what the bar is *for*, and a
  // label straddling the line hides the thing being measured.
  const cx = flat ? (x1 + x2) / 2 : x2 + boxWidth / 2 + 6;
  const cy = flat ? y1 - 9 : (y1 + y2) / 2;

  return (
    <g>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={GUIDE_INK} strokeWidth={1} />
      {[
        [x1, y1],
        [x2, y2],
      ].map(([x, y], i) => (
        <line
          key={i}
          x1={flat ? x : x - CAP}
          y1={flat ? y - CAP : y}
          x2={flat ? x : x + CAP}
          y2={flat ? y + CAP : y}
          stroke={GUIDE_INK}
          strokeWidth={1}
        />
      ))}
      <rect
        x={cx - boxWidth / 2}
        y={cy - 7}
        width={boxWidth}
        height={14}
        rx={3}
        fill={GUIDE_INK}
      />
      <text
        x={cx}
        y={cy + 4}
        textAnchor="middle"
        fill="#fff"
        fontSize={10}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
      >
        {label}
      </text>
    </g>
  );
}

function CropOverlay({ rect, doc, zoom }: { rect: Rect; doc: { crop: Rect }; zoom: number }) {
  const applyCrop = useEditor((s) => s.applyCrop);
  const setPendingCrop = useEditor((s) => s.setPendingCrop);
  if (rect.width < 1 || rect.height < 1) return null;

  return (
    <div className="pointer-events-none absolute inset-0">
      <div
        className="absolute inset-0 bg-black/55"
        style={{
          clipPath: `polygon(
            0 0, 100% 0, 100% 100%, 0 100%, 0 0,
            ${rect.x * zoom}px ${rect.y * zoom}px,
            ${rect.x * zoom}px ${(rect.y + rect.height) * zoom}px,
            ${(rect.x + rect.width) * zoom}px ${(rect.y + rect.height) * zoom}px,
            ${(rect.x + rect.width) * zoom}px ${rect.y * zoom}px,
            ${rect.x * zoom}px ${rect.y * zoom}px
          )`,
        }}
      />
      <div
        className="absolute outline-2 outline-accent"
        style={{
          left: rect.x * zoom,
          top: rect.y * zoom,
          width: rect.width * zoom,
          height: rect.height * zoom,
        }}
      >
        {/* Rule-of-thirds guides, the usual crop affordance. */}
        <div className="absolute inset-0 grid grid-cols-3 grid-rows-3">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="border border-white/15" />
          ))}
        </div>
      </div>
      {/* The size, and the two verbs. The buttons are the fix for a real
          report: Enter applied the crop and Escape dropped it, but nothing on
          screen said so — you drew a marquee, got a number, and stood there.
          A pending crop is a question, and a question needs its answers where
          you are looking. Keyboard still works; the buttons name the keys.

          `pointer-events-auto` because the whole overlay opts out (marks and
          guides must not eat canvas drags), and `stopPropagation` on the way
          down so pressing a button does not also start a fresh marquee on the
          canvas underneath it. */}
      <div
        className="surface-pop pointer-events-auto absolute flex items-center gap-1 rounded-md py-0.5 pr-0.5 pl-2 font-mono text-[11px] tabular-nums text-ink"
        style={{ left: rect.x * zoom, top: (rect.y + rect.height) * zoom + 8 }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {Math.round(rect.width)} × {Math.round(rect.height)}
        <span className="mx-1 h-4 w-px bg-line" />
        <button
          type="button"
          title="Keep the whole capture (esc)"
          onClick={() => setPendingCrop(null)}
          className="h-6 rounded px-2 font-sans text-[11.5px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="button"
          title="Crop to this (⏎)"
          onClick={() => applyCrop(rect)}
          className="flex h-6 items-center gap-1 rounded bg-accent px-2 font-sans text-[11.5px] font-semibold text-accent-fg transition-colors hover:bg-accent-hi"
        >
          Crop
          <span className="opacity-60">⏎</span>
        </button>
      </div>
      <span className="sr-only">{doc.crop.width}</span>
    </div>
  );
}

function TextEditor({
  value,
  x,
  y,
  color,
  fontSize,
  box,
  spin,
  onChange,
  onCommit,
}: {
  value: string;
  x: number;
  y: number;
  color: string;
  fontSize: number;
  /** Set for a callout, whose text is bound to a box already on screen. */
  box?: { width: number; height: number; padding: number };
  /** How far the shape is turned, and about which point of this element. */
  spin: { deg: number; originX: number; originY: number };
  onChange: (v: string) => void;
  onCommit: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const mountedAt = useRef(Date.now());

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  /**
   * The typing's own little history, so ⌘Z while editing undoes *words*, not
   * the whole box.
   *
   * It has to live here and it has to be hand-rolled, for reasons that are
   * each one step from obvious. ⌘Z never arrives as a keydown — the Edit menu
   * owns the accelerator and the app re-emits it as `editor:edit` — so the
   * textarea's native undo stack is unreachable. And this is a controlled
   * textarea, whose native stack is broken anyway: React rewrites `value` on
   * every change, which WebKit's undo manager treats as somebody else's edit.
   * So bursts of typing are snapshotted here, coalesced at a pause the way an
   * editor's typing-undo is, and popped when the menu event lands while this
   * textarea has focus. The store never sees any of it: one committed box is
   * one history entry there, whatever the journey.
   */
  const edits = useRef<{ undo: string[]; redo: string[]; lastPush: number }>({
    undo: [],
    redo: [],
    lastPush: 0,
  });
  const latest = useRef(value);
  latest.current = value;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    const unlisten = listen<"undo" | "redo">("editor:edit", (event) => {
      if (document.activeElement !== ref.current) return;
      const h = edits.current;
      if (event.payload === "undo") {
        const prev = h.undo.pop();
        if (prev === undefined) return;
        h.redo.push(latest.current);
        changeRef.current(prev);
      } else {
        const next = h.redo.pop();
        if (next === undefined) return;
        h.undo.push(latest.current);
        changeRef.current(next);
      }
    });
    return () => void unlisten.then((fn) => fn());
  }, []);

  /** A change, with the value it replaces remembered at burst boundaries. */
  const edit = (next: string) => {
    const h = edits.current;
    const now = Date.now();
    // A pause in the typing starts a new undo step, so ⌘Z walks back through
    // phrases rather than one letter or the whole text.
    if (now - h.lastPush > 900) h.undo.push(latest.current);
    h.lastPush = now;
    h.redo = [];
    onChange(next);
  };

  /**
   * Ignore a blur that lands in the same beat as mounting.
   *
   * Belt and braces alongside the `preventDefault` on the creating click: a
   * stray focus shift here would silently delete a brand-new empty box, which
   * looks exactly like the text tool being broken.
   */
  const onBlur = () => {
    if (Date.now() - mountedAt.current < 250) {
      ref.current?.focus();
      return;
    }
    onCommit();
  };

  const metrics = measureText(value, fontSize);
  // Inside a box the text wraps, so the caret's resting place depends on the
  // wrapped line count, not the typed one.
  const lineCount = box
    ? wrapText(value, fontSize, box.width - box.padding * 2).length
    : metrics.lines.length;

  return (
    <textarea
      ref={ref}
      value={value}
      spellCheck={false}
      onChange={(e) => edit(e.target.value)}
      onBlur={onBlur}
      onKeyDown={(e) => {
        // Escape commits; Enter inserts a newline, since annotations are often
        // multi-line. ⌘⏎ is the explicit "I'm done" gesture.
        if (e.key === "Escape" || (e.key === "Enter" && e.metaKey)) {
          e.preventDefault();
          e.stopPropagation();
          onCommit();
        }
      }}
      className="absolute resize-none overflow-hidden border-none bg-transparent p-0 outline-none"
      style={{
        left: x,
        top: y,
        transform: spin.deg ? `rotate(${spin.deg}deg)` : undefined,
        transformOrigin: `${spin.originX}px ${spin.originY}px`,
        color,
        font: `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif`,
        lineHeight: 1.3,
        caretColor: color,
        ...(box
          ? {
              // Inside a callout the text wraps to the shape and sits in the
              // middle of it, so the caret lands where the words will.
              padding: box.padding,
              width: box.width,
              height: box.height,
              textAlign: "center" as const,
              // Vertically centred by padding the block down, since a textarea
              // has no way to centre its content.
              paddingTop: Math.max(box.padding, (box.height - lineCount * fontSize * 1.3) / 2),
              textShadow: "none",
              outline: "1px dashed rgba(255,255,255,0.55)",
            }
          : {
              padding: 6,
              width: Math.max(metrics.width, fontSize * 3),
              height: metrics.height,
              textShadow: "0 1px 3px rgba(0,0,0,0.45)",
              outline: "1px dashed var(--color-accent)",
            }),
      }}
    />
  );
}
