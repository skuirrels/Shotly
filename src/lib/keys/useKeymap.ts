import { useEffect, useMemo, useRef } from "react";
import { isEditingText, matchesChord, parseShortcut } from "./keys";
import type { Command } from "./types";

/**
 * Bind a command list to the window.
 *
 * Registration order is precedence order: the first command whose chord matches
 * wins, so a modal can pass a short list that shadows the global map.
 */
export function useKeymap(commands: Command[], active = true) {
  // Keep the handler stable while still seeing the latest closures, so we don't
  // detach and reattach the listener on every store update.
  const ref = useRef(commands);
  ref.current = commands;

  const bindings = useMemo(
    () =>
      commands.flatMap((cmd) =>
        [cmd.shortcut, cmd.altShortcut]
          .filter((s): s is string => Boolean(s))
          .map((spec) => ({ id: cmd.id, chord: parseShortcut(spec) })),
      ),
    // Rebuild only when the set of shortcuts actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commands.map((c) => `${c.id}:${c.shortcut}:${c.altShortcut}`).join("|")],
  );

  useEffect(() => {
    if (!active) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;

      const typing = isEditingText(e.target);

      for (const binding of bindings) {
        if (!matchesChord(e, binding.chord)) continue;

        const cmd = ref.current.find((c) => c.id === binding.id);
        if (!cmd) continue;
        if (typing && !cmd.allowWhileTyping) continue;
        // A disabled command yields its chord to whatever is registered next,
        // so e.g. ⏎ can apply a pending crop but otherwise stay available.
        if (cmd.enabled && !cmd.enabled()) continue;

        e.preventDefault();
        e.stopPropagation();
        cmd.run();
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [bindings, active]);
}
