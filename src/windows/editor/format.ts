/** Human-readable file sizes and dates, shared by the library grid and rail. */

/** A running time, the way a player writes it: 0:07, 1:42, 1:02:03. */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A time for today's captures, a date for older ones.
 *
 * Captures cluster in the last few hours, where the clock time is what tells
 * two of them apart; a date would be the same on all of them.
 */
export function formatWhen(ms: number): string {
  if (!ms) return "";
  const date = new Date(ms);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();

  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  const thisYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(thisYear ? {} : { year: "numeric" }),
  });
}
