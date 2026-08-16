/**
 * The name a new capture is filed under.
 *
 * macOS's own screenshot format — "Shotly 2026-08-14 at 18.33.21" — because a
 * library sorted by name then reads chronologically, and because it is the
 * shape people already recognise as "a screenshot from that afternoon".
 *
 * Shared: captures come from the editor, and from the annotation layer on its
 * way out. Two implementations of this would drift, and the drift would show up
 * as a library that sorts inconsistently.
 */
export function captureStem(when = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}`;
  const time = `${p(when.getHours())}.${p(when.getMinutes())}.${p(when.getSeconds())}`;
  return `Shotly ${date} at ${time}`;
}
