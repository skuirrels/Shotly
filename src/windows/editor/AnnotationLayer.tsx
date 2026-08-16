import { Fragment } from "react";
import {
  arrowPolygon,
  calloutLayout,
  contrastInk,
  FONT_STACK,
  fontFor,
  freehandPath,
  measureGeometry,
  measureText,
  polygonToPath,
  stepFontSize,
  TEXT_PADDING,
} from "@/lib/shapes";
import { type Annotation, boundsOf, isLine, isPen, isStep } from "@/lib/types";
import type { Doc } from "@/state/editorStore";

interface Props {
  doc: Doc;
  annotations: Annotation[];
  selectedIds: string[];
  zoom: number;
  editingId: string | null;
  /** What hovering a shape means right now — moving it, or drawing through it. */
  shapeCursor: "move" | "crosshair";
  onShapePointerDown: (e: React.PointerEvent, id: string) => void;
  onHandlePointerDown: (e: React.PointerEvent, id: string, handle: HandleId) => void;
}

export type HandleId = "nw" | "ne" | "sw" | "se" | "start" | "end";

/**
 * Renders annotations as SVG in document pixel space.
 *
 * SVG (rather than canvas) on screen buys native hit-testing, crisp scaling at
 * any zoom, and DOM-addressable handles. The exporter re-draws the same shapes
 * with Canvas2D from the shared geometry in `lib/shapes`.
 */
export function AnnotationLayer({
  doc,
  annotations,
  selectedIds,
  zoom,
  editingId,
  shapeCursor,
  onShapePointerDown,
  onHandlePointerDown,
}: Props) {
  const { width, height } = doc.crop;
  const blurs = annotations.filter((a) => a.kind === "blur");

  return (
    <svg
      // Explicitly top-left rather than `inset-0`: setting all four offsets
      // stretches the element and overrides the width/height that establish
      // the viewBox mapping, which silently skews every annotation.
      className="absolute top-0 left-0"
      width={width * zoom}
      height={height * zoom}
      viewBox={`0 0 ${width} ${height}`}
      style={{ overflow: "visible" }}
    >
      <defs>
        <filter id="ann-shadow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="1.5" stdDeviation="2.5" floodColor="#000" floodOpacity="0.45" />
        </filter>

        {blurs.map((a) => {
          const b = boundsOf(a);
          return (
            <Fragment key={`defs-${a.id}`}>
              {/* Oversized filter region so the blur has real pixels to pull
                  from at the edges instead of fading into transparency. */}
              <filter id={`blur-${a.id}`} x="-25%" y="-25%" width="150%" height="150%">
                <feGaussianBlur stdDeviation={a.style.blurRadius} />
              </filter>
              <clipPath id={`clip-${a.id}`}>
                <rect x={b.x} y={b.y} width={b.width} height={b.height} rx={2} />
              </clipPath>
            </Fragment>
          );
        })}
      </defs>

      {annotations.map((a) => (
        <g
          key={a.id}
          // Tagged so a right-click anywhere inside the shape can find out
          // which one it hit, without the canvas having to re-run hit-testing
          // the browser has already done.
          data-annotation={a.id}
          onPointerDown={(e) => onShapePointerDown(e, a.id)}
          style={{ cursor: shapeCursor }}
        >
          <Shape a={a} doc={doc} hidden={editingId === a.id} />
        </g>
      ))}

      {/* Selection chrome sits above every shape so it is never occluded. */}
      {annotations
        .filter((a) => selectedIds.includes(a.id) && a.id !== editingId)
        .map((a) => (
          <SelectionChrome
            key={`sel-${a.id}`}
            a={a}
            zoom={zoom}
            onHandlePointerDown={onHandlePointerDown}
          />
        ))}
    </svg>
  );
}

function Shape({ a, doc, hidden }: { a: Annotation; doc: Doc; hidden: boolean }) {
  // `hidden` means "the text editor is standing in for this one". For a plain
  // text annotation the editor *is* the whole shape, so it goes; a callout is
  // a filled box with words on it, and dropping the box would leave you typing
  // onto the bare screenshot until you committed. Its fill stays, its baked
  // text does not — the editor supplies that.
  if (hidden && a.kind !== "callout") return null;
  const shadow = a.style.shadow ? "url(#ann-shadow)" : undefined;

  if (isLine(a)) {
    if (a.kind === "measure") {
      const g = measureGeometry(a, doc.scale);
      return (
        <g filter={shadow}>
          <line
            x1={g.shaft.x1}
            y1={g.shaft.y1}
            x2={g.shaft.x2}
            y2={g.shaft.y2}
            stroke={a.style.color}
            strokeWidth={a.style.strokeWidth}
          />
          {g.ticks.map(([p, q], i) => (
            <line
              key={i}
              x1={p.x}
              y1={p.y}
              x2={q.x}
              y2={q.y}
              stroke={a.style.color}
              strokeWidth={a.style.strokeWidth}
              strokeLinecap="round"
            />
          ))}
          {/* The number rides a chip of its own colour: over a screenshot the
              line may cross anything, and a bare figure would be unreadable
              exactly where it matters most. */}
          <rect
            x={g.at.x - g.box.width / 2}
            y={g.at.y - g.box.height / 2}
            width={g.box.width}
            height={g.box.height}
            rx={g.box.radius}
            fill={a.style.color}
          />
          <text
            x={g.at.x}
            y={g.at.y}
            textAnchor="middle"
            dominantBaseline="central"
            fill={contrastInk(a.style.color)}
            fontFamily={FONT_STACK}
            fontSize={g.fontSize}
            fontWeight={600}
          >
            {g.label}
          </text>
          <line
            x1={a.x1}
            y1={a.y1}
            x2={a.x2}
            y2={a.y2}
            stroke="transparent"
            strokeWidth={Math.max(14, a.style.strokeWidth * 2)}
          />
        </g>
      );
    }
    if (a.kind === "arrow") {
      return (
        <>
          <path d={polygonToPath(arrowPolygon(a))} fill={a.style.color} filter={shadow} />
          {/* Invisible fat stroke so thin arrows are still easy to grab. */}
          <line
            x1={a.x1}
            y1={a.y1}
            x2={a.x2}
            y2={a.y2}
            stroke="transparent"
            strokeWidth={Math.max(14, a.style.strokeWidth * 2)}
          />
        </>
      );
    }
    return (
      <>
        <line
          x1={a.x1}
          y1={a.y1}
          x2={a.x2}
          y2={a.y2}
          stroke={a.style.color}
          strokeWidth={a.style.strokeWidth}
          strokeLinecap="round"
          filter={shadow}
        />
        <line
          x1={a.x1}
          y1={a.y1}
          x2={a.x2}
          y2={a.y2}
          stroke="transparent"
          strokeWidth={Math.max(14, a.style.strokeWidth * 2)}
        />
      </>
    );
  }

  if (isPen(a)) {
    const d = freehandPath(a.points);
    return (
      <>
        <path
          d={d}
          fill="none"
          stroke={a.style.color}
          strokeWidth={a.style.strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          filter={shadow}
        />
        {/* Invisible fat copy, so a thin scribble is grabbable without
            demanding pixel-perfect aim. Stroke-only and never filled: a
            scribble that loops back on itself must not become a solid blob
            that swallows everything drawn beneath it. */}
        <path
          d={d}
          fill="none"
          stroke="transparent"
          strokeWidth={Math.max(14, a.style.strokeWidth * 2)}
          strokeLinecap="round"
        />
      </>
    );
  }

  if (isStep(a)) {
    const fs = stepFontSize(a);
    return (
      <g filter={shadow}>
        <circle cx={a.x} cy={a.y} r={a.radius} fill={a.style.color} />
        <text
          x={a.x}
          y={a.y}
          textAnchor="middle"
          dominantBaseline="central"
          fill="#fff"
          style={{ font: fontFor(fs), pointerEvents: "none" }}
        >
          {a.label}
        </text>
      </g>
    );
  }

  const b = boundsOf(a);

  switch (a.kind) {
    case "image":
      return (
        <image
          href={a.src}
          x={b.x}
          y={b.y}
          width={b.width}
          height={b.height}
          // The aspect ratio is held by the resize itself, so the renderer is
          // told to fill the rectangle exactly rather than letter-box inside it
          // and leave a transparent margin that still hit-tests.
          preserveAspectRatio="none"
          filter={shadow}
        />
      );

    case "rect":
      return (
        <rect
          x={b.x}
          y={b.y}
          width={b.width}
          height={b.height}
          rx={Math.min(4, b.width / 2, b.height / 2)}
          fill={a.style.fillOpacity > 0 ? a.style.color : "transparent"}
          fillOpacity={a.style.fillOpacity}
          stroke={a.style.color}
          strokeWidth={a.style.strokeWidth}
          filter={shadow}
        />
      );

    case "ellipse":
      return (
        <ellipse
          cx={b.x + b.width / 2}
          cy={b.y + b.height / 2}
          rx={Math.max(b.width / 2, 0.5)}
          ry={Math.max(b.height / 2, 0.5)}
          fill={a.style.fillOpacity > 0 ? a.style.color : "transparent"}
          fillOpacity={a.style.fillOpacity}
          stroke={a.style.color}
          strokeWidth={a.style.strokeWidth}
          filter={shadow}
        />
      );

    case "blur":
      return (
        <g clipPath={`url(#clip-${a.id})`}>
          <image
            href={doc.src}
            x={-doc.crop.x}
            y={-doc.crop.y}
            width={doc.naturalWidth}
            height={doc.naturalHeight}
            filter={`url(#blur-${a.id})`}
            preserveAspectRatio="none"
          />
        </g>
      );

    case "highlight":
      return (
        <rect
          x={b.x}
          y={b.y}
          width={b.width}
          height={b.height}
          fill={a.style.color}
          opacity={0.34}
          style={{ mixBlendMode: "multiply" }}
        />
      );

    case "spotlight": {
      const { width: w, height: h } = doc.crop;
      return (
        <>
          {/* Two subpaths and the even-odd rule: the outer covers the capture,
              the inner punches the lit region out of it. */}
          <path
            d={`M0 0H${w}V${h}H0Z M${b.x} ${b.y}H${b.x + b.width}V${b.y + b.height}H${b.x}Z`}
            fillRule="evenodd"
            fill="#000"
            fillOpacity={a.style.dim ?? 0.55}
            // Deliberately not a click target. This shape covers the whole
            // capture by definition, so a hit-testable one would mean every
            // click anywhere selected the spotlight and nothing else could
            // ever be drawn or picked up again.
            pointerEvents="none"
          />
          {/* The rim is the grab handle, as a fat invisible stroke — the same
              trick that makes hairline arrows selectable. */}
          <rect
            x={b.x}
            y={b.y}
            width={b.width}
            height={b.height}
            fill="none"
            stroke="transparent"
            strokeWidth={14}
          />
        </>
      );
    }

    case "callout": {
      const { lines, lineHeight } = calloutLayout(a.text ?? "", a.style.fontSize, b.width);
      const ink = contrastInk(a.style.color);
      // Centred in the box rather than run from the top: a callout is usually
      // two or three words, and left-aligned short text in a wide box reads as
      // a mistake.
      const first = b.y + b.height / 2 - ((lines.length - 1) * lineHeight) / 2;

      return (
        <g filter={shadow}>
          <rect
            x={b.x}
            y={b.y}
            width={b.width}
            height={b.height}
            rx={Math.min(10, b.width / 2, b.height / 2)}
            fill={a.style.color}
          />
          {!hidden && (
            <text
              x={b.x + b.width / 2}
              textAnchor="middle"
              dominantBaseline="central"
              fill={ink}
              style={{ font: fontFor(a.style.fontSize), pointerEvents: "none" }}
            >
              {lines.map((line, i) => (
                <tspan key={i} x={b.x + b.width / 2} y={first + i * lineHeight}>
                  {line || " "}
                </tspan>
              ))}
            </text>
          )}
        </g>
      );
    }

    case "text": {
      const m = measureText(a.text ?? "", a.style.fontSize);
      return (
        <g filter={shadow}>
          <text
            x={b.x + TEXT_PADDING}
            y={b.y + TEXT_PADDING}
            fill={a.style.color}
            style={{ font: fontFor(a.style.fontSize), whiteSpace: "pre" }}
          >
            {m.lines.map((line, i) => (
              <tspan key={i} x={b.x + TEXT_PADDING} dy={i === 0 ? m.lineHeight * 0.8 : m.lineHeight}>
                {line || " "}
              </tspan>
            ))}
          </text>
        </g>
      );
    }
  }
}

function SelectionChrome({
  a,
  zoom,
  onHandlePointerDown,
}: {
  a: Annotation;
  zoom: number;
  onHandlePointerDown: Props["onHandlePointerDown"];
}) {
  // Divide by zoom so chrome keeps a constant on-screen size at any zoom level.
  const px = (n: number) => n / zoom;

  if (isLine(a)) {
    return (
      <g>
        <line
          x1={a.x1}
          y1={a.y1}
          x2={a.x2}
          y2={a.y2}
          stroke="var(--color-accent)"
          strokeWidth={px(1)}
          strokeDasharray={`${px(4)} ${px(3)}`}
          pointerEvents="none"
        />
        <Handle x={a.x1} y={a.y1} zoom={zoom} onDown={(e) => onHandlePointerDown(e, a.id, "start")} />
        <Handle x={a.x2} y={a.y2} zoom={zoom} onDown={(e) => onHandlePointerDown(e, a.id, "end")} />
      </g>
    );
  }

  const b = boundsOf(a);
  const inset = px(3);

  return (
    <g>
      <rect
        x={b.x - inset}
        y={b.y - inset}
        width={b.width + inset * 2}
        height={b.height + inset * 2}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={px(1)}
        strokeDasharray={`${px(4)} ${px(3)}`}
        pointerEvents="none"
      />
      {isStep(a) ? null : (
        <>
          <Handle x={b.x} y={b.y} zoom={zoom} onDown={(e) => onHandlePointerDown(e, a.id, "nw")} />
          <Handle
            x={b.x + b.width}
            y={b.y}
            zoom={zoom}
            onDown={(e) => onHandlePointerDown(e, a.id, "ne")}
          />
          <Handle
            x={b.x}
            y={b.y + b.height}
            zoom={zoom}
            onDown={(e) => onHandlePointerDown(e, a.id, "sw")}
          />
          <Handle
            x={b.x + b.width}
            y={b.y + b.height}
            zoom={zoom}
            onDown={(e) => onHandlePointerDown(e, a.id, "se")}
          />
        </>
      )}
    </g>
  );
}

function Handle({
  x,
  y,
  zoom,
  onDown,
}: {
  x: number;
  y: number;
  zoom: number;
  onDown: (e: React.PointerEvent) => void;
}) {
  const r = 4.5 / zoom;
  return (
    <>
      <circle cx={x} cy={y} r={r} fill="var(--color-accent)" stroke="#fff" strokeWidth={1.5 / zoom} />
      {/* Generous invisible hit area — the visible dot is too small to grab. */}
      <circle cx={x} cy={y} r={r * 2.6} fill="transparent" onPointerDown={onDown} />
    </>
  );
}
