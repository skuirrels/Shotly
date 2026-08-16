import { IconClose, IconCopy } from "@/components/icons";
import { IconButton } from "@/components/ui/IconButton";
import type { TextLine } from "@/lib/types";

/**
 * What the text recogniser found, already on the clipboard.
 *
 * Shown rather than only copied, for two reasons: recognition is a guess, and
 * a guess you cannot see is one you have to paste somewhere to check — and
 * half the time only one line of it was wanted anyway.
 */

/** Below this, Vision is telling us it had trouble. Worth flagging. */
const SHAKY = 0.5;

export function TextResult({
  lines,
  onCopy,
  onClose,
}: {
  lines: TextLine[];
  onCopy: (text: string) => void;
  onClose: () => void;
}) {
  const all = lines.map((l) => l.text).join("\n");

  return (
    <div
      className="animate-in-fade fixed inset-0 z-[8000] flex items-center justify-center bg-black/50 p-8"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="surface-pop animate-in-pop flex max-h-full w-[min(560px,95vw)] flex-col overflow-hidden rounded-2xl"
        role="dialog"
        aria-label="Recognised text"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-white/8 px-4 py-3">
          <h2 className="text-[14px] font-semibold">
            {lines.length === 0
              ? "No text found"
              : `${lines.length} ${lines.length === 1 ? "line" : "lines"} · copied`}
          </h2>
          <IconButton icon={<IconClose />} label="Close" onClick={onClose} bare />
        </div>

        {lines.length === 0 ? (
          <p className="px-4 py-6 text-center text-[12.5px] text-ink-3">
            Nothing in that area was readable as text.
          </p>
        ) : (
          <>
            <div className="overflow-y-auto px-2 py-2">
              {lines.map((line, i) => (
                <button
                  key={`${i}-${line.text}`}
                  type="button"
                  onClick={() => onCopy(line.text)}
                  title="Copy just this line"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-white/[0.06]"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-2">
                    {line.text}
                  </span>
                  {line.confidence < SHAKY && (
                    <span
                      className="shrink-0 text-[10.5px] text-ink-4"
                      title="The recogniser was unsure about this line"
                    >
                      unsure
                    </span>
                  )}
                </button>
              ))}
            </div>

            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-white/8 px-4 py-2.5">
              <span className="text-[11px] text-ink-4">Click a line to copy it on its own.</span>
              <button
                type="button"
                onClick={() => onCopy(all)}
                className="flex items-center gap-1.5 rounded-lg bg-white/[0.07] px-2.5 py-1.5 text-[12.5px] font-medium text-ink hover:bg-white/[0.12]"
              >
                <IconCopy />
                Copy all
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
