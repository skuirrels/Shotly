import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import clsx from "clsx";
import { Kbd } from "@/components/ui/Kbd";
import * as ipc from "@/lib/ipc";
import type { HotkeyAction, HotkeyBinding } from "@/lib/types";

/**
 * The hotkeys that work with any app in front, and the means to change them.
 *
 * Worth being editable in a way the in-app keys are not: these compete with
 * every other program on the machine, and macOS lets a combination be claimed
 * twice without telling anybody. Registration succeeds, the key silently goes
 * to whoever is listening closer to the hardware, and Shotly looks broken.
 *
 * Which is why each row lights up when its key arrives. A conflict cannot be
 * detected, but it can be *shown*: press the combination, and either the row
 * flashes or it does not.
 */

/** The accelerator token for a physical key, in a spelling Rust also takes. */
function tokenFor(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;

  const named: Record<string, string> = {
    Escape: "Escape",
    Enter: "Enter",
    Tab: "Tab",
    Space: "Space",
    Backspace: "Backspace",
    Delete: "Delete",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    // Punctuation goes over as its symbol: both the accelerator parser and
    // the keycap formatter know these, where "Comma" would render literally.
    Comma: ",",
    Period: ".",
    Slash: "/",
    Semicolon: ";",
    Quote: "'",
    Backslash: "\\",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
  };
  return named[code] ?? null;
}

/** What the user just pressed, or why it will not do. */
type Recorded =
  | { kind: "accelerator"; value: string }
  | { kind: "clear" }
  | { kind: "cancel" }
  | { kind: "ignore" }
  | { kind: "rejected"; why: string };

function record(e: KeyboardEvent): Recorded {
  // Held on its own, a modifier is the first half of a combination that has
  // not arrived yet — not something to bind or to complain about.
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return { kind: "ignore" };

  const bare = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
  if (bare && e.code === "Escape") return { kind: "cancel" };
  if (bare && (e.code === "Backspace" || e.code === "Delete")) return { kind: "clear" };

  const token = tokenFor(e.code);
  if (!token) return { kind: "rejected", why: "That key can't be part of a global shortcut." };

  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Command");

  // A hotkey with no modifier fires wherever you are, including mid-sentence
  // in another app. The function keys are the exception: they have no letter
  // to get in the way of.
  if (mods.length === 0 && !/^F\d/.test(token)) {
    return { kind: "rejected", why: "Add ⌘, ⌃, ⌥ or ⇧ — a bare key would fire while you type." };
  }

  return { kind: "accelerator", value: [...mods, token].join("+") };
}

/**
 * `onRecording` says when a row is listening for a combination. The dialog
 * around this needs to know: while a row is recording, Escape means "stop
 * recording" and must not also be read as "close the dialog".
 */
export function GlobalHotkeys({ onRecording }: { onRecording?: (active: boolean) => void }) {
  const [bindings, setBindings] = useState<HotkeyBinding[] | null>(null);
  const [recording, setRecording] = useState<HotkeyAction | null>(null);
  const [error, setError] = useState<{ action: HotkeyAction; message: string } | null>(null);
  /** The row whose key has just been pressed, for the flash. */
  const [fired, setFired] = useState<HotkeyAction | null>(null);

  const refresh = useCallback(
    () => void ipc.hotkeysList().then(setBindings).catch(() => setBindings([])),
    [],
  );

  useEffect(refresh, [refresh]);

  useEffect(() => {
    onRecording?.(recording !== null);
    // Recording cannot outlive this list: an unmount mid-record has to hand
    // the key back, or Escape stays swallowed with nothing listening for it.
    return () => onRecording?.(false);
  }, [recording, onRecording]);

  // Rust says so on every hotkey it receives, whichever window has focus.
  useEffect(() => {
    const timer = { current: 0 };
    const unlisten = listen<HotkeyAction>("hotkey:fired", (event) => {
      setFired(event.payload);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setFired(null), 900);
    });
    return () => {
      window.clearTimeout(timer.current);
      void unlisten.then((fn) => fn());
    };
  }, []);

  const apply = useCallback(
    (action: HotkeyAction, accelerator: string | null) => {
      setRecording(null);
      setError(null);
      ipc
        .hotkeysSet(action, accelerator)
        .then(refresh)
        .catch((err: unknown) => setError({ action, message: String(err) }));
    },
    [refresh],
  );

  // On the capture phase and on the window, so the combination being recorded
  // cannot be swallowed on its way here by something that wants the same keys.
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const result = record(e);
      if (result.kind === "ignore") return;
      e.preventDefault();
      e.stopPropagation();

      switch (result.kind) {
        case "cancel":
          setRecording(null);
          setError(null);
          break;
        case "clear":
          applyRef.current(recording, null);
          break;
        case "rejected":
          setError({ action: recording, message: result.why });
          break;
        case "accelerator":
          applyRef.current(recording, result.value);
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [recording]);

  if (!bindings) return null;

  return (
    <section>
      <div className="mb-1.5 flex items-baseline justify-between gap-4">
        <h3 className="text-[11px] font-semibold tracking-wider text-ink-4 uppercase">
          System-wide
        </h3>
        <button
          type="button"
          onClick={() => {
            setError(null);
            void ipc.hotkeysReset().then(refresh);
          }}
          className="text-[11px] text-ink-4 hover:text-ink-2"
        >
          Reset all
        </button>
      </div>

      <p className="mb-2 text-[11.5px] text-ink-4">
        These work while you are in any app. Press one to check it arrives — the row lights up.
        macOS lets another program claim the same combination without telling anyone, so a key
        that never lights up is being taken before Shotly sees it. Pick a different one.
      </p>

      <dl className="space-y-0.5">
        {bindings.map((b) => {
          const isRecording = recording === b.action;
          const rowError = error?.action === b.action ? error.message : null;
          return (
            <div
              key={b.action}
              className={clsx(
                "flex items-center justify-between gap-4 rounded-md px-1.5 py-1 transition-colors duration-150",
                fired === b.action ? "bg-accent/20" : "hover:bg-white/[0.04]",
              )}
            >
              <dt className="min-w-0">
                <div className="truncate text-[12.5px] text-ink-2">{b.label}</div>
                <div className="truncate text-[11px] text-ink-4">
                  {rowError ?? (isRecording ? "Press a combination · ⌫ to turn off · esc to cancel" : b.hint)}
                </div>
              </dt>
              <dd className="flex shrink-0 items-center gap-1.5">
                {b.accelerator !== b.defaultAccelerator && !isRecording && (
                  <button
                    type="button"
                    onClick={() => apply(b.action, b.defaultAccelerator)}
                    title={`Back to ${b.defaultAccelerator}`}
                    className="text-[11px] text-ink-4 hover:text-ink-2"
                  >
                    Reset
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setRecording(isRecording ? null : b.action);
                  }}
                  className={clsx(
                    "min-w-[74px] rounded-md border px-1.5 py-1 text-center transition-colors",
                    isRecording
                      ? "border-accent bg-accent/15 text-accent"
                      : "border-transparent hover:border-white/10 hover:bg-white/[0.05]",
                    rowError && !isRecording && "border-danger/50",
                  )}
                >
                  {isRecording ? (
                    <span className="text-[11px]">Listening…</span>
                  ) : b.accelerator ? (
                    <Kbd shortcut={b.accelerator} />
                  ) : (
                    <span className="text-[11px] text-ink-4">Off</span>
                  )}
                </button>
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
