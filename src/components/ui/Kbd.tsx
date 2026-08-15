import { formatShortcut } from "@/lib/keys/keys";

/**
 * A keycap. Takes the authored shortcut string so callers never hand-write
 * glyphs — "Mod+Shift+Z" renders as ⇧⌘Z on its own.
 */
export function Kbd({ shortcut, muted = false }: { shortcut: string; muted?: boolean }) {
  return (
    <kbd
      className={[
        "inline-flex min-w-[18px] items-center justify-center rounded-[5px] px-[5px] py-[1px]",
        "font-sans text-[11px] leading-[16px] font-medium tabular-nums",
        "border border-white/10",
        muted ? "bg-white/[0.04] text-ink-3" : "bg-white/[0.07] text-ink-2",
      ].join(" ")}
    >
      {formatShortcut(shortcut)}
    </kbd>
  );
}
