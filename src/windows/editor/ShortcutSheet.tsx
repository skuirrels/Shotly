import { Kbd } from "@/components/ui/Kbd";
import { IconClose } from "@/components/icons";
import { IconButton } from "@/components/ui/IconButton";
import type { Command, CommandGroup } from "@/lib/keys/types";
import { GlobalHotkeys } from "./GlobalHotkeys";

const ORDER: CommandGroup[] = ["Tools", "Edit", "Style", "Arrange", "View", "Capture", "Export"];

/**
 * Pointer gestures, which have no command to generate them from.
 *
 * Alt-drag especially earns its place here: it is the only way to draw inside
 * a shape that already covers the area, and nothing on screen hints at it.
 */
const GESTURES: { action: string; gesture: string }[] = [
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
export function ShortcutSheet({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
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
              change — and the only ones another app can quietly steal. */}
          <GlobalHotkeys />

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
