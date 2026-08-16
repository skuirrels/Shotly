import { openUrl } from "@tauri-apps/plugin-opener";
import { IconClose, IconCopy, IconLink } from "@/components/icons";
import { IconButton } from "@/components/ui/IconButton";
import type { CodePayload, Scan, TextLine } from "@/lib/types";

/**
 * What one look at the pixels turned up, already on the clipboard.
 *
 * Shown rather than only copied, for two reasons: recognition is a guess, and
 * a guess you cannot see is one you have to paste somewhere to check — and
 * half the time only one line of it was wanted anyway.
 *
 * Codes come first when there are any. Someone who has just dragged a box
 * around a QR code wants the link, and would have to scroll past a page of
 * incidentally-recognised text to reach it.
 */

/** Below this, Vision is telling us it had trouble. Worth flagging. */
const SHAKY = 0.5;

/**
 * Whether a scanned payload is safe to hand to the browser on one click.
 *
 * Only http and https. The payload came out of a picture rather than from the
 * user, so a `javascript:` or `file:` URL in a QR code is a plausible thing to
 * find there and not a thing to make one click away from running. Those still
 * show, and can still be copied — they simply don't get an Open button.
 */
function asWebUrl(payload: string): string | null {
  try {
    const url = new URL(payload.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** What the header should say about what came back. */
function summarise({ lines, codes }: Scan): string {
  if (lines.length === 0 && codes.length === 0) return "Nothing found";
  const parts: string[] = [];
  if (codes.length > 0) {
    parts.push(`${codes.length} ${codes.length === 1 ? "code" : "codes"}`);
  }
  if (lines.length > 0) {
    parts.push(`${lines.length} ${lines.length === 1 ? "line" : "lines"}`);
  }
  return `${parts.join(" · ")} · copied`;
}

export function ScanResult({
  scan,
  onCopy,
  onClose,
}: {
  scan: Scan;
  onCopy: (text: string) => void;
  onClose: () => void;
}) {
  const { lines, codes } = scan;
  const allText = lines.map((l) => l.text).join("\n");
  const empty = lines.length === 0 && codes.length === 0;

  return (
    <div
      className="animate-in-fade fixed inset-0 z-[8000] flex items-center justify-center bg-black/50 p-8"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="surface-pop animate-in-pop flex max-h-full w-[min(560px,95vw)] flex-col overflow-hidden rounded-2xl"
        role="dialog"
        aria-label="What was found"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-white/8 px-4 py-3">
          <h2 className="text-[14px] font-semibold">{summarise(scan)}</h2>
          <IconButton icon={<IconClose />} label="Close" onClick={onClose} bare />
        </div>

        {empty ? (
          <p className="px-4 py-6 text-center text-[12.5px] text-ink-3">
            Nothing in that area was readable as text or as a code.
          </p>
        ) : (
          <>
            <div className="overflow-y-auto px-2 py-2">
              {codes.map((code, i) => (
                <CodeRow key={`${i}-${code.payload}`} code={code} onCopy={onCopy} />
              ))}

              {codes.length > 0 && lines.length > 0 && (
                <div className="mt-2 mb-1 px-2 text-[10.5px] font-semibold tracking-wider text-ink-4 uppercase">
                  Text
                </div>
              )}

              {lines.map((line, i) => (
                <LineRow key={`${i}-${line.text}`} line={line} onCopy={onCopy} />
              ))}
            </div>

            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-white/8 px-4 py-2.5">
              <span className="text-[11px] text-ink-4">
                Click a {codes.length > 0 && lines.length === 0 ? "code" : "line"} to copy it on its
                own.
              </span>
              {lines.length > 0 && (
                <button
                  type="button"
                  onClick={() => onCopy(allText)}
                  className="flex items-center gap-1.5 rounded-lg bg-white/[0.07] px-2.5 py-1.5 text-[12.5px] font-medium text-ink hover:bg-white/[0.12]"
                >
                  <IconCopy />
                  Copy all text
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One code: what it says, what kind it is, and — for a web link — a way there.
 *
 * The whole payload is shown rather than a shortened form. This is a link that
 * arrived in a picture, and the one thing worth knowing before following it is
 * exactly where it goes.
 */
function CodeRow({ code, onCopy }: { code: CodePayload; onCopy: (text: string) => void }) {
  const url = asWebUrl(code.payload);

  return (
    <div className="mb-1 rounded-lg bg-accent/10 px-2.5 py-2 shadow-[inset_0_0_0_1px_var(--color-accent)]">
      <div className="mb-1 flex items-center gap-2">
        <span className="rounded bg-accent/20 px-1.5 py-px text-[9.5px] font-semibold tracking-wide text-accent uppercase">
          {code.symbology}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => onCopy(code.payload)}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-2 hover:bg-white/[0.08] hover:text-ink"
        >
          <IconCopy />
          Copy
        </button>
        {url && (
          <button
            type="button"
            onClick={() => void openUrl(url)}
            title={`Open ${url}`}
            className="flex items-center gap-1 rounded-md bg-white/[0.07] px-1.5 py-0.5 text-[11px] font-medium text-ink hover:bg-white/[0.12]"
          >
            <IconLink />
            Open
          </button>
        )}
      </div>
      <p className="font-mono text-[12px] break-all text-ink">{code.payload}</p>
    </div>
  );
}

function LineRow({ line, onCopy }: { line: TextLine; onCopy: (text: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onCopy(line.text)}
      title="Copy just this line"
      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-white/[0.06]"
    >
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-2">{line.text}</span>
      {line.confidence < SHAKY && (
        <span
          className="shrink-0 text-[10.5px] text-ink-4"
          title="The recogniser was unsure about this line"
        >
          unsure
        </span>
      )}
    </button>
  );
}
