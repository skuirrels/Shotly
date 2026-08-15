import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { measureText, stepRadius } from "@/lib/shapes";
import {
  type Annotation,
  type BoxKind,
  type Rect,
  boundsOf,
  isBox,
  isLine,
  isStep,
} from "@/lib/types";
import { useEditor } from "@/state/editorStore";
import { AnnotationLayer, type HandleId } from "./AnnotationLayer";

interface Point {
  x: number;
  y: number;
}

type Drag =
  | { kind: "create"; id: string; origin: Point }
  | { kind: "move"; ids: string[]; origin: Point; snapshot: Annotation[] }
  | { kind: "resize"; id: string; handle: HandleId; snapshot: Annotation }
  | { kind: "crop"; origin: Point };

const BOX_TOOLS: BoxKind[] = ["rect", "ellipse", "blur", "highlight"];
const PAD = 48;

export function Canvas() {
  const doc = useEditor((s) => s.doc);
  const annotations = useEditor((s) => s.annotations);
  const selectedIds = useEditor((s) => s.selectedIds);
  const tool = useEditor((s) => s.tool);
  const style = useEditor((s) => s.style);
  const zoomSetting = useEditor((s) => s.zoom);
  const fitToWindow = useEditor((s) => s.fitToWindow);
  const pendingCrop = useEditor((s) => s.pendingCrop);

  const viewport = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  const [fitZoom, setFitZoom] = useState(1);
  const [editingId, setEditingId] = useState<string | null>(null);
  /** Alt turns a press on a shape into a draw-through — see `onShapePointerDown`. */
  const [altDown, setAltDown] = useState(false);

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

    if (tool === "crop") {
      drag.current = { kind: "crop", origin };
      store.setPendingCrop({ x: origin.x, y: origin.y, width: 0, height: 0 });
      return;
    }

    if (tool === "arrow" || tool === "line") {
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
    if (e.altKey && tool !== "select") return;
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
    drag.current = { kind: "resize", id, handle, snapshot: target };
  };

  const onPointerMove = (e: React.PointerEvent) => {
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

      case "create": {
        const target = store.annotations.find((a) => a.id === active.id);
        if (!target) break;

        if (isLine(target)) {
          let end = point;
          if (e.shiftKey) end = snapAngle(active.origin, point);
          store.update(active.id, { x2: end.x, y2: end.y });
        } else if (isBox(target)) {
          let end = point;
          if (e.shiftKey) end = snapSquare(active.origin, point);
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

        store.replaceAll(
          store.annotations.map((a) => {
            const original = active.snapshot.find((s) => s.id === a.id);
            if (!original) return a;
            if (isBox(original)) return { ...a, x: original.x + dx, y: original.y + dy };
            if (isLine(original))
              return {
                ...a,
                x1: original.x1 + dx,
                y1: original.y1 + dy,
                x2: original.x2 + dx,
                y2: original.y2 + dy,
              };
            return { ...a, x: original.x + dx, y: original.y + dy };
          }) as Annotation[],
        );
        break;
      }

      case "resize": {
        const original = active.snapshot;

        if (isLine(original)) {
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

        if (isBox(original)) {
          const b = boundsOf(original);
          // Anchor is the corner diagonally opposite the one being dragged.
          const anchor = {
            x: active.handle === "nw" || active.handle === "sw" ? b.x + b.width : b.x,
            y: active.handle === "nw" || active.handle === "ne" ? b.y + b.height : b.y,
          };
          const end = e.shiftKey ? snapSquare(anchor, point) : point;

          store.update(active.id, {
            x: Math.min(anchor.x, end.x),
            y: Math.min(anchor.y, end.y),
            width: Math.abs(end.x - anchor.x),
            height: Math.abs(end.y - anchor.y),
          });
        }
        break;
      }
    }
  };

  const onPointerUp = () => {
    const active = drag.current;
    drag.current = null;
    if (!active) return;

    const store = useEditor.getState();

    // A click with a drawing tool that produced nothing leaves an empty shape
    // behind; drop it and the history entry that came with it.
    if (active.kind === "create") {
      const created = store.annotations.find((a) => a.id === active.id);
      if (created && isDegenerate(created)) {
        store.remove([active.id]);
        store.undo();
      }
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
    // An empty text box is a mis-click, not content.
    if (target && target.kind === "text" && !(target.text ?? "").trim()) {
      store.remove([target.id]);
    }
    setEditingId(null);
  }, [editingId]);

  // Double-click a text annotation to edit it again. Not gated on the select
  // tool either: a press on a shape no longer starts a new one, so there is
  // nothing for this to collide with.
  const onDoubleClick = (e: React.MouseEvent) => {
    const hit = [...annotations].reverse().find((a) => {
      if (a.kind !== "text") return false;
      const b = boundsOf(a);
      const p = toDoc(e);
      return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
    });
    if (hit) setEditingId(hit.id);
  };

  if (!doc) return null;

  const editing = annotations.find((a) => a.id === editingId);
  const cursor =
    tool === "select" ? "default" : tool === "text" ? "text" : "crosshair";

  return (
    <div ref={viewport} className="relative flex-1 overflow-auto bg-inset">
      <div className="flex min-h-full min-w-full items-center justify-center" style={{ padding: PAD }}>
        <div
          ref={stage}
          className="relative shrink-0 shadow-[0_16px_60px_rgba(0,0,0,0.6)] ring-1 ring-white/10"
          style={{
            width: doc.crop.width * zoom,
            height: doc.crop.height * zoom,
            cursor,
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
        >
          {/* The capture itself, windowed by the current crop. */}
          <div
            className="absolute inset-0 overflow-hidden"
            style={{ imageRendering: zoom > 1.5 ? "pixelated" : "auto" }}
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

          {pendingCrop && <CropOverlay rect={pendingCrop} doc={doc} zoom={zoom} />}

          {editing && editing.kind === "text" && (
            <TextEditor
              key={editing.id}
              value={editing.text ?? ""}
              x={editing.x * zoom}
              y={editing.y * zoom}
              color={editing.style.color}
              fontSize={editing.style.fontSize * zoom}
              onChange={(text) => useEditor.getState().update(editing.id, { text })}
              onCommit={commitEdit}
            />
          )}
        </div>
      </div>
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

/** Force a box to a square, sized by the larger axis. */
function snapSquare(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: from.x + Math.sign(dx) * side, y: from.y + Math.sign(dy) * side };
}

function CropOverlay({ rect, doc, zoom }: { rect: Rect; doc: { crop: Rect }; zoom: number }) {
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
      <div
        className="surface-pop absolute rounded-md px-2 py-1 font-mono text-[11px] tabular-nums text-ink"
        style={{ left: rect.x * zoom, top: (rect.y + rect.height) * zoom + 8 }}
      >
        {Math.round(rect.width)} × {Math.round(rect.height)}
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
  onChange,
  onCommit,
}: {
  value: string;
  x: number;
  y: number;
  color: string;
  fontSize: number;
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

  return (
    <textarea
      ref={ref}
      value={value}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
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
        color,
        font: `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif`,
        lineHeight: 1.3,
        padding: 6,
        width: Math.max(metrics.width, fontSize * 3),
        height: metrics.height,
        caretColor: color,
        textShadow: "0 1px 3px rgba(0,0,0,0.45)",
        outline: "1px dashed var(--color-accent)",
      }}
    />
  );
}
