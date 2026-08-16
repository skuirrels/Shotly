import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import clsx from "clsx";
import {
  IconArrow,
  IconClose,
  IconDisplay,
  IconEllipse,
  IconHighlight,
  IconRect,
  IconRedo,
  IconRegion,
  IconSelect,
  IconText,
  IconTrash,
  IconUndo,
} from "@/components/icons";
import { Kbd } from "@/components/ui/Kbd";
import { captureStem } from "@/lib/naming";
import { arrowPolygon, fontFor, measureText, polygonToPath, TEXT_PADDING } from "@/lib/shapes";
import { SWATCHES } from "@/windows/editor/tools";

/**
 * Live annotation over the desktop, for screen sharing.
 *
 * The window this renders into is full-screen, transparent and accepts the
 * mouse, so a rendering failure here would cover the desktop in an invisible
 * click target. Two obligations follow, and both are load-bearing:
 *
 *  1. Report `annotate_ready` as soon as we have painted — until then Rust
 *     keeps the window mouse-transparent and clicks pass through.
 *  2. Keep sending `annotate_beat`. If these stop, Rust destroys the window.
 *     A hung renderer cannot report that it hung, so silence is the signal.
 */

type DrawTool = "pen" | "arrow" | "rect" | "ellipse" | "highlight" | "text";
/** `select` draws nothing; it is the pointer, as in the editor. */
type Tool = DrawTool | "select";

interface Point {
  x: number;
  y: number;
}

interface Stroke {
  id: string;
  tool: DrawTool;
  color: string;
  /**
   * Stroke thickness — or, for `text`, the font size.
   *
   * One field rather than two because both answer the same question: how big
   * is this mark. Keeping them together is what lets the width slider and a
   * corner drag resize text without a parallel set of cases for it.
   */
  width: number;
  points: Point[];
  /** Only meaningful for `tool === "text"`. */
  text?: string;
}

/**
 * A text box being typed into.
 *
 * Deliberately held outside `strokes`: a box abandoned empty then leaves no
 * trace and, more importantly, no undo step that appears to do nothing.
 */
interface Draft {
  id: string;
  at: Point;
  color: string;
  size: number;
  text: string;
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Handle = "nw" | "ne" | "sw" | "se";

/**
 * What the pointer is currently doing.
 *
 * Held in a ref rather than state: these update on every pointer move, and
 * re-rendering the whole overlay to store a drag offset would cost frames on
 * the one interaction where smoothness is the entire point.
 */
type Gesture =
  | { kind: "draw" }
  | { kind: "move"; ids: string[]; origin: Point; before: Stroke[] }
  | { kind: "resize"; handle: Handle; box: Bounds; before: Stroke[] };

// ------------------------------------------------------------------ geometry

/**
 * The rectangle one stroke occupies.
 *
 * Drawn strokes are padded by half their width: a horizontal line has zero
 * height as a set of points, and a selection box through the middle of it
 * would be invisible and impossible to grab. Text is measured instead — its
 * single point is the top-left corner, and the glyphs supply the rest.
 */
function strokeBounds(s: Stroke): Bounds | null {
  const first = s.points[0];
  if (!first) return null;

  if (s.tool === "text") {
    const m = measureText(s.text ?? "", s.width);
    return { x: first.x, y: first.y, width: m.width, height: m.height };
  }

  const pad = s.width / 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const p of s.points) {
    minX = Math.min(minX, p.x - pad);
    minY = Math.min(minY, p.y - pad);
    maxX = Math.max(maxX, p.x + pad);
    maxY = Math.max(maxY, p.y + pad);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Bounding box of a set of strokes. */
function boundsOf(strokes: Stroke[]): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const s of strokes) {
    const b = strokeBounds(s);
    if (!b) continue;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }

  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

const translate = (s: Stroke, dx: number, dy: number): Stroke => ({
  ...s,
  points: s.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
});

/**
 * Scale a stroke about an anchor point.
 *
 * Uniform across every tool because a stroke is only ever a list of points —
 * freehand scribbles resize by exactly the same arithmetic as rectangles,
 * with no per-shape special cases.
 */
const scale = (s: Stroke, anchor: Point, sx: number, sy: number): Stroke => ({
  ...s,
  // Text is the one shape with no outline to stretch: the size of the glyphs
  // *is* its geometry, so a corner drag has to scale the font. The geometric
  // mean keeps a diagonal pull proportional whichever way it leans.
  width:
    s.tool === "text"
      ? Math.max(MIN_FONT, s.width * Math.sqrt(Math.abs(sx * sy)))
      : s.width,
  points: s.points.map((p) => ({
    x: anchor.x + (p.x - anchor.x) * sx,
    y: anchor.y + (p.y - anchor.y) * sy,
  })),
});

const HANDLES: { id: Handle; cursor: string }[] = [
  { id: "nw", cursor: "nwse-resize" },
  { id: "ne", cursor: "nesw-resize" },
  { id: "sw", cursor: "nesw-resize" },
  { id: "se", cursor: "nwse-resize" },
];

const handleAt = (b: Bounds, h: Handle): Point => ({
  x: h === "nw" || h === "sw" ? b.x : b.x + b.width,
  y: h === "nw" || h === "ne" ? b.y : b.y + b.height,
});

/** The corner diagonally opposite the one being dragged — it stays put. */
const anchorFor = (b: Bounds, h: Handle): Point =>
  handleAt(b, (({ nw: "se", ne: "sw", sw: "ne", se: "nw" }) as const)[h]);

const HEARTBEAT_MS = 1000;
/** How many undo steps to keep. Deep enough for a session, cheap to hold. */
const HISTORY_LIMIT = 60;
/** The highlighter draws this much wider than the nominal stroke width. */
const HIGHLIGHT_SCALE = 4;
/**
 * Font size per unit of the width slider.
 *
 * The slider tops out at 24, which as a font size would be unreadably small
 * from the back of a room. Six pixels a notch puts the default at 24px and the
 * top of the range at something you could label a diagram with.
 */
const TEXT_SCALE = 6;
/** Below this, resizing text down would make it vanish beyond recovery. */
const MIN_FONT = 8;
/** Minimum grabbable thickness, so a hairline is still selectable. */
const HIT_WIDTH = 18;
/** Mirrors `AnnotateLayout` in `src-tauri/src/annotate.rs`. */
interface Layout {
  left: number;
  top: number;
  width: number;
  height: number;
}

const DOCK_KEY = "shotly.annotateToolbar";

/**
 * Which side of the screen the toolbar is attached to.
 *
 * Always one of the four, never floating in the middle: the toolbar sits on
 * top of the thing being annotated, so anywhere but an edge is in the way. In
 * cycling order, clockwise from the top.
 */
type Edge = "top" | "right" | "bottom" | "left";

const EDGES: Edge[] = ["top", "right", "bottom", "left"];

/** An edge, and how far along it the toolbar sits. */
interface Dock {
  edge: Edge;
  /** 0 is the left or top end of that edge, 1 the right or bottom. */
  pos: number;
}

/** Bottom centre of the usable area, until the user drags it elsewhere. */
const DEFAULT_DOCK: Dock = { edge: "bottom", pos: 0.5 };

/** A bar down the side runs the other way; everything inside it follows. */
const isVertical = (edge: Edge) => edge === "left" || edge === "right";

/**
 * Where the toolbar's anchor sits, as fractions of the free space.
 *
 * The pair feeds a percentage offset and an equal negative self-translate, so
 * 0 is flush with one edge and 1 flush with the opposite one without the CSS
 * needing to know how big the toolbar is.
 */
function dockAnchor(d: Dock): { x: number; y: number } {
  switch (d.edge) {
    case "top":
      return { x: d.pos, y: 0 };
    case "bottom":
      return { x: d.pos, y: 1 };
    case "left":
      return { x: 0, y: d.pos };
    case "right":
      return { x: 1, y: d.pos };
  }
}

/**
 * The edge a point is nearest.
 *
 * Compared as fractions of the area rather than in pixels, so the side edges
 * stay reachable on a wide display: a tenth of the way in from the left is
 * "the left" whether that is 130px or 500px.
 */
function nearestEdge(x: number, y: number): Edge {
  const gaps: [Edge, number][] = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y],
  ];
  return gaps.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
}

function storedDock(): Dock {
  try {
    const raw = localStorage.getItem(DOCK_KEY);
    if (!raw) return DEFAULT_DOCK;
    const parsed = JSON.parse(raw) as Partial<Dock> & { x?: number; y?: number };

    if (typeof parsed?.pos === "number" && EDGES.includes(parsed.edge as Edge)) {
      return { edge: parsed.edge as Edge, pos: clamp01(parsed.pos) };
    }

    // A free-floating position from before the toolbar docked. Put it on
    // whichever edge it had drifted closest to rather than throwing away where
    // the user had put it.
    if (typeof parsed?.x === "number" && typeof parsed?.y === "number") {
      const x = clamp01(parsed.x);
      const y = clamp01(parsed.y);
      const edge = nearestEdge(x, y);
      return { edge, pos: isVertical(edge) ? y : x };
    }

    return DEFAULT_DOCK;
  } catch {
    return DEFAULT_DOCK;
  }
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Mirrors `AnnotateScreen` in `src-tauri/src/annotate.rs`. */
interface Screen {
  id: number;
  number: number;
  isPrimary: boolean;
  isCurrent: boolean;
  width: number;
  height: number;
}

interface ToolButton {
  id: Tool;
  label: string;
  key: string;
  icon: () => React.ReactNode;
  /** Appended to the tooltip, for a tool that needs a word of explaining. */
  hint?: string;
}

/** The drawing tools, which is also the set the keyboard shortcuts match on. */
const TOOLS: ToolButton[] = [
  { id: "pen", label: "Pen", key: "P", icon: () => <PenGlyph /> },
  { id: "arrow", label: "Arrow", key: "A", icon: () => <IconArrow /> },
  { id: "rect", label: "Rectangle", key: "R", icon: () => <IconRect /> },
  { id: "ellipse", label: "Ellipse", key: "E", icon: () => <IconEllipse /> },
  { id: "highlight", label: "Highlighter", key: "H", icon: () => <IconHighlight /> },
  {
    id: "text",
    label: "Text",
    key: "T",
    icon: () => <IconText />,
    // Worth spelling out: ⏎ makes a new line, so finishing needs its own
    // gesture, and this is the only tool where a click alone does nothing
    // visible until you type.
    hint: "click to place, ⌘⏎ or click away to finish",
  },
];

/**
 * What the toolbar shows: select first, as in the editor.
 *
 * Select is rarely needed — dragging a stroke moves it whatever tool is
 * active — but it is the way to click a stroke without any chance of drawing,
 * and its presence is what tells you the strokes are objects at all.
 */
const TOOLBAR_TOOLS: ToolButton[] = [
  { id: "select", label: "Select", key: "V", icon: () => <IconSelect /> },
  ...TOOLS,
];

export function AnnotateApp() {
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  /**
   * The same list, readable without being a dependency.
   *
   * `exit` is wired into the keyboard listener, which is rebuilt whenever any
   * of its dependencies change. Depending on the strokes themselves would
   * rebuild it on every point of every line drawn.
   */
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(SWATCHES[0].value);
  const [width, setWidth] = useState(4);

  const drawing = useRef<Stroke | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const [, force] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  /** The text box being typed into, if any. */
  const [editing, setEditing] = useState<Draft | null>(null);
  /** Undo stack of whole stroke lists. Small enough that diffing would be fuss. */
  const [past, setPast] = useState<Stroke[][]>([]);
  const [future, setFuture] = useState<Stroke[][]>([]);
  /** Displays this overlay can sit on. One entry means no picker is shown. */
  const [screens, setScreens] = useState<Screen[]>([]);
  /** The area not covered by the menu bar or the Dock. */
  const [layout, setLayout] = useState<Layout | null>(null);
  /**
   * Which edge the toolbar is docked to, and where along it.
   *
   * The position is a fraction rather than pixels so it survives moving to a
   * screen of a different size — 40px in from the left of a laptop display is
   * not the same place on a 5K panel.
   */
  const [dock, setDock] = useState<Dock>(storedDock);

  /**
   * True while the desktop has the mouse back and the drawings are just
   * sitting there being looked at.
   */
  const [interacting, setInteracting] = useState(false);
  /** Set while the screenshot on the way out is being taken. */
  const [saving, setSaving] = useState(false);
  /** What was saved, shown briefly before the layer goes. */
  const [saved, setSaved] = useState<string | null>(null);
  /** The toolbar's rectangle, in page coordinates. See `annotate_pass_through`. */
  const toolbarRect = useRef<DOMRect | null>(null);

  /**
   * How long the shutter waits after the toolbar goes, and therefore how long
   * a second Escape has to call the whole thing off.
   *
   * The wait is not a cost this buys: the toolbar has to be genuinely off the
   * screen before the picture is taken, and that was already two animation
   * frames. Stretching it to something a hand can land inside turns a delay
   * nobody could use into the window where "no, not that one" still works —
   * and it means discarding never has to race a file that is already written.
   */
  const DISCARD_GRACE_MS = 400;

  /** The shutter, once the toolbar is out of shot. Cancelling this discards. */
  const pendingSave = useRef<number | null>(null);
  /** Set the moment leaving is settled, so nothing can ask twice. */
  const leaving = useRef(false);

  const stop = useCallback(() => {
    leaving.current = true;
    void invoke("annotate_stop");
  }, []);

  /**
   * Leave, taking the screen with us.
   *
   * The whole point of drawing on the desktop is the desktop underneath, so
   * what gets filed is a photograph of the screen rather than the strokes on
   * their own. Nothing to save means nothing to file: an empty layer exits as
   * quickly as it always did rather than dropping a picture of an ordinary
   * desktop into the library.
   *
   * Failures still exit. Being stuck under a full-screen window because a
   * write failed is far worse than losing the copy.
   */
  const exit = useCallback(() => {
    if (leaving.current || pendingSave.current !== null) return;
    if (strokesRef.current.length === 0) {
      stop();
      return;
    }

    // Selection handles are Shotly's furniture, not annotation.
    setSelected([]);
    setSaving(true);
    pendingSave.current = window.setTimeout(() => {
      pendingSave.current = null;
      void invoke<string>("annotate_save", { stem: captureStem() })
        .then((path) => {
          setSaving(false);
          setSaved(path.split("/").pop() ?? "the library");
          window.setTimeout(stop, 1100);
        })
        .catch(stop);
    }, DISCARD_GRACE_MS);
  }, [stop]);

  /**
   * Leave with nothing filed.
   *
   * Reached by pressing Escape a second time, and only ever while the shutter
   * is still waiting — so this really does mean nothing was written, rather
   * than something written and then tidied away.
   */
  const discard = useCallback(() => {
    if (pendingSave.current !== null) {
      window.clearTimeout(pendingSave.current);
      pendingSave.current = null;
    }
    stop();
  }, [stop]);

  /** True once the keydown for the current press has been answered. */
  const escapeHandled = useRef(false);

  /**
   * Hand the mouse to the desktop, or take it back.
   *
   * The drawings stay either way — that is the entire point. Rust keeps the
   * toolbar clickable by watching the cursor (see `set_pass_through`), so the
   * same button that stepped aside is still there to step back.
   */
  const interactingRef = useRef(interacting);
  interactingRef.current = interacting;

  const setInteract = useCallback((on: boolean) => {
    const r = toolbarRect.current;
    setInteracting(on);
    void invoke("annotate_pass_through", {
      enabled: on,
      rect: on && r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
    }).catch(() => setInteracting(!on));
  }, []);

  // The hotkey is the way back when the pointer is somewhere else entirely and
  // this page is getting no keys of its own.
  useEffect(() => {
    const unlisten = listen("annotate:interact", () => setInteract(!interactingRef.current));
    return () => void unlisten.then((fn) => fn());
  }, [setInteract]);

  // ------------------------------------------------------------- lifecycle

  const loadScreens = useCallback(
    () => void invoke<Screen[]>("annotate_screens").then(setScreens).catch(() => {}),
    [],
  );

  const loadLayout = useCallback(
    () => void invoke<Layout>("annotate_layout").then(setLayout).catch(() => {}),
    [],
  );

  useEffect(() => {
    loadScreens();
    loadLayout();
  }, [loadScreens, loadLayout]);

  const moveToolbar = useCallback((next: Dock) => {
    const docked: Dock = { edge: next.edge, pos: clamp01(next.pos) };
    setDock(docked);
    try {
      localStorage.setItem(DOCK_KEY, JSON.stringify(docked));
    } catch {
      // A full or disabled store costs the memory of where the toolbar was,
      // and nothing else. Not worth interrupting a screen share over.
    }
  }, []);

  /**
   * Send the toolbar round to the next edge, clockwise.
   *
   * A keyboard route as well as the drag, because the reason to move the
   * toolbar is almost always that it is sitting on top of the thing you were
   * about to annotate — and dragging it there means dragging it *across* that
   * thing, with the pointer, while it is the pointer you need.
   */
  const dockRef = useRef(dock);
  dockRef.current = dock;

  const cycleDock = useCallback(() => {
    const at = dockRef.current;
    const next: Dock = { edge: EDGES[(EDGES.indexOf(at.edge) + 1) % EDGES.length], pos: at.pos };
    // Moved on before the render that would have done it, so a key held down
    // walks round the edges instead of pressing the same one repeatedly.
    dockRef.current = next;
    moveToolbar(next);
  }, [moveToolbar]);

  /**
   * Hop to the next display, wrapping round.
   *
   * Cycling rather than a menu: with two monitors — which is the case that
   * actually comes up — a menu is two clicks to do the only thing there is to
   * do. Strokes deliberately survive the move: they belong to the drawing, not
   * to the screen, and losing them for looking at the other monitor would be a
   * nasty surprise mid-share.
   */
  const nextScreen = useCallback(() => {
    if (screens.length < 2) return;
    const at = screens.findIndex((s) => s.isCurrent);
    const target = screens[(at + 1) % screens.length];
    void invoke("annotate_move", { displayId: target.id })
      .then(() => {
        loadScreens();
        // The new screen has its own size, and its own menu bar and Dock.
        loadLayout();
      })
      .catch(() => {});
  }, [screens, loadScreens, loadLayout]);

  useEffect(() => {
    // Two frames: enough for the browser to have actually painted, so Rust is
    // handing the mouse to a surface that genuinely exists.
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void invoke("annotate_ready").catch(() => void invoke("annotate_stop"));
      }),
    );

    const beat = window.setInterval(() => {
      void invoke("annotate_beat").catch(() => {});
    }, HEARTBEAT_MS);

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(beat);
    };
  }, []);

  // ---------------------------------------------------------------- history

  /** Push a state onto the undo stack, discarding anything redone past it. */
  const remember = useCallback((state: Stroke[]) => {
    setPast((prev) => [...prev, state].slice(-HISTORY_LIMIT));
    setFuture([]);
  }, []);

  /** Record the current strokes before a change, so ⌘Z can come back to them. */
  const snapshot = useCallback(() => remember(strokes), [remember, strokes]);

  const undo = useCallback(() => {
    setPast((prev) => {
      if (prev.length === 0) return prev;
      const restored = prev[prev.length - 1];
      setFuture((f) => [strokes, ...f]);
      setStrokes(restored);
      setSelected((ids) => ids.filter((id) => restored.some((s) => s.id === id)));
      return prev.slice(0, -1);
    });
  }, [strokes]);

  const redo = useCallback(() => {
    setFuture((prev) => {
      if (prev.length === 0) return prev;
      const [next, ...rest] = prev;
      setPast((p) => [...p, strokes]);
      setStrokes(next);
      return rest;
    });
  }, [strokes]);

  // --------------------------------------------------------------- selection

  const selectedStrokes = strokes.filter((s) => selected.includes(s.id));
  const selectionBox = boundsOf(selectedStrokes);
  /** Kept separate from `editing` so the keyboard effect only re-binds when a
   *  box opens or closes, not on every keystroke inside it. */
  const isEditing = editing !== null;

  /** Apply a style change to the selection, and make it the new default. */
  const restyle = useCallback(
    (patch: Partial<Pick<Stroke, "color" | "width">>) => {
      if (selected.length === 0) return;
      snapshot();
      setStrokes((prev) =>
        prev.map((s) =>
          selected.includes(s.id)
            ? {
                ...s,
                ...patch,
                // Both of these carry a multiple of the nominal width, exactly
                // as they did when first laid down: the highlighter draws
                // several times wider, and text reads it as a font size.
                ...(patch.width !== undefined && s.tool === "highlight"
                  ? { width: patch.width * HIGHLIGHT_SCALE }
                  : {}),
                ...(patch.width !== undefined && s.tool === "text"
                  ? { width: patch.width * TEXT_SCALE }
                  : {}),
              }
            : s,
        ),
      );
    },
    [selected, snapshot],
  );

  const applyColor = useCallback(
    (next: string) => {
      setColor(next);
      restyle({ color: next });
    },
    [restyle],
  );

  const applyWidth = useCallback(
    (next: number) => {
      setWidth(next);
      restyle({ width: next });
    },
    [restyle],
  );

  const deleteSelected = useCallback(() => {
    if (selected.length === 0) return;
    snapshot();
    setStrokes((prev) => prev.filter((s) => !selected.includes(s.id)));
    setSelected([]);
  }, [selected, snapshot]);

  const clearAll = useCallback(() => {
    if (strokes.length === 0) return;
    snapshot();
    setStrokes([]);
    setSelected([]);
  }, [strokes.length, snapshot]);

  // ------------------------------------------------------------------- text

  /** Open a text box at a point, or on an existing stroke to retype it. */
  const editText = useCallback(
    (draft: Draft) => {
      setSelected([]);
      setEditing(draft);
    },
    [],
  );

  /**
   * Finish typing.
   *
   * An empty box is a mis-click and leaves nothing behind — or, when it had
   * content before, is how you delete the text by clearing it. Committing
   * selects the result, so the swatches and the slider act on what was just
   * written without having to go back and click it.
   */
  const commitText = useCallback(() => {
    const draft = editing;
    if (!draft) return;
    setEditing(null);

    const existed = strokes.some((s) => s.id === draft.id);

    if (!draft.text.trim()) {
      if (existed) {
        snapshot();
        setStrokes((prev) => prev.filter((s) => s.id !== draft.id));
      }
      return;
    }

    const next: Stroke = {
      id: draft.id,
      tool: "text",
      color: draft.color,
      width: draft.size,
      points: [draft.at],
      text: draft.text,
    };

    snapshot();
    setStrokes((prev) =>
      existed ? prev.map((s) => (s.id === draft.id ? next : s)) : [...prev, next],
    );
    setSelected([draft.id]);
  }, [editing, strokes, snapshot]);

  // --------------------------------------------------------------- drawing

  /** Pointer down on the backdrop: draw, or clear the selection. */
  const begin = (e: React.PointerEvent) => {
    if (e.button !== 0) return;

    // Clicking away from a text box commits it, and that is all this click
    // does. Otherwise the same press that finished one box would open another.
    // This runs before the blur that commits, so the draft is still here.
    if (editing) return;

    if (tool === "text") {
      // `preventDefault` is what makes the text tool work at all: without it
      // the browser moves focus to the SVG as this click finishes, blurring
      // the box we are about to mount — and a blurred empty box is discarded,
      // so it vanishes the instant it appears. Capturing the pointer would
      // compound that, and placing text needs no drag anyway.
      e.preventDefault();
      editText({
        id: crypto.randomUUID(),
        at: { x: e.clientX, y: e.clientY },
        color,
        size: width * TEXT_SCALE,
        text: "",
      });
      return;
    }

    (e.currentTarget as Element).setPointerCapture(e.pointerId);

    if (tool === "select") {
      setSelected([]);
      return;
    }

    setSelected([]);
    gesture.current = { kind: "draw" };
    drawing.current = {
      id: crypto.randomUUID(),
      tool,
      color,
      width: tool === "highlight" ? width * HIGHLIGHT_SCALE : width,
      points: [{ x: e.clientX, y: e.clientY }],
    };
    force((n) => n + 1);
  };

  /**
   * Pointer down on an existing stroke: select it and start moving.
   *
   * Matches the editor — dragging a shape moves it whatever tool is active,
   * with Alt to draw straight through instead. Without that escape hatch a
   * highlight covering the area would make everything under it unreachable.
   */
  const grab = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    // Clicking anywhere while typing only commits the box — including onto
    // another stroke, which would otherwise be selected and then immediately
    // deselected by the commit that follows.
    if (editing) return;
    if (e.altKey && tool !== "select") return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);

    const already = selected.includes(id);
    const ids = e.shiftKey
      ? already
        ? selected.filter((x) => x !== id)
        : [...selected, id]
      : already
        ? selected
        : [id];

    setSelected(ids);
    if (ids.length === 0) return;

    // No snapshot yet — `finish` takes one only if the stroke actually moved.
    gesture.current = {
      kind: "move",
      ids,
      origin: { x: e.clientX, y: e.clientY },
      before: strokes,
    };
  };

  const grabHandle = (e: React.PointerEvent, handle: Handle) => {
    if (e.button !== 0 || !selectionBox) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);

    gesture.current = { kind: "resize", handle, box: selectionBox, before: strokes };
  };

  const extend = (e: React.PointerEvent) => {
    const active = gesture.current;
    if (!active) return;

    if (active.kind === "draw") {
      const stroke = drawing.current;
      if (!stroke) return;
      if (stroke.tool === "pen" || stroke.tool === "highlight") {
        // Freehand keeps every sample; the shapes only ever need two.
        stroke.points.push({ x: e.clientX, y: e.clientY });
      } else {
        stroke.points[1] = { x: e.clientX, y: e.clientY };
      }
      force((n) => n + 1);
      return;
    }

    if (active.kind === "move") {
      let dx = e.clientX - active.origin.x;
      let dy = e.clientY - active.origin.y;
      // Shift locks to the dominant axis, as in the editor.
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      setStrokes(
        active.before.map((s) => (active.ids.includes(s.id) ? translate(s, dx, dy) : s)),
      );
      return;
    }

    // Resize: scale the selection about the corner opposite the one held.
    const anchor = anchorFor(active.box, active.handle);
    const corner = handleAt(active.box, active.handle);
    const spanX = corner.x - anchor.x;
    const spanY = corner.y - anchor.y;
    // A zero span cannot be scaled — a flat selection would collapse to
    // nothing and never come back.
    const sx = Math.abs(spanX) < 1 ? 1 : (e.clientX - anchor.x) / spanX;
    const sy = Math.abs(spanY) < 1 ? 1 : (e.clientY - anchor.y) / spanY;

    // Shift keeps the aspect ratio, as it does when drawing.
    const [fx, fy] = e.shiftKey ? [Math.min(sx, sy), Math.min(sx, sy)] : [sx, sy];
    setStrokes(
      active.before.map((s) => (selected.includes(s.id) ? scale(s, anchor, fx, fy) : s)),
    );
  };

  const finish = () => {
    const active = gesture.current;
    gesture.current = null;
    if (!active) return;

    if (active.kind !== "draw") {
      // A press that only selected something is not an edit. Recording it
      // would leave undo steps that visibly do nothing — and a double-click,
      // which is how text is reopened, lands two of them at once.
      if (strokes !== active.before) remember(active.before);
      return;
    }

    const stroke = drawing.current;
    drawing.current = null;
    if (!stroke) return;

    // A click that produced no line is not a stroke.
    const moved =
      stroke.points.length > 1 &&
      (Math.abs(stroke.points[0].x - stroke.points[stroke.points.length - 1].x) > 2 ||
        Math.abs(stroke.points[0].y - stroke.points[stroke.points.length - 1].y) > 2);
    if (!moved) return force((n) => n + 1);

    snapshot();
    setStrokes((prev) => [...prev, stroke]);
  };

  // -------------------------------------------------------------- keyboard

  /**
   * One Escape, answered by whichever layer is outermost.
   *
   * Text box, then selection, then the way out — and once the way out is
   * under way, a second press means "not that one": the shutter is still
   * waiting, so calling it off leaves nothing behind. Past that point the
   * picture exists and Escape just skips the notice about it.
   */
  const onEscape = useCallback(() => {
    if (leaving.current) return;
    if (saved !== null) return stop();
    if (saving) return discard();
    if (isEditing) return commitText();
    if (selected.length > 0) return setSelected([]);
    exit();
  }, [saved, saving, isEditing, selected.length, stop, discard, commitText, exit]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // While a text box has focus every key belongs to it — "R" is a letter,
      // not the rectangle tool. This listener is on the capture phase, so the
      // box cannot stop it from below; it has to bow out from up here.
      if (isEditing) return;

      if (e.key === "Escape") {
        e.preventDefault();
        // Auto-repeat from a held key would race through every layer at once.
        if (e.repeat) return;
        escapeHandled.current = true;
        onEscape();
        return;
      }
      if (e.metaKey && e.code === "KeyZ") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (e.code === "Backspace" || e.code === "Delete") {
        e.preventDefault();
        deleteSelected();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const digit = Number(e.key);
      if (digit >= 1 && digit <= SWATCHES.length) {
        applyColor(SWATCHES[digit - 1].value);
        return;
      }

      if (e.code === "KeyV") return setTool("select");

      const match = TOOLS.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
      if (match) setTool(match.id);
      else if (e.code === "KeyS") nextScreen();
      else if (e.code === "KeyD") cycleDock();
      else if (e.code === "KeyC") clearAll();
      else if (e.code === "BracketLeft") applyWidth(Math.max(1, width - 1));
      else if (e.code === "BracketRight") applyWidth(Math.min(24, width + 1));
    };

    // Capture phase, plus keyup as a second chance for Escape specifically:
    // WKWebView has its own handling for that key and can consume it before a
    // bubbled listener ever runs.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The release is a second chance, not a second press. If the keydown
      // above got through, this is the same tap finishing and must not count
      // again — otherwise every single press would read as a double one, and
      // Escape would always discard.
      if (escapeHandled.current) {
        escapeHandled.current = false;
        return;
      }
      onEscape();
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
    };
  }, [
    onEscape,
    isEditing,
    nextScreen,
    cycleDock,
    selected.length,
    undo,
    redo,
    deleteSelected,
    clearAll,
    applyColor,
    applyWidth,
    width,
  ]);

  const live = drawing.current;
  const cursor = tool === "select" ? "default" : tool === "text" ? "text" : "crosshair";

  return (
    <div className="fixed inset-0" style={{ cursor }}>
      <svg
        className="absolute inset-0 h-full w-full"
        // Belt and braces with the window-level pass-through: the toolbar is a
        // live hole in it, and a drag that starts on the toolbar and runs onto
        // the canvas would otherwise draw a line nobody asked for.
        style={{ pointerEvents: interacting ? "none" : "auto" }}
        onPointerDown={begin}
        onPointerMove={extend}
        onPointerUp={finish}
        onPointerCancel={finish}
      >
        <defs>
          {/* Text lands on live desktop content, which can be any colour at
              all. Without a shadow behind it, white on white is invisible. */}
          <filter id="annotate-text-shadow" x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="1.5" stdDeviation="2.5" floodColor="#000" floodOpacity="0.55" />
          </filter>
        </defs>

        {/* A fully transparent hit area: without a painted rect, pointer events
            fall through the SVG and drawing never starts. */}
        <rect width="100%" height="100%" fill="transparent" />

        {/* The stroke being retyped is hidden — the text box itself is
            standing in for it, in the same place and the same font. */}
        {strokes
          .filter((s) => s.id !== editing?.id)
          .map((s) => (
            <g
              key={s.id}
              onPointerDown={(e) => grab(e, s.id)}
              onDoubleClick={() => {
                if (s.tool !== "text") return;
                editText({
                  id: s.id,
                  at: s.points[0],
                  color: s.color,
                  size: s.width,
                  text: s.text ?? "",
                });
              }}
              style={{ cursor: "move" }}
            >
              {/* An invisible fat copy underneath, so a 2px line is grabbable
                  without demanding pixel-perfect aim. */}
              <StrokeShape stroke={s} hitArea />
              <StrokeShape stroke={s} />
            </g>
          ))}

        {live && <StrokeShape stroke={live} />}

        {/* Drawn during a drag as well as after it: the box is derived from the
            strokes themselves, so it tracks them live. Hiding it mid-gesture
            would also mean hiding it forever, since `gesture` is a ref and
            clearing it triggers no re-render. */}
        {selectionBox && (
          <g>
            <rect
              x={selectionBox.x}
              y={selectionBox.y}
              width={selectionBox.width}
              height={selectionBox.height}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth={1.5}
              strokeDasharray="5 3"
              pointerEvents="none"
            />
            {HANDLES.map((h) => {
              const at = handleAt(selectionBox, h.id);
              return (
                <rect
                  key={h.id}
                  x={at.x - 5}
                  y={at.y - 5}
                  width={10}
                  height={10}
                  rx={2}
                  fill="var(--color-accent)"
                  stroke="#fff"
                  strokeWidth={1.5}
                  style={{ cursor: h.cursor }}
                  onPointerDown={(e) => grabHandle(e, h.id)}
                />
              );
            })}
          </g>
        )}
      </svg>

      {editing && (
        <TextBox
          key={editing.id}
          draft={editing}
          onChange={(text) => setEditing((d) => (d ? { ...d, text } : d))}
          onCommit={commitText}
        />
      )}

      {/* Out of the way for the shutter: the point of the picture is the
          screen underneath, and Shotly's own toolbar is not part of it. */}
      {!saving && !saved && (
      <Toolbar
        layout={layout}
        dock={dock}
        onDock={moveToolbar}
        screens={screens}
        onNextScreen={nextScreen}
        tool={tool}
        setTool={setTool}
        color={color}
        setColor={applyColor}
        width={width}
        setWidth={applyWidth}
        canUndo={past.length > 0}
        onUndo={undo}
        canRedo={future.length > 0}
        onRedo={redo}
        selectedCount={selected.length}
        onClear={clearAll}
        onDeleteSelected={deleteSelected}
        onExit={exit}
        interacting={interacting}
        onInteract={setInteract}
        onRect={(r) => (toolbarRect.current = r)}
      />
      )}

      {/* Said where the eye already is, rather than in a window that is about
          to be behind everything else. */}
      {saved && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="surface-float rounded-2xl px-4 py-2.5 text-[13px] text-ink">
            Saved <span className="font-medium">{saved}</span> to your library
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A stroke, or an invisible fattened copy of it for hit testing.
 *
 * `hitArea` keeps the geometry and throws away the paint: a transparent stroke
 * wide enough to grab. Deliberately stroke-only, never a filled interior — an
 * unfilled rectangle should be selectable by its outline and stay click-through
 * in the middle, or a large one would swallow everything drawn beneath it.
 */
function StrokeShape({ stroke, hitArea = false }: { stroke: Stroke; hitArea?: boolean }) {
  const { tool, color, width, points } = stroke;
  if (points.length === 0) return null;

  const paint = hitArea ? "transparent" : color;
  const thickness = hitArea ? Math.max(width, HIT_WIDTH) : width;

  if (tool === "text") {
    const origin = points[0];
    const m = measureText(stroke.text ?? "", width);

    // The one shape whose interior is genuinely part of it, so unlike an
    // unfilled rectangle the whole box is grabbable rather than just an edge.
    if (hitArea) {
      return (
        <rect x={origin.x} y={origin.y} width={m.width} height={m.height} fill="transparent" />
      );
    }

    return (
      <text
        x={origin.x + TEXT_PADDING}
        y={origin.y + TEXT_PADDING}
        fill={color}
        filter="url(#annotate-text-shadow)"
        style={{ font: fontFor(width), whiteSpace: "pre" }}
      >
        {m.lines.map((line, i) => (
          <tspan
            key={i}
            x={origin.x + TEXT_PADDING}
            dy={i === 0 ? m.lineHeight * 0.8 : m.lineHeight}
          >
            {line || " "}
          </tspan>
        ))}
      </text>
    );
  }

  if (tool === "pen" || tool === "highlight") {
    const d = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
    return (
      <path
        d={d}
        fill="none"
        stroke={paint}
        strokeWidth={thickness}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={!hitArea && tool === "highlight" ? 0.35 : 1}
        style={!hitArea && tool === "highlight" ? { mixBlendMode: "multiply" } : undefined}
      />
    );
  }

  const [a, b] = points;
  if (!b) return null;

  if (tool === "arrow") {
    return (
      <path
        d={polygonToPath(
          arrowPolygon({
            id: stroke.id,
            kind: "arrow",
            x1: a.x,
            y1: a.y,
            x2: b.x,
            y2: b.y,
            style: {
              color,
              strokeWidth: width,
              fontSize: 16,
              fillOpacity: 0,
              blurRadius: 0,
              dim: 0,
              shadow: false,
            measureUnits: "pt",
            },
          }),
        )}
        fill={paint}
      />
    );
  }

  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);

  return tool === "rect" ? (
    <rect x={x} y={y} width={w} height={h} rx={4} fill="none" stroke={paint} strokeWidth={thickness} />
  ) : (
    <ellipse
      cx={x + w / 2}
      cy={y + h / 2}
      rx={Math.max(w / 2, 1)}
      ry={Math.max(h / 2, 1)}
      fill="none"
      stroke={paint}
      strokeWidth={thickness}
    />
  );
}

/**
 * The text box, mounted over the spot that was clicked.
 *
 * A real `<textarea>` rather than anything hand-rolled, so the caret, selection
 * and system text shortcuts all behave the way they do everywhere else. It is
 * styled to match the `<text>` it will become, which is what makes committing
 * look like nothing happened.
 */
function TextBox({
  draft,
  onChange,
  onCommit,
}: {
  draft: Draft;
  onChange: (text: string) => void;
  onCommit: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const mountedAt = useRef(Date.now());

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  /**
   * Ignore a blur landing in the same beat as mounting.
   *
   * Belt and braces alongside the `preventDefault` on the click that creates
   * the box: a stray focus shift here would silently discard a brand-new empty
   * one, which looks exactly like the text tool being broken.
   */
  const onBlur = () => {
    if (Date.now() - mountedAt.current < 250) {
      ref.current?.focus();
      return;
    }
    onCommit();
  };

  const m = measureText(draft.text, draft.size);

  return (
    <textarea
      ref={ref}
      value={draft.text}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      onKeyDown={(e) => {
        // Enter inserts a newline, since a callout is often more than one
        // line, so ⌘⏎ is the explicit "I'm done" gesture. Escape does the
        // same but is caught upstairs — WKWebView eats the key-down.
        if (e.key === "Enter" && e.metaKey) {
          e.preventDefault();
          onCommit();
        }
      }}
      className="absolute resize-none overflow-hidden border-none bg-transparent p-0 outline-none"
      style={{
        left: draft.at.x,
        top: draft.at.y,
        color: draft.color,
        font: fontFor(draft.size),
        lineHeight: 1.3,
        padding: TEXT_PADDING,
        width: Math.max(m.width, draft.size * 3),
        height: m.height,
        caretColor: draft.color,
        textShadow: "0 1px 3px rgba(0,0,0,0.55)",
        outline: "1px dashed var(--color-accent)",
      }}
    />
  );
}

/**
 * The toolbar, floating inside the usable area and draggable by its grip.
 *
 * It has to be movable: it is opaque chrome sitting on top of whatever is being
 * demonstrated, so wherever it defaults to will sometimes be exactly the thing
 * the viewer needs to see. Position is kept as a fraction of the usable area so
 * it lands somewhere sensible after a move to a differently sized screen.
 */
function Toolbar({
  layout,
  dock,
  onDock,
  screens,
  onNextScreen,
  tool,
  setTool,
  color,
  setColor,
  width,
  setWidth,
  canUndo,
  onUndo,
  canRedo,
  onRedo,
  selectedCount,
  onClear,
  onDeleteSelected,
  onExit,
  interacting,
  onInteract,
  onRect,
}: {
  layout: Layout | null;
  dock: Dock;
  onDock: (next: Dock) => void;
  screens: Screen[];
  onNextScreen: () => void;
  tool: Tool;
  setTool: (t: Tool) => void;
  color: string;
  setColor: (c: string) => void;
  width: number;
  setWidth: (w: number) => void;
  canUndo: boolean;
  onUndo: () => void;
  canRedo: boolean;
  onRedo: () => void;
  /** How many strokes are selected, which decides what the bin does. */
  selectedCount: number;
  onClear: () => void;
  onDeleteSelected: () => void;
  onExit: () => void;
  /** True while clicks are going to the desktop instead of the canvas. */
  interacting: boolean;
  onInteract: (on: boolean) => void;
  /**
   * Report where the toolbar is, in page coordinates.
   *
   * Rust needs it to keep this one rectangle clickable while the rest of the
   * layer is letting clicks past — see `set_pass_through`. Reported rather
   * than computed there because only the page knows where it has been dragged.
   */
  onRect: (rect: DOMRect) => void;
}) {
  const current = screens.find((s) => s.isCurrent);
  const bar = useRef<HTMLDivElement>(null);

  // Until the usable area is known, fall back to the window itself. Better a
  // toolbar slightly too low for one frame than one that isn't there at all.
  const area = layout ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };

  // Down the side, the bar runs the other way and drops its labels — a column
  // wide enough to read "Click through" would be a column covering the screen.
  const vertical = isVertical(dock.edge);
  const anchor = dockAnchor(dock);

  /**
   * How much to shrink the bar, if it is longer than the edge it sits on.
   *
   * A column of every tool runs to about 760px, which is taller than the
   * usable area of a 1440×900 display once the menu bar and the Dock are out
   * of it. Wrapping to a second column is what a document would do, but an
   * absolutely positioned flex box is sized before it wraps, so that column
   * would land outside both the painted background and the rectangle Rust
   * keeps clickable. Scaling keeps every button on screen, in one piece, and
   * honestly measured — `getBoundingClientRect` reports the transformed box.
   */
  const [fit, setFit] = useState(1);

  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const measure = () => {
      // `offset*` is the untransformed layout size, so this cannot feed back
      // on itself: shrinking the bar does not change what is being measured.
      const need = vertical ? el.offsetHeight : el.offsetWidth;
      const have = vertical ? area.height : area.width;
      setFit(need > 0 ? Math.min(1, have / need) : 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [vertical, area.width, area.height, screens.length, selectedCount]);

  // Re-measured on every move and every change of size — a wider toolbar is a
  // wider hole, and a stale rectangle is a button that cannot be clicked.
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const report = () => onRect(el.getBoundingClientRect());
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [onRect, dock, layout, fit, screens.length, selectedCount]);

  /**
   * Drag from the grip.
   *
   * Pointer capture rather than window listeners: the overlay sits above every
   * other app, and a drag that ran off the edge would otherwise keep receiving
   * moves from a surface it no longer owns.
   */
  const startDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    // Captured up front: React nulls `currentTarget` once dispatch returns, so
    // the handlers below would otherwise be reaching for nothing.
    const handle = e.currentTarget as HTMLElement;
    const size = bar.current?.getBoundingClientRect();
    if (!size) return;

    // Where in the toolbar the grab happened, so it doesn't jump under the
    // cursor on the first move.
    const grabX = e.clientX - size.left;
    const grabY = e.clientY - size.top;
    const startedVertical = isVertical(dock.edge);

    handle.setPointerCapture(e.pointerId);

    const onMove = (move: PointerEvent) => {
      // Which edge to dock to follows the pointer rather than the toolbar's
      // own corner: the bar changes shape the moment it lands on a side, and
      // aiming a rectangle whose size is about to change is guesswork.
      const fx = clamp01((move.clientX - area.left) / Math.max(1, area.width));
      const fy = clamp01((move.clientY - area.top) / Math.max(1, area.height));
      const edge = nearestEdge(fx, fy);
      const vertical = isVertical(edge);

      // Re-measured every move, because the bar that is being positioned is
      // the one on screen now — a tall column, if it has just flipped.
      const live = bar.current?.getBoundingClientRect() ?? size;
      const extent = vertical ? live.height : live.width;
      // The grab offset holds the toolbar still under the cursor, but only
      // while the bar is still the shape it was grabbed by. Across a flip it
      // describes a bar that no longer exists, so it centres on the pointer.
      const offset =
        vertical === startedVertical ? (vertical ? grabY : grabX) : extent / 2;
      // Free space the toolbar's leading corner can range over. `pos` is a
      // fraction of exactly this, which is what makes 0 and 1 sit flush.
      const span = Math.max(1, (vertical ? area.height : area.width) - extent);

      onDock({
        edge,
        pos: vertical
          ? (move.clientY - offset - area.top) / span
          : (move.clientX - offset - area.left) / span,
      });
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  const widthSlider = (
    <input
      type="range"
      min={1}
      max={24}
      value={width}
      onChange={(e) => setWidth(Number(e.target.value))}
      title="Stroke width, or text size ( [ and ] )"
      className={clsx(
        "w-20 accent-[var(--color-accent)]",
        // Rotated rather than turned vertical by writing-mode, which WebKit
        // only learned recently. Absolute, so the sideways box it still
        // occupies in layout doesn't widen the whole bar.
        vertical && "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 -rotate-90",
      )}
    />
  );

  return (
    <div
      className="pointer-events-none absolute"
      style={{ left: area.left, top: area.top, width: area.width, height: area.height }}
    >
      <div
        ref={bar}
        className={clsx(
          "surface-float pointer-events-auto absolute flex content-start items-center gap-1 rounded-2xl p-1.5",
          vertical ? "flex-col" : "flex-row",
        )}
        style={{
          cursor: "default",
          // Percentage offset paired with an equal negative self-translate:
          // at 0 the toolbar is flush against one edge, at 1 the opposite one,
          // at 0.5 centred. That makes `pos` a fraction of the free space
          // without the CSS needing to know the toolbar's size.
          left: `${anchor.x * 100}%`,
          top: `${anchor.y * 100}%`,
          transform: `translate(${-anchor.x * 100}%, ${-anchor.y * 100}%) scale(${fit})`,
          // Scaled about the point that is pinned to the edge, so shrinking to
          // fit never lifts the bar off the side it is docked to.
          transformOrigin: `${anchor.x * 100}% ${anchor.y * 100}%`,
          // Sized to its contents along the axis it runs. Without this it is
          // shrink-to-fit against the space left over beyond its own offset —
          // half the screen, for a centred bar — and the labels wrap to two
          // lines to make it so. Overflowing the screen is `fit`'s job.
          width: vertical ? undefined : "max-content",
          height: vertical ? "max-content" : undefined,
        }}
      >
        {/* The drag handle. Explicit rather than "drag the background", which
            is undiscoverable and fights the buttons for the same pointer. */}
        <button
          type="button"
          onPointerDown={startDrag}
          title="Drag to dock the toolbar to any edge (D cycles)"
          aria-label="Move the toolbar"
          className={clsx(
            "grid shrink-0 cursor-grab place-items-center rounded-lg text-ink-4 hover:bg-hover hover:text-ink-2 active:cursor-grabbing",
            vertical ? "h-[18px] w-[30px]" : "h-[30px] w-[18px]",
          )}
        >
          <GripGlyph turned={vertical} />
        </button>

        {TOOLBAR_TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-label={t.label}
            title={t.hint ? `${t.label} (${t.key}) — ${t.hint}` : `${t.label} (${t.key})`}
            onClick={() => setTool(t.id)}
            className={clsx(
              "grid h-[30px] w-[30px] place-items-center rounded-lg transition-colors duration-100",
              tool === t.id
                ? "bg-accent/18 text-accent shadow-[inset_0_0_0_1px_var(--color-accent)]"
                : "text-ink-2 hover:bg-hover hover:text-ink",
            )}
          >
            {t.icon()}
          </button>
          ))}

        <Divider barVertical={vertical} />

        {SWATCHES.slice(0, 6).map((s, i) => (
          <button
            key={s.value}
            type="button"
            aria-label={s.name}
            title={`${s.name} (${i + 1})`}
            onClick={() => setColor(s.value)}
            className={clsx(
              "grid place-items-center rounded-lg hover:bg-hover",
              // Squat the other way when stacked, so six of them don't add
              // 180px to a column that has to fit on the screen.
              vertical ? "h-[26px] w-[30px]" : "h-[30px] w-[26px]",
            )}
          >
            <span
              className={clsx(
                "size-[17px] rounded-full ring-1 ring-white/25 ring-inset",
                s.value.toLowerCase() === color.toLowerCase() && "ring-2 ring-white",
              )}
              style={{ background: s.value }}
            />
          </button>
        ))}

        <Divider barVertical={vertical} />

        {vertical ? (
          <div className="relative h-20 w-[30px] shrink-0">{widthSlider}</div>
        ) : (
          widthSlider
        )}

        <Divider barVertical={vertical} />

        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo (⌘Z)"
          aria-label="Undo"
          className="grid h-[30px] w-[30px] place-items-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-35"
        >
          <IconUndo />
        </button>
        <button
          type="button"
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo (⌘⇧Z)"
          aria-label="Redo"
          className="grid h-[30px] w-[30px] place-items-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-35"
        >
          <IconRedo />
        </button>
        {/* One bin, two jobs: with a selection it removes just that, matching
            the editor, and otherwise it wipes the board. */}
        <button
          type="button"
          onClick={selectedCount > 0 ? onDeleteSelected : onClear}
          title={selectedCount > 0 ? `Delete ${selectedCount} selected (\u232b)` : "Clear all (C)"}
          aria-label={selectedCount > 0 ? "Delete selection" : "Clear all"}
          className="grid h-[30px] w-[30px] place-items-center rounded-lg text-ink-2 hover:bg-hover hover:text-danger"
        >
          <IconTrash />
        </button>

        {/* Only worth the space when there is somewhere else to go. */}
        {screens.length > 1 && current && (
          <>
            <Divider barVertical={vertical} />
            <button
              type="button"
              onClick={onNextScreen}
              title={`Move to the next screen (S) — on screen ${current.number}${current.isPrimary ? ", the main one" : ""}`}
              aria-label="Move to the next screen"
              className={clsx(
                "flex h-[30px] items-center rounded-lg text-[12px] font-medium text-ink-2 hover:bg-hover hover:text-ink",
                vertical ? "w-[30px] justify-center" : "gap-1.5 px-2",
              )}
            >
              <IconDisplay />
              {!vertical && (
                <>
                  Screen {current.number}
                  {current.isPrimary && <span className="text-ink-4">· Main</span>}
                </>
              )}
            </button>
          </>
        )}

        <Divider barVertical={vertical} />

        {/* The way out of being trapped over your own desktop. Drawing and
            using the machine underneath are both things you do constantly
            during a share, and until this button existed the only way to click
            anything was to throw the drawings away. */}
        <button
          type="button"
          onClick={() => onInteract(!interacting)}
          title={
            interacting
              ? "Back to drawing (\u2303\u21e7D) — your drawings stayed put"
              : "Use the screen underneath (\u2303\u21e7D) — drawings stay on top"
          }
          aria-pressed={interacting}
          className={clsx(
            "flex h-[30px] items-center rounded-lg text-[12px] font-medium transition-colors",
            vertical ? "w-[30px] justify-center" : "gap-1.5 px-2",
            interacting
              ? "bg-accent/18 text-accent shadow-[inset_0_0_0_1px_var(--color-accent)]"
              : "text-ink-2 hover:bg-hover hover:text-ink",
          )}
        >
          <IconRegion />
          {!vertical && (interacting ? "Drawing off" : "Click through")}
        </button>

        <button
          type="button"
          onClick={onExit}
          title="Save the screen with these annotations, and close the layer (⌃⇧A)"
          className={clsx(
            "flex h-8 items-center rounded-lg bg-white/[0.07] font-medium text-ink text-[12.5px] hover:bg-white/[0.12]",
            vertical ? "mt-1 w-[30px] justify-center" : "ml-1 gap-1.5 px-2.5",
          )}
        >
          <IconClose />
          {!vertical && (
            <>
              Exit
              {/* The Rust-owned hotkey, not Escape: it is the one guaranteed
                  to work even if this page has stopped responding. */}
              <Kbd shortcut="Ctrl+Shift+A" muted />
            </>
          )}
        </button>
      </div>
    </div>
  );
}

/**
 * A rule between groups of buttons.
 *
 * `barVertical` describes the toolbar, not the line: a bar running down the
 * side of the screen is divided by rules running across it.
 */
function Divider({ barVertical }: { barVertical: boolean }) {
  return (
    <span
      className={clsx("shrink-0 bg-white/10", barVertical ? "my-1 h-px w-5" : "mx-1 h-5 w-px")}
    />
  );
}

function GripGlyph({ turned = false }: { turned?: boolean }) {
  return (
    <svg
      width="10"
      height="16"
      viewBox="0 0 10 16"
      fill="currentColor"
      aria-hidden="true"
      className={clsx(turned && "rotate-90")}
    >
      {[4, 8, 12].flatMap((y) =>
        [2, 7].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.1" />),
      )}
    </svg>
  );
}

function PenGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 13.5 3.4 10l7-7a1.8 1.8 0 0 1 2.5 2.5l-7 7z" />
      <path d="M9.5 4.5 11.5 6.5" />
    </svg>
  );
}
