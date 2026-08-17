import { invoke } from "@tauri-apps/api/core";
import {
  arrowPolygon,
  calloutBaselines,
  calloutLayout,
  neonBorderForFont,
  neonPaint,
  neonRadius,
  contrastInk,
  FONT_STACK,
  fontFor,
  measureGeometry,
  measureText,
  SHADOW,
  stepFontSize,
  TEXT_PADDING,
} from "./shapes";
import { type Annotation, boundsOf, isBox, isImage, isLine, isPen, isStep } from "./types";
import { type Doc, hasBareCanvas } from "@/state/editorStore";
import {
  type Backdrop,
  backdropMetrics,
  fillById,
  fillToCanvas,
  hasBackdrop,
} from "./backdrop";

/**
 * Renders the document to a PNG at native capture resolution.
 *
 * The image is loaded through Rust as raw bytes and wrapped in a blob URL
 * rather than fetched over the asset protocol — a cross-origin image would
 * taint the canvas and make `toBlob` throw.
 */
export async function renderToPng(
  doc: Doc,
  annotations: Annotation[],
  backdrop?: Backdrop,
): Promise<Uint8Array> {
  const bytes = await invoke<number[]>("read_capture_bytes", { path: doc.path });
  const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
  const url = URL.createObjectURL(blob);

  try {
    const img = await loadImage(url);

    const { width, height } = doc.crop;
    const frame = backdrop && hasBackdrop(backdrop) ? backdrop : null;
    const metrics = frame ? backdropMetrics(frame, width, height) : null;

    // Everything below draws at the document's own size, as it always has.
    // The resize is one transform applied before any of it: an output scale
    // that reached the draw loop would mean every shape, stroke width, font
    // and shadow having to remember to multiply by it, and one that forgot
    // would be a bug nobody sees until they resize something.
    const out = doc.outputScale ?? 1;
    const boxWidth = metrics ? metrics.width : width;
    const boxHeight = metrics ? metrics.height : height;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(boxWidth * out));
    canvas.height = Math.max(1, Math.round(boxHeight * out));

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("could not acquire a 2D context");

    // Rounding above means the scale that actually lands is a hair off `out`
    // on odd sizes. Deriving it back from the canvas keeps the drawing filling
    // the bitmap exactly, rather than leaving a sub-pixel transparent seam.
    if (out !== 1) ctx.scale(canvas.width / boxWidth, canvas.height / boxHeight);

    if (frame && metrics) {
      drawBackdrop(ctx, frame, metrics, boxWidth, boxHeight);
      // Everything after this is drawn in the capture's own coordinates, as
      // it always was — the frame is the only thing that knows about the
      // margin, and shifting the origin once is what keeps it that way.
      ctx.translate(metrics.pad, metrics.pad);
      // Clip to the rounded corners so the capture's own edges are cut to the
      // same shape as the shadow that was just drawn under them.
      roundedPath(ctx, 0, 0, width, height, metrics.radius);
      ctx.clip();
    }

    // Bare canvas first, where the crop reaches past the capture. Only then —
    // a fill under an opaque screenshot is invisible work, and a capture that
    // does carry alpha should keep showing it.
    if (hasBareCanvas(doc) && doc.canvasFill !== "transparent") {
      ctx.fillStyle = doc.canvasFill;
      ctx.fillRect(0, 0, width, height);
    }

    // Positioned rather than source-cropped: `drawImage` with a source
    // rectangle needs that rectangle to be inside the image, and the crop is
    // allowed to be larger than the capture — that is how the canvas expands.
    // Offsetting the whole image says the same thing for an ordinary crop and
    // keeps working when the window hangs off the edge.
    ctx.drawImage(img, -doc.crop.x, -doc.crop.y);

    // Overlays carry their own pixels and have to be decoded before a
    // synchronous draw loop can put them down. Data URLs don't taint the
    // canvas, so this stays a plain `drawImage`.
    const overlays = await decodeOverlays(annotations);

    for (const a of annotations) {
      drawAnnotation(ctx, a, img, doc, overlays);
    }

    return await canvasToPng(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The frame: background, then the shadow the capture will sit on.
 *
 * The shadow is painted as a filled rounded rectangle *before* the capture
 * rather than as a shadow on the capture itself — a shadow attached to the
 * draw of an opaque image is hidden behind it everywhere except the edges,
 * which is fine, but it also has to survive the clip that follows, and it
 * does not.
 */
function drawBackdrop(
  ctx: CanvasRenderingContext2D,
  backdrop: Backdrop,
  metrics: ReturnType<typeof backdropMetrics>,
  width: number,
  height: number,
): void {
  const fill = fillById(backdrop.fill);
  if (!fill) return;

  ctx.save();
  ctx.fillStyle = fillToCanvas(ctx, fill, width, height);
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  if (!backdrop.shadow) return;

  const shadow = shadowScale(ctx);

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = metrics.shadowBlur * shadow;
  ctx.shadowOffsetY = metrics.shadowOffset * shadow;
  ctx.fillStyle = "#000";
  roundedPath(
    ctx,
    metrics.pad,
    metrics.pad,
    width - metrics.pad * 2,
    height - metrics.pad * 2,
    metrics.radius,
  );
  ctx.fill();
  ctx.restore();
}

/** A rounded rectangle as a path, for both the shadow and the clip. */
function roundedPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not decode the capture"));
    img.src = url;
  });
}

async function decodeOverlays(
  annotations: Annotation[],
): Promise<Map<string, HTMLImageElement>> {
  const decoded = new Map<string, HTMLImageElement>();
  await Promise.all(
    annotations.filter(isImage).map(async (a) => {
      decoded.set(a.id, await loadImage(a.src));
    }),
  );
  return decoded;
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error("PNG encoding failed"));
      blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
    }, "image/png");
  });
}

// ------------------------------------------------------------------ drawing

/**
 * How much to multiply a shadow's blur and offset by, given the transform.
 *
 * Canvas shadows are the one thing the current transformation matrix does not
 * touch: scale the context to half size and every shape halves while its
 * shadow stays exactly as wide as before, which at 50% reads as a shape
 * floating twice as high off the page. Reading the scale back out of the
 * matrix keeps shadows proportional without every caller having to be told
 * what the output scale is.
 */
function shadowScale(ctx: CanvasRenderingContext2D): number {
  const { a, b } = ctx.getTransform();
  return Math.hypot(a, b) || 1;
}

/**
 * Stroke twice through a coloured shadow: the neon glow.
 *
 * The mirror of `glow()` in `AnnotationLayer`, and it has to stay one — a tight
 * halo and a wide one, in the shape's own colour. `shadowBlur` is in device
 * pixels and ignores the transform, exactly as the backdrop's shadow does, so
 * it is scaled by hand or a halved export would come back with a glow twice the
 * size it should be.
 */
function withGlow(
  ctx: CanvasRenderingContext2D,
  color: string,
  blur: number,
  stroke: () => void,
) {
  const scale = shadowScale(ctx);
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur * scale;
  stroke();
  ctx.shadowBlur = blur * 2 * scale;
  stroke();
  ctx.restore();
}

function withShadow(ctx: CanvasRenderingContext2D, on: boolean, draw: () => void) {
  ctx.save();
  if (on) {
    const shadow = shadowScale(ctx);
    ctx.shadowColor = SHADOW.color;
    ctx.shadowBlur = SHADOW.blur * shadow;
    ctx.shadowOffsetY = SHADOW.offsetY * shadow;
  }
  draw();
  ctx.restore();
}

function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  img: HTMLImageElement,
  doc: Doc,
  overlays: Map<string, HTMLImageElement>,
) {
  const { color, strokeWidth, fillOpacity } = a.style;

  if (isLine(a)) {
    if (a.kind === "measure") {
      const g = measureGeometry(a, doc.scale);
      withShadow(ctx, a.style.shadow, () => {
        ctx.strokeStyle = color;
        ctx.lineWidth = strokeWidth;
        ctx.lineCap = "round";

        ctx.beginPath();
        ctx.moveTo(g.shaft.x1, g.shaft.y1);
        ctx.lineTo(g.shaft.x2, g.shaft.y2);
        for (const [p, q] of g.ticks) {
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
        }
        ctx.stroke();

        // Chip then number, matching the preview exactly — see `measureGeometry`.
        ctx.fillStyle = color;
        roundedPath(
          ctx,
          g.at.x - g.box.width / 2,
          g.at.y - g.box.height / 2,
          g.box.width,
          g.box.height,
          g.box.radius,
        );
        ctx.fill();

        ctx.fillStyle = contrastInk(color);
        ctx.font = `600 ${g.fontSize}px ${FONT_STACK}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(g.label, g.at.x, g.at.y);
      });
      return;
    }

    withShadow(ctx, a.style.shadow, () => {
      if (a.kind === "arrow") {
        const points = arrowPolygon(a);
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(a.x1, a.y1);
        ctx.lineTo(a.x2, a.y2);
        ctx.strokeStyle = color;
        ctx.lineWidth = strokeWidth;
        ctx.lineCap = "round";
        ctx.stroke();
      }
    });
    return;
  }

  if (isPen(a)) {
    if (a.points.length === 0) return;
    withShadow(ctx, a.style.shadow, () => {
      ctx.beginPath();
      ctx.moveTo(a.points[0].x, a.points[0].y);
      // A single sample still draws: with a round cap, a zero-length segment is
      // the dot a tap should leave behind.
      if (a.points.length === 1) ctx.lineTo(a.points[0].x, a.points[0].y);
      for (const p of a.points.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = strokeWidth;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
    });
    return;
  }

  if (isStep(a)) {
    withShadow(ctx, a.style.shadow, () => {
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    });

    ctx.save();
    ctx.fillStyle = "#fff";
    ctx.font = fontFor(stepFontSize(a));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(a.label), a.x, a.y);
    ctx.restore();
    return;
  }

  const b = boundsOf(a);

  if (isImage(a)) {
    const overlay = overlays.get(a.id);
    // A source that wouldn't decode is skipped rather than drawn as a hole:
    // the rest of the document is still worth exporting.
    if (overlay) {
      withShadow(ctx, a.style.shadow, () => ctx.drawImage(overlay, b.x, b.y, b.width, b.height));
    }
    return;
  }

  if (!isBox(a)) return;

  switch (a.kind) {
    case "rect":
      // A lit edge instead of a cast shadow, matching the preview — see the
      // `neon` branch in `AnnotationLayer`.
      withShadow(ctx, a.style.shadow && !a.style.neon, () => {
        const r = a.style.neon
          ? neonRadius(b.width, b.height)
          : Math.min(4, b.width / 2, b.height / 2);
        ctx.beginPath();
        ctx.roundRect(b.x, b.y, b.width, b.height, r);
        if (fillOpacity > 0) {
          ctx.globalAlpha = fillOpacity;
          ctx.fillStyle = color;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = strokeWidth;
        if (a.style.neon) {
          withGlow(ctx, color, neonPaint(color, strokeWidth).glow, () => ctx.stroke());
        }
        ctx.stroke();
      });
      break;

    case "ellipse":
      withShadow(ctx, a.style.shadow && !a.style.neon, () => {
        ctx.beginPath();
        ctx.ellipse(
          b.x + b.width / 2,
          b.y + b.height / 2,
          Math.max(b.width / 2, 0.5),
          Math.max(b.height / 2, 0.5),
          0,
          0,
          Math.PI * 2,
        );
        if (fillOpacity > 0) {
          ctx.globalAlpha = fillOpacity;
          ctx.fillStyle = color;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = strokeWidth;
        if (a.style.neon) {
          withGlow(ctx, color, neonPaint(color, strokeWidth).glow, () => ctx.stroke());
        }
        ctx.stroke();
      });
      break;

    case "blur":
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(b.x, b.y, b.width, b.height, 2);
      ctx.clip();
      // Redraw the whole image blurred, clipped to the region. Drawing the
      // full image (not just the region) means the blur samples real
      // neighbouring pixels instead of fading out at the edges.
      ctx.filter = `blur(${a.style.blurRadius}px)`;
      // Positioned, not source-cropped, for the same reason as the main draw:
      // the crop may reach past the capture, and a source rectangle that does
      // is not a legal argument.
      ctx.drawImage(img, -doc.crop.x, -doc.crop.y);
      ctx.restore();
      break;

    case "highlight":
      ctx.save();
      ctx.globalCompositeOperation = "multiply";
      ctx.globalAlpha = 0.34;
      ctx.fillStyle = color;
      ctx.fillRect(b.x, b.y, b.width, b.height);
      ctx.restore();
      break;

    case "spotlight":
      ctx.save();
      ctx.beginPath();
      // Outer subpath covers the capture, inner one punches out the lit
      // region; even-odd is what makes the second a hole rather than a
      // second layer of darkness. Mirrors the SVG in `AnnotationLayer`.
      ctx.rect(0, 0, doc.crop.width, doc.crop.height);
      ctx.rect(b.x, b.y, b.width, b.height);
      ctx.fillStyle = `rgba(0,0,0,${a.style.dim ?? 0.55})`;
      ctx.fill("evenodd");
      ctx.restore();
      break;

    case "callout": {
      const layout = calloutLayout(a.text ?? "", a.style.fontSize, b.width);
      const { lines } = layout;
      const paint = neonPaint(color, neonBorderForFont(a.style.fontSize));

      if (a.style.neon) {
        // The four layers of `neonPaint`, in its order. The border is inset by
        // half its width because a canvas stroke straddles the path, and the
        // SVG rect it has to match is inset for the same reason.
        const r = neonRadius(b.width, b.height);
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(b.x, b.y, b.width, b.height, r);
        ctx.fillStyle = paint.scrim;
        ctx.fill();
        ctx.fillStyle = paint.tint;
        ctx.fill();

        ctx.beginPath();
        ctx.roundRect(
          b.x + paint.border / 2,
          b.y + paint.border / 2,
          Math.max(0, b.width - paint.border),
          Math.max(0, b.height - paint.border),
          Math.max(0, r - paint.border / 2),
        );
        ctx.strokeStyle = color;
        ctx.lineWidth = paint.border;
        withGlow(ctx, color, paint.glow, () => ctx.stroke());
        ctx.stroke();
        ctx.restore();
      } else {
        withShadow(ctx, a.style.shadow, () => {
          ctx.beginPath();
          ctx.roundRect(b.x, b.y, b.width, b.height, Math.min(10, b.width / 2, b.height / 2));
          ctx.fillStyle = color;
          ctx.fill();
        });
      }

      ctx.save();
      ctx.fillStyle = a.style.neon ? paint.ink : contrastInk(color);
      ctx.font = fontFor(a.style.fontSize);
      ctx.textAlign = "center";
      // Alphabetic, with the baselines worked out by `calloutBaselines` — the
      // same call the SVG makes, so neither renderer depends on an engine's
      // idea of where "middle" is.
      ctx.textBaseline = "alphabetic";
      const baselines = calloutBaselines(b, layout, a.style.fontSize);
      lines.forEach((line, i) => {
        ctx.fillText(line, b.x + b.width / 2, baselines[i]);
      });
      ctx.restore();
      break;
    }

    case "text": {
      const m = measureText(a.text ?? "", a.style.fontSize);
      withShadow(ctx, a.style.shadow, () => {
        ctx.fillStyle = color;
        ctx.font = fontFor(a.style.fontSize);
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        m.lines.forEach((line, i) => {
          ctx.fillText(
            line,
            b.x + TEXT_PADDING,
            // Matches the SVG's first-baseline offset of 0.8 line heights.
            b.y + TEXT_PADDING + m.lineHeight * (0.8 + i),
          );
        });
      });
      break;
    }
  }
}
