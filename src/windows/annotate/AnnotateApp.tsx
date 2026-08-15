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

type Tool = "pen" | "arrow" | "rect" | "ellipse" | "highlight";

interface Point {
  x: number;
  y: number;
}

interface Stroke {
  id: string;
  tool: Tool;
  color: string;
  width: number;
  points: Point[];
}

const HEARTBEAT_MS = 1000;
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

const TOOLS: { id: Tool; label: string; key: string; icon: () => React.ReactNode }[] = [
  { id: "pen", label: "Pen", key: "P", icon: () => <PenGlyph /> },
  { id: "arrow", label: "Arrow", key: "A", icon: () => <IconArrow /> },
  { id: "rect", label: "Rectangle", key: "R", icon: () => <IconRect /> },
  { id: "ellipse", label: "Ellipse", key: "E", icon: () => <IconEllipse /> },
  { id: "highlight", label: "Highlighter", key: "H", icon: () => <IconHighlight /> },
];

export function AnnotateApp() {
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(SWATCHES[0].value);
  const [width, setWidth] = useState(4);

  const drawing = useRef<Stroke | null>(null);
  const [, force] = useState(0);
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

  // --------------------------------------------------------------- drawing

  const begin = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);

    drawing.current = {
      id: crypto.randomUUID(),
      tool,
      color,
      width: tool === "highlight" ? width * 4 : width,
      points: [{ x: e.clientX, y: e.clientY }],
    };
    force((n) => n + 1);
  };

  const extend = (e: React.PointerEvent) => {
    const active = drawing.current;
    if (!active) return;

    if (active.tool === "pen" || active.tool === "highlight") {
      // Freehand keeps every sample; the shapes only ever need two.
      active.points.push({ x: e.clientX, y: e.clientY });
    } else {
      active.points[1] = { x: e.clientX, y: e.clientY };
    }
    force((n) => n + 1);
  };

  const finish = () => {
    const active = drawing.current;
    drawing.current = null;
    if (!active) return;

    // A click that produced no line is not a stroke.
    const moved =
      active.points.length > 1 &&
      (Math.abs(active.points[0].x - active.points[active.points.length - 1].x) > 2 ||
        Math.abs(active.points[0].y - active.points[active.points.length - 1].y) > 2);
    if (!moved) return force((n) => n + 1);

    setStrokes((prev) => [...prev, active]);
  };

  // -------------------------------------------------------------- keyboard

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        exit();
        return;
      }
      if (e.metaKey && e.code === "KeyZ") {
        e.preventDefault();
        setStrokes((prev) => prev.slice(0, -1));
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const digit = Number(e.key);
      if (digit >= 1 && digit <= SWATCHES.length) {
        setColor(SWATCHES[digit - 1].value);
        return;
      }

      const match = TOOLS.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
      if (match) setTool(match.id);
      else if (e.code === "KeyS") nextScreen();
      else if (e.code === "KeyC") setStrokes([]);
      else if (e.code === "BracketLeft") setWidth((w) => Math.max(1, w - 1));
      else if (e.code === "BracketRight") setWidth((w) => Math.min(24, w + 1));
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
  }, [exit, nextScreen]);

  const live = drawing.current;

  return (
    <div className="fixed inset-0" style={{ cursor: "crosshair" }}>
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
          <StrokeShape key={s.id} stroke={s} />
        ))}
        {live && <StrokeShape stroke={live} />}
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
        setColor={setColor}
        width={width}
        setWidth={setWidth}
        canUndo={strokes.length > 0}
        onUndo={() => setStrokes((prev) => prev.slice(0, -1))}
        onClear={() => setStrokes([])}
        onExit={exit}
      />
    </div>
  );
}

function StrokeShape({ stroke }: { stroke: Stroke }) {
  const { tool, color, width, points } = stroke;
  if (points.length === 0) return null;

  if (tool === "pen" || tool === "highlight") {
    const d = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
    return (
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={width}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={tool === "highlight" ? 0.35 : 1}
        style={tool === "highlight" ? { mixBlendMode: "multiply" } : undefined}
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
        fill={color}
      />
    );
  }

  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);

  return tool === "rect" ? (
    <rect x={x} y={y} width={w} height={h} rx={4} fill="none" stroke={color} strokeWidth={width} />
  ) : (
    <ellipse
      cx={x + w / 2}
      cy={y + h / 2}
      rx={Math.max(w / 2, 1)}
      ry={Math.max(h / 2, 1)}
      fill="none"
      stroke={color}
      strokeWidth={width}
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
  onClear,
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
  onClear: () => void;
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

        {TOOLS.map((t) => (
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
          onClick={onClear}
          title="Clear all (C)"
          aria-label="Clear all"
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
