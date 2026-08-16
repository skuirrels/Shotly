/**
 * Small interface preferences, kept in the webview's local storage.
 *
 * Not settings: there is no panel for these and nothing reads one but the
 * window that wrote it. They are the ordinary state of the interface — which
 * tool was in hand, what colour it was drawing in, how thick — and the cost of
 * losing one is a click.
 *
 * Which is why every read here is guarded and validated rather than trusted.
 * Reading storage can throw outright when the webview has it disabled, and
 * these run while a module is still initialising, where an exception takes the
 * whole window down instead of one preference. A stored value that no longer
 * makes sense — a colour that isn't one, a width from a version whose control
 * reached further than this one does — is discarded rather than restored,
 * because putting it back would leave the interface somewhere its own controls
 * cannot get it out of.
 */

export function readString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable. Forgetting a preference is not worth a broken click.
  }
}

/** `#RGB` or `#RRGGBB`; what both the swatches and the eyedropper produce. */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function readColor(key: string, fallback: string): string {
  const saved = readString(key);
  return saved !== null && HEX.test(saved) ? saved : fallback;
}

/**
 * A stored number, if it is one and still inside the range given.
 *
 * The bounds are the ones the control itself enforces, passed in rather than
 * assumed: a value outside them would show a slider pinned to one end and a
 * shape that doesn't match it.
 */
export function readNumber(key: string, fallback: number, min: number, max: number): number {
  const saved = readString(key);
  if (saved === null) return fallback;
  const value = Number(saved);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}
