import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import clsx from "clsx";
import {
  IconArrow,
  IconClose,
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
  /** Where the primary display sits inside this full-virtual-desktop window. */
  const [layout, setLayout] = useState<{
    primaryLeft: number;
    primaryTop: number;
    primaryWidth: number;
    primaryHeight: number;
  } | null>(null);

  const exit = useCallback(() => void invoke("annotate_stop"), []);

  // ------------------------------------------------------------- lifecycle

  useEffect(() => {
    void invoke<typeof layout>("annotate_layout").then(setLayout).catch(() => {});
  }, []);

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
  }, [exit]);

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

function Toolbar({
  layout,
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
  layout: {
    primaryLeft: number;
    primaryTop: number;
    primaryWidth: number;
    primaryHeight: number;
  } | null;
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
  return (
    // Pinned to the primary display, not to the window. On a multi-monitor
    // setup the window spans every screen, so centring on it puts the toolbar
    // on a secondary display — or in the gap between two.
    <div
      className="pointer-events-none absolute flex items-end justify-center pb-8"
      style={
        layout
          ? {
              left: layout.primaryLeft,
              top: layout.primaryTop,
              width: layout.primaryWidth,
              height: layout.primaryHeight,
            }
          : { inset: 0 }
      }
    >
      <div
        className="surface-float pointer-events-auto flex items-center gap-1 rounded-2xl p-1.5"
        style={{ cursor: "default" }}
      >
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

function PenGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 13.5 3.4 10l7-7a1.8 1.8 0 0 1 2.5 2.5l-7 7z" />
      <path d="M9.5 4.5 11.5 6.5" />
    </svg>
  );
}
