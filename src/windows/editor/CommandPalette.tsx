import { useEffect, useMemo, useRef, useState } from "react";
import { Kbd } from "@/components/ui/Kbd";
import type { Command } from "@/lib/keys/types";

interface Props {
  commands: Command[];
  onClose: () => void;
}

/**
 * Subsequence match with a light score.
 *
 * Consecutive hits and word-start hits rank higher, so typing "sf" finds
 * "Send to Front" ahead of "Save File".
 */
function score(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  let qi = 0;
  let total = 0;
  let streak = 0;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) {
      streak = 0;
      continue;
    }
    streak += 1;
    total += streak;
    if (ti === 0 || t[ti - 1] === " ") total += 3;
    qi += 1;
  }

  return qi === q.length ? total : 0;
}

export function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  /** The search box, so focus can be insisted on rather than merely asked for. */
  const box = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const candidates = commands.filter((c) => !c.hidden && (!c.enabled || c.enabled()));
    return candidates
      .map((c) => ({ cmd: c, s: score(query, `${c.title} ${c.keywords ?? ""}`) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((r) => r.cmd);
  }, [commands, query]);

  // Any change to the result set invalidates the highlighted row.
  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  /**
   * Escape, from wherever the keyboard happens to be pointed.
   *
   * The rest of the palette's keys ride on the input, which is right while
   * anyone is typing into it — but Escape is the way out of a thing that has
   * gone wrong, and "the input lost focus" is one of the ways it goes wrong.
   * Bound to the window so it works when the input is not listening, and on
   * the capture phase so nothing underneath answers it first.
   */
  useEffect(() => {
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onEscape, { capture: true });
    return () => window.removeEventListener("keydown", onEscape, { capture: true });
  }, [onClose]);

  /**
   * And keep the keyboard pointed at it.
   *
   * `autoFocus` fires once, as the input is created, and loses races with
   * anything that moves focus in the same frame — the window coming forward,
   * a view swapping underneath. This asks again on the next frame, which is
   * the difference between a palette you can type into and one that only
   * looks open.
   */
  useEffect(() => {
    const at = requestAnimationFrame(() => box.current?.focus());
    return () => cancelAnimationFrame(at);
  }, []);

  const run = (cmd: Command | undefined) => {
    if (!cmd) return;
    onClose();
    // Let the palette unmount before the command runs, so anything that moves
    // focus isn't fighting the input we're about to tear down.
    requestAnimationFrame(() => cmd.run());
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(results[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="animate-in-fade fixed inset-0 z-[8000] flex justify-center bg-black/45 pt-[14vh]"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="surface-pop animate-in-pop flex h-fit max-h-[60vh] w-[min(560px,90vw)] flex-col overflow-hidden rounded-2xl"
        role="dialog"
        aria-label="Command palette"
      >
        <input
          ref={box}
          autoFocus
          value={query}
          placeholder="Search commands…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          className="h-13 shrink-0 border-b border-white/8 bg-transparent px-4 text-[15px] outline-none placeholder:text-ink-4"
        />

        <div ref={listRef} className="overflow-y-auto p-1.5">
          {results.length === 0 && (
            <p className="px-3 py-8 text-center text-[12.5px] text-ink-3">No matching commands</p>
          )}

          {results.map((cmd, i) => (
            <button
              key={cmd.id}
              data-index={i}
              type="button"
              onPointerEnter={() => setActive(i)}
              onClick={() => run(cmd)}
              className={[
                "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px]",
                i === active ? "bg-accent/16 text-ink" : "text-ink-2",
              ].join(" ")}
            >
              <span className="grid size-5 shrink-0 place-items-center text-ink-3">{cmd.icon}</span>
              <span className="flex-1 truncate">{cmd.title}</span>
              <span className="shrink-0 text-[11px] text-ink-4">{cmd.group}</span>
              {cmd.shortcut && <Kbd shortcut={cmd.shortcut} muted />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
