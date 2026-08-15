/**
 * Find the nearest descendant that actually occupies space.
 *
 * Triggers get wrapped in `display: contents` spans (by Tooltip, and by Popover
 * itself). Such an element generates no box, so `getBoundingClientRect()` on it
 * returns all zeros — which silently anchors floating UI to the top-left corner
 * of the screen rather than to the control. Walk down to the first real box.
 */
export function measurableElement(root: Element | null | undefined): Element | null {
  if (!root) return null;

  const rect = root.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0) return root;

  for (const child of Array.from(root.children)) {
    const found = measurableElement(child);
    if (found) return found;
  }
  return null;
}

export interface Placement {
  x: number;
  y: number;
}

/**
 * Place a floating panel against an anchor, kept inside the viewport.
 *
 * Flips above the anchor when there isn't room below — Shotly's tool palette
 * sits at the bottom of the window, so its popovers almost always open upward.
 */
export function placeAgainst(
  anchor: DOMRect,
  panel: { width: number; height: number },
  align: "start" | "center" = "center",
  gap = 8,
): Placement {
  const margin = 8;

  const raw = align === "center" ? anchor.left + anchor.width / 2 - panel.width / 2 : anchor.left;
  const x = Math.max(margin, Math.min(raw, window.innerWidth - panel.width - margin));

  const below = anchor.bottom + gap;
  const fitsBelow = below + panel.height + margin <= window.innerHeight;
  const y = fitsBelow ? below : Math.max(margin, anchor.top - panel.height - gap);

  return { x, y };
}
