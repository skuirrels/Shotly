import { renderToPng } from "@/lib/export";
import { DEFAULT_BACKDROP, NO_BACKDROP, backdropMetrics } from "@/lib/backdrop";
import type { Doc } from "@/state/editorStore";
import type { Annotation } from "@/lib/types";

/**
 * Measures what the real exporter actually produces at each output scale.
 *
 * Dimensions are checked against the arithmetic the picker shows the user, and
 * pixels are sampled to prove the drawing fills the bitmap rather than sitting
 * in one corner of a canvas that merely has the right size.
 */

const SOURCE = { width: 800, height: 600 };

function doc(outputScale: number, crop = { x: 0, y: 0, ...SOURCE }): Doc {
  return {
    id: 1,
    src: "/source.png",
    path: "/source.png",
    naturalWidth: SOURCE.width,
    naturalHeight: SOURCE.height,
    crop,
    scale: 2,
    outputScale,
  };
}

const style = {
  color: "#FF3B30",
  strokeWidth: 10,
  fontSize: 48,
  fillOpacity: 1,
  blurRadius: 12,
  dim: 0.55,
  shadow: true,
};

/** A filled red square in the middle, so its edges can be found by sampling. */
const marker: Annotation[] = [
  { id: "a", kind: "rect", x: 300, y: 200, width: 200, height: 200, style } as Annotation,
];

async function decode(png: Uint8Array) {
  const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }));
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const at = (x: number, y: number) => {
    const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  };
  return { width: bitmap.width, height: bitmap.height, at };
}

const lines: string[] = [];
const say = (s: string) => lines.push(s);

async function main() {
  // 1. Plain resize, no frame. Dimensions must be the document size scaled.
  for (const scale of [1, 0.75, 0.5, 0.25]) {
    const png = await renderToPng(doc(scale), marker, NO_BACKDROP);
    const img = await decode(png);
    const want = { w: Math.round(800 * scale), h: Math.round(600 * scale) };
    // The marker occupies the middle quarter at every scale, so its centre and
    // a point just outside it prove the drawing scaled with the canvas.
    say(
      `plain ${scale}: ${img.width}x${img.height} ` +
        `(want ${want.w}x${want.h} ${img.width === want.w && img.height === want.h ? "OK" : "WRONG"}) ` +
        `centre=${img.at(img.width / 2, img.height / 2)} ` +
        `outside=${img.at(img.width * 0.12, img.height * 0.12)}`,
    );
  }

  // 2. An odd size, where the rounding matters.
  const odd = await renderToPng(doc(1 / 3, { x: 0, y: 0, width: 701, height: 519 }), [], NO_BACKDROP);
  const oddImg = await decode(odd);
  say(
    `odd 701x519 @1/3: ${oddImg.width}x${oddImg.height} ` +
      `(want ${Math.round(701 / 3)}x${Math.round(519 / 3)}) ` +
      `corner=${oddImg.at(oddImg.width - 1, oddImg.height - 1)}`,
  );

  // 3. With a frame. The whole framed box scales, so the margin stays the same
  //    fraction of the picture rather than becoming a hairline.
  const frame = { ...DEFAULT_BACKDROP, fill: "ink", padding: 0.05, radius: 0, shadow: false };
  const m = backdropMetrics(frame, 800, 600);
  for (const scale of [1, 0.5]) {
    const png = await renderToPng(doc(scale), [], frame);
    const img = await decode(png);
    const want = { w: Math.round(m.width * scale), h: Math.round(m.height * scale) };
    say(
      `framed ${scale}: ${img.width}x${img.height} ` +
        `(want ${want.w}x${want.h} ${img.width === want.w && img.height === want.h ? "OK" : "WRONG"}) ` +
        `margin=${img.at(2, img.height / 2)} inside=${img.at(img.width / 2, img.height / 2)} ` +
        `padFraction=${(m.pad * scale) / img.width}`,
    );
  }

  // 4. Scaling up is refused by the store, but the exporter should not produce
  //    nonsense if it ever sees a value it did not expect.
  const up = await renderToPng(doc(2), [], NO_BACKDROP);
  const upImg = await decode(up);
  say(`unclamped 2.0 straight to exporter: ${upImg.width}x${upImg.height}`);

  // 5. Shadows. Canvas shadow blur and offset ignore the transform, so they
  //    are compensated by hand — this measures whether that worked. The shadow
  //    should reach the same *fraction* down the frame at every scale.
  const lit = { ...DEFAULT_BACKDROP, fill: "paper", padding: 0.14, radius: 0, shadow: true };
  for (const scale of [1, 0.5, 0.25]) {
    const png = await renderToPng(doc(scale), [], lit);
    const img = await decode(png);
    const pad = Math.round(backdropMetrics(lit, 800, 600).pad * scale);
    // Walk down from just under the picture until the pure backdrop returns.
    const clean = img.at(img.width / 2, img.height - 2);
    let reach = 0;
    for (let y = img.height - pad; y < img.height - 1; y++) {
      if (img.at(img.width / 2, y) !== clean) reach = y - (img.height - pad) + 1;
    }
    say(`shadow ${scale}: reaches ${reach}px of ${pad}px margin = ${(reach / pad).toFixed(3)}`);
  }

  document.getElementById("out")!.textContent = lines.join("\n");
  (window as unknown as { RESULT: string }).RESULT = lines.join("\n");
}

main().catch((e) => {
  document.getElementById("out")!.textContent = `FAILED: ${e}\n${e.stack}`;
});
