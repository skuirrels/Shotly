import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import clsx from "clsx";
import {
  IconArrow,
  IconClose,
  IconDisplay,
  IconEllipse,
  IconHighlight,
  IconRect,
  IconRedo,
  IconSelect,
  IconTrash,
  IconUndo,
} from "@/components/icons";
import { Kbd } from "@/components/ui/Kbd";
import { arrowPolygon, polygonToPath } from "@/lib/shapes";
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

type DrawTool = "pen" | "arrow" | "rect" | "ellipse" | "highlight";
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
  width: number;
  points: Point[];
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
 * Bounding box of some strokes, padded by half their stroke width.
 *
 * The padding matters: a horizontal line has zero height as a set of points,
 * and a selection box drawn through the middle of it would be invisible and
 * impossible to grab.
 */
function boundsOf(strokes: Stroke[]): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const s of strokes) {
    const pad = s.width / 2;
    for (const p of s.points) {
      minX = Math.min(minX, p.x - pad);
      minY = Math.min(minY, p.y - pad);
      maxX = Math.max(maxX, p.x + pad);
      maxY = Math.max(maxY, p.y + pad);
    }
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

/** Bottom centre of the usable area, until the user drags it elsewhere. */
const DEFAULT_DOCK = { x: 0.5, y: 1 };

function storedDock(): { x: number; y: number } {
  try {
    const raw = localStorage.getItem(DOCK_KEY);
    if (!raw) return DEFAULT_DOCK;
    const parsed = JSON.parse(raw) as { x: number; y: number };
    if (typeof parsed?.x !== "number" || typeof parsed?.y !== "number") return DEFAULT_DOCK;
    return { x: clamp01(parsed.x), y: clamp01(parsed.y) };
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
}

/** The drawing tools, which is also the set the keyboard shortcuts match on. */
const TOOLS: ToolButton[] = [
  { id: "pen", label: "Pen", key: "P", icon: () => <PenGlyph /> },
  { id: "arrow", label: "Arrow", key: "A", icon: () => <IconArrow /> },
  { id: "rect", label: "Rectangle", key: "R", icon: () => <IconRect /> },
  { id: "ellipse", label: "Ellipse", key: "E", icon: () => <IconEllipse /> },
  { id: "highlight", label: "Highlighter", key: "H", icon: () => <IconHighlight /> },
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
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(SWATCHES[0].value);
  const [width, setWidth] = useState(4);

  const drawing = useRef<Stroke | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const [, force] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  /** Undo stack of whole stroke lists. Small enough that diffing would be fuss. */
  const [past, setPast] = useState<Stroke[][]>([]);
  const [future, setFuture] = useState<Stroke[][]>([]);
  /** Displays this overlay can sit on. One entry means no picker is shown. */
  const [screens, setScreens] = useState<Screen[]>([]);
  /** The area not covered by the menu bar or the Dock. */
  const [layout, setLayout] = useState<Layout | null>(null);
  /**
   * Where the user has dragged the toolbar, as a fraction of the usable area.
   *
   * Stored as a fraction rather than pixels so it survives moving to a screen
   * of a different size — a position 40px from the bottom of a laptop display
   * is not the same place on a 5K panel.
   */
  const [dock, setDock] = useState<{ x: number; y: number }>(storedDock);

  const exit = useCallback(() => void invoke("annotate_stop"), []);

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

  const moveToolbar = useCallback((next: { x: number; y: number }) => {
    const clamped = { x: clamp01(next.x), y: clamp01(next.y) };
    setDock(clamped);
    try {
      localStorage.setItem(DOCK_KEY, JSON.stringify(clamped));
    } catch {
      // A full or disabled store costs the memory of where the toolbar was,
      // and nothing else. Not worth interrupting a screen share over.
    }
  }, []);

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

  /** Record the current strokes before a change, so ⌘Z can come back to them. */
  const snapshot = useCallback(() => {
    setPast((prev) => [...prev, strokes].slice(-HISTORY_LIMIT));
    setFuture([]);
  }, [strokes]);

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
                // The highlighter's stroke is drawn several times wider than
                // the nominal width, exactly as when it was first laid down.
                ...(patch.width !== undefined && s.tool === "highlight"
                  ? { width: patch.width * HIGHLIGHT_SCALE }
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

  // --------------------------------------------------------------- drawing

  /** Pointer down on the backdrop: draw, or clear the selection. */
  const begin = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
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

    snapshot();
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

    snapshot();
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

    if (active.kind !== "draw") return;

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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        // Layered, as in the editor: drop the selection first, leave on the
        // second press. Only when something is selected — with nothing to
        // deselect this stays the plain way out.
        if (selected.length > 0) setSelected([]);
        else exit();
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
      else if (e.code === "KeyC") clearAll();
      else if (e.code === "BracketLeft") applyWidth(Math.max(1, width - 1));
      else if (e.code === "BracketRight") applyWidth(Math.min(24, width + 1));
    };

    // Capture phase, plus keyup as a second chance for Escape specifically:
    // WKWebView has its own handling for that key and can consume it before a
    // bubbled listener ever runs.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Escape") exit();
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
    };
  }, [
    exit,
    nextScreen,
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

  return (
    <div className="fixed inset-0" style={{ cursor: tool === "select" ? "default" : "crosshair" }}>
      <svg
        className="absolute inset-0 h-full w-full"
        onPointerDown={begin}
        onPointerMove={extend}
        onPointerUp={finish}
        onPointerCancel={finish}
      >
        {/* A fully transparent hit area: without a painted rect, pointer events
            fall through the SVG and drawing never starts. */}
        <rect width="100%" height="100%" fill="transparent" />

        {strokes.map((s) => (
          <g key={s.id} onPointerDown={(e) => grab(e, s.id)} style={{ cursor: "move" }}>
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
      />
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
              shadow: false,
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
}: {
  layout: Layout | null;
  dock: { x: number; y: number };
  onDock: (next: { x: number; y: number }) => void;
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
}) {
  const current = screens.find((s) => s.isCurrent);
  const bar = useRef<HTMLDivElement>(null);

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
    const area = layout ?? {
      left: 0,
      top: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    };
    const size = bar.current?.getBoundingClientRect();
    if (!size) return;

    // Free space the toolbar's top-left can range over. `dock` is a fraction
    // of exactly this, which is what makes 0 and 1 sit flush with the edges.
    const spanX = Math.max(1, area.width - size.width);
    const spanY = Math.max(1, area.height - size.height);
    // Where in the toolbar the grab happened, so it doesn't jump under the
    // cursor on the first move.
    const grabX = e.clientX - size.left;
    const grabY = e.clientY - size.top;

    handle.setPointerCapture(e.pointerId);

    const onMove = (move: PointerEvent) => {
      onDock({
        x: (move.clientX - grabX - area.left) / spanX,
        y: (move.clientY - grabY - area.top) / spanY,
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

  // Until the usable area is known, fall back to the window itself. Better a
  // toolbar slightly too low for one frame than one that isn't there at all.
  const area = layout ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };

  return (
    <div
      className="pointer-events-none absolute"
      style={{ left: area.left, top: area.top, width: area.width, height: area.height }}
    >
      <div
        ref={bar}
        className="surface-float pointer-events-auto absolute flex items-center gap-1 rounded-2xl p-1.5"
        style={{
          cursor: "default",
          // Percentage offset paired with an equal negative self-translate:
          // at 0 the toolbar is flush left, at 1 flush right, at 0.5 centred.
          // That makes `dock` a fraction of the free space without needing to
          // know the toolbar's width in CSS.
          left: `${dock.x * 100}%`,
          top: `${dock.y * 100}%`,
          transform: `translate(${-dock.x * 100}%, ${-dock.y * 100}%)`,
        }}
      >
        {/* The drag handle. Explicit rather than "drag the background", which
            is undiscoverable and fights the buttons for the same pointer. */}
        <button
          type="button"
          onPointerDown={startDrag}
          title="Drag to move the toolbar"
          aria-label="Move the toolbar"
          className="grid h-[30px] w-[18px] shrink-0 cursor-grab place-items-center rounded-lg text-ink-4 hover:bg-hover hover:text-ink-2 active:cursor-grabbing"
        >
          <GripGlyph />
        </button>

        {TOOLBAR_TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-label={t.label}
            title={`${t.label} (${t.key})`}
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

        <span className="mx-1 h-5 w-px bg-white/10" />

        {SWATCHES.slice(0, 6).map((s, i) => (
          <button
            key={s.value}
            type="button"
            aria-label={s.name}
            title={`${s.name} (${i + 1})`}
            onClick={() => setColor(s.value)}
            className="grid h-[30px] w-[26px] place-items-center rounded-lg hover:bg-hover"
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

        <span className="mx-1 h-5 w-px bg-white/10" />

        <input
          type="range"
          min={1}
          max={24}
          value={width}
          onChange={(e) => setWidth(Number(e.target.value))}
          title="Stroke width ( [ and ] )"
          className="w-20 accent-[var(--color-accent)]"
        />

        <span className="mx-1 h-5 w-px bg-white/10" />

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
            <span className="mx-1 h-5 w-px bg-white/10" />
            <button
              type="button"
              onClick={onNextScreen}
              title="Move to the next screen (S)"
              aria-label="Move to the next screen"
              className="flex h-[30px] items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-ink-2 hover:bg-hover hover:text-ink"
            >
              <IconDisplay />
              Screen {current.number}
              {current.isPrimary && <span className="text-ink-4">· Main</span>}
            </button>
          </>
        )}

        <button
          type="button"
          onClick={onExit}
          className="ml-1 flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.07] px-2.5 text-[12.5px] font-medium text-ink hover:bg-white/[0.12]"
        >
          <IconClose />
          Exit
          {/* The Rust-owned hotkey, not Escape: it is the one guaranteed to
              work even if this page has stopped responding. */}
          <Kbd shortcut="Ctrl+Shift+A" muted />
        </button>
      </div>
    </div>
  );
}

function GripGlyph() {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
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
