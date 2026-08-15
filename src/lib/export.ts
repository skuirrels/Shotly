import { invoke } from "@tauri-apps/api/core";
import {
  arrowPolygon,
  fontFor,
  measureText,
  SHADOW,
  stepFontSize,
  TEXT_PADDING,
} from "./shapes";
import { type Annotation, boundsOf, isBox, isLine, isPen, isStep } from "./types";
import type { Doc } from "@/state/editorStore";

/**
 * Renders the document to a PNG at native capture resolution.
 *
 * The image is loaded through Rust as raw bytes and wrapped in a blob URL
 * rather than fetched over the asset protocol — a cross-origin image would
 * taint the canvas and make `toBlob` throw.
 */
export async function renderToPng(doc: Doc, annotations: Annotation[]): Promise<Uint8Array> {
  const bytes = await invoke<number[]>("read_capture_bytes", { path: doc.path });
  const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
  const url = URL.createObjectURL(blob);

  try {
    const img = await loadImage(url);

    const { width, height } = doc.crop;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width);
    canvas.height = Math.round(height);

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("could not acquire a 2D context");

    ctx.drawImage(img, doc.crop.x, doc.crop.y, width, height, 0, 0, width, height);

    for (const a of annotations) {
      drawAnnotation(ctx, a, img, doc);
    }

    return await canvasToPng(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not decode the capture"));
    img.src = url;
  });
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

function withShadow(ctx: CanvasRenderingContext2D, on: boolean, draw: () => void) {
  ctx.save();
  if (on) {
    ctx.shadowColor = SHADOW.color;
    ctx.shadowBlur = SHADOW.blur;
    ctx.shadowOffsetY = SHADOW.offsetY;
  }
  draw();
  ctx.restore();
}

function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  img: HTMLImageElement,
  doc: Doc,
) {
  const { color, strokeWidth, fillOpacity } = a.style;

  if (isLine(a)) {
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
  if (!isBox(a)) return;

  switch (a.kind) {
    case "rect":
      withShadow(ctx, a.style.shadow, () => {
        const r = Math.min(4, b.width / 2, b.height / 2);
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
        ctx.stroke();
      });
      break;

    case "ellipse":
      withShadow(ctx, a.style.shadow, () => {
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
      ctx.drawImage(
        img,
        doc.crop.x,
        doc.crop.y,
        doc.crop.width,
        doc.crop.height,
        0,
        0,
        doc.crop.width,
        doc.crop.height,
      );
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
