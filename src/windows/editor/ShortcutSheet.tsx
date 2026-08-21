import { useEffect, useState } from "react";
import { Kbd } from "@/components/ui/Kbd";
import { IconClose } from "@/components/icons";
import { IconButton } from "@/components/ui/IconButton";
import * as ipc from "@/lib/ipc";
import type { Command, CommandGroup } from "@/lib/keys/types";
import type { HotkeyBinding } from "@/lib/types";

const ORDER: CommandGroup[] = ["Tools", "Edit", "Style", "Arrange", "View", "Capture", "Export"];

/**
 * Pointer gestures, which have no command to generate them from.
 *
 * Alt-drag especially earns its place here: it is the only way to draw inside
 * a shape that already covers the area, and nothing on screen hints at it.
 */
const GESTURES: { action: string; gesture: string }[] = [
  { action: "Zoom in and out", gesture: "⌘-scroll, or pinch" },
  { action: "Push the canvas around", gesture: "Hold space and drag" },
  { action: "Move an annotation", gesture: "Drag it" },
  { action: "Draw through an annotation", gesture: "Alt-drag" },
  { action: "Add to the selection", gesture: "Shift-click" },
  { action: "Constrain to square or 15°", gesture: "Shift-drag" },
  { action: "Lock a move to one axis", gesture: "Shift-drag" },
  { action: "Edit text again", gesture: "Double-click" },
];

/** Things worth saying that are neither a key nor a gesture. */
const NOTES: string[] = [
  "Saved captures stay editable — reopen one in Shotly and the markup is still movable.",
  "Export (⌘E) writes a plain flattened PNG, about half the size, for sharing and pasting.",
];

/**
 * The full keymap, generated from the same command list that binds the keys —
 * so it can't fall out of date with what the app actually does.
 */
export function ShortcutSheet({
  commands,
  onEditHotkeys,
  onClose,
}: {
  commands: Command[];
  onEditHotkeys: () => void;
  onClose: () => void;
}) {
  const groups = ORDER.map((group) => ({
    group,
    items: commands.filter((c) => c.group === group && c.shortcut && !c.hidden),
  })).filter((g) => g.items.length > 0);

  return (
    <div
      className="animate-in-fade fixed inset-0 z-[8000] flex items-center justify-center bg-black/50 p-8"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="surface-pop animate-in-pop flex max-h-full w-[min(760px,95vw)] flex-col overflow-hidden rounded-2xl"
        role="dialog"
        aria-label="Keyboard shortcuts"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-white/8 px-4 py-3">
          <h2 className="text-[14px] font-semibold">Keyboard shortcuts</h2>
          <IconButton icon={<IconClose />} label="Close" onClick={onClose} bare />
        </div>

        <div className="grid grid-cols-1 gap-x-8 gap-y-5 overflow-y-auto p-4 sm:grid-cols-2">
          {/* First, because these are the only ones that are the user's to
              change — and the only ones another app can quietly steal. Changed
              in Settings, not here: this sheet is a reference, and a panel you
              can type into is a poor thing to read a keymap off. */}
          <SystemWide onEdit={onEditHotkeys} />

          {groups.map(({ group, items }) => (
            <section key={group}>
              <h3 className="mb-1.5 text-[11px] font-semibold tracking-wider text-ink-4 uppercase">
                {group}
              </h3>
              <dl className="space-y-0.5">
                {items.map((cmd) => (
                  <div
                    key={cmd.id}
                    className="flex items-center justify-between gap-4 rounded-md px-1.5 py-1 hover:bg-white/[0.04]"
                  >
                    <dt className="truncate text-[12.5px] text-ink-2">{cmd.title}</dt>
                    <dd className="flex shrink-0 gap-1">
                      <Kbd shortcut={cmd.shortcut!} />
                      {cmd.altShortcut && <Kbd shortcut={cmd.altShortcut} muted />}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}

          <section>
            <h3 className="mb-1.5 text-[11px] font-semibold tracking-wider text-ink-4 uppercase">
              Mouse
            </h3>
            <dl className="space-y-0.5">
              {GESTURES.map(({ action, gesture }) => (
                <div
                  key={action}
                  className="flex items-center justify-between gap-4 rounded-md px-1.5 py-1 hover:bg-white/[0.04]"
                >
                  <dt className="truncate text-[12.5px] text-ink-2">{action}</dt>
                  <dd className="shrink-0 text-[11.5px] text-ink-4">{gesture}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="sm:col-span-2">
            <ul className="space-y-1 border-t border-white/8 pt-3">
              {NOTES.map((note) => (
                <li key={note} className="text-[11.5px] text-ink-4">
                  {note}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * The hotkeys that work with any app in front, as they stand right now.
 *
 * Read from Rust rather than from the command list: these are the user's to
 * change, so nothing hard-coded here could stay true.
 */
function SystemWide({ onEdit }: { onEdit: () => void }) {
  const [bindings, setBindings] = useState<HotkeyBinding[] | null>(null);

  useEffect(() => {
    void ipc.hotkeysList().then(setBindings).catch(() => setBindings([]));
  }, []);

  if (!bindings) return null;

  return (
    <section className="sm:col-span-2">
      <div className="mb-1.5 flex items-baseline justify-between gap-4">
        <h3 className="text-[11px] font-semibold tracking-wider text-ink-4 uppercase">
          System-wide
        </h3>
        <button type="button" onClick={onEdit} className="text-[11px] text-ink-4 hover:text-ink-2">
          Change these…
        </button>
      </div>

      <dl className="grid gap-x-8 gap-y-0.5 sm:grid-cols-2">
        {bindings.map((b) => (
          <div
            key={b.action}
            className="flex items-center justify-between gap-4 rounded-md px-1.5 py-1 hover:bg-white/[0.04]"
          >
            <dt className="truncate text-[12.5px] text-ink-2">{b.label}</dt>
            <dd className="shrink-0">
              {b.accelerator ? (
                <Kbd shortcut={b.accelerator} />
              ) : (
                <span className="text-[11px] text-ink-4">Off</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
