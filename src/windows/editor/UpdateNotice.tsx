import { IconClose, IconRefresh, IconSparkle } from "@/components/icons";
import { relaunch, type UpdateStatus } from "@/lib/updater";

interface Props {
  status: UpdateStatus | null;
  onCheck: () => void;
  onDismiss: () => void;
}

/**
 * The release notes, as the changelog wrote them.
 *
 * Markdown bullets arrive as text; the dashes are stripped and the lines laid
 * out as a list, because rendering markdown for three lines of prose would
 * cost more than it could possibly be worth. Long entries scroll rather than
 * pushing the Relaunch button off the notice.
 */
function Changes({ notes }: { notes: string | null }) {
  // A bullet in the changelog is wrapped across as many lines as it takes, so
  // the lines have to be put back together: splitting on newlines alone turned
  // one sentence into four bullets, each starting mid-clause.
  const lines: string[] = [];
  for (const raw of (notes ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[-*]\s+/.test(line) || lines.length === 0) {
      lines.push(line.replace(/^[-*]\s+/, ""));
    } else {
      lines[lines.length - 1] += ` ${line}`;
    }
  }

  if (lines.length === 0) return null;

  return (
    <ul className="mt-2 max-h-24 space-y-1 overflow-y-auto pr-1">
      {lines.map((line) => (
        <li key={line} className="flex gap-1.5 text-[11.5px] leading-snug text-ink-2">
          <span className="text-ink-4">·</span>
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}

function percent(received: number, total: number | null): number | null {
  if (!total || total <= 0) return null;
  return Math.min(100, Math.round((received / total) * 100));
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * The update notice.
 *
 * Bottom-right rather than the toast's bottom-centre, because the two can be
 * on screen together — a save confirmation should not shove an update out of
 * the way, or vice versa. Sits above the canvas but below the modals.
 */
export function UpdateNotice({ status, onCheck, onDismiss }: Props) {
  if (!status) return null;

  return (
    <div
      className="surface-pop animate-in-pop fixed right-5 bottom-5 z-[9400] flex max-w-[340px] items-start gap-2.5 rounded-xl px-3.5 py-3"
      role="status"
    >
      <Body status={status} onCheck={onCheck} />

      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="-mt-0.5 -mr-1 shrink-0 rounded-md p-1 text-ink-4 hover:bg-white/[0.08] hover:text-ink-2"
      >
        <IconClose />
      </button>
    </div>
  );
}

function Body({ status, onCheck }: { status: UpdateStatus; onCheck: () => void }) {
  switch (status.state) {
    case "checking":
      return (
        <p className="flex-1 pt-px text-[12.5px] text-ink-2">Checking for updates…</p>
      );

    case "upToDate":
      return (
        <p className="flex-1 pt-px text-[12.5px] text-ink-2">Shotly is up to date.</p>
      );

    case "downloading": {
      const pct = percent(status.received, status.total);
      return (
        <div className="flex-1">
          <p className="text-[12.5px] text-ink">
            Downloading Shotly {status.version}
            {pct !== null && <span className="text-ink-3"> · {pct}%</span>}
          </p>
          {/* A determinate bar when the server sent a length, a byte count
              when it didn't — a bar stuck at zero is worse than no bar. */}
          {pct !== null ? (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.08]">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-200"
                style={{ width: `${pct}%` }}
              />
            </div>
          ) : (
            <p className="mt-1 text-[11.5px] tabular-nums text-ink-3">
              {megabytes(status.received)}
            </p>
          )}
        </div>
      );
    }

    case "ready":
      return (
        <>
          <IconSparkle className="mt-px shrink-0 text-accent" />
          <div className="flex-1">
            <p className="text-[12.5px] font-medium text-ink">
              Shotly {status.version} is installed
            </p>
            <p className="mt-0.5 text-[11.5px] text-ink-3">
              It takes effect the next time Shotly starts.
            </p>
            {/* What actually changed, straight from the release's changelog
                entry. An update that says only "a new version is installed"
                gives nobody a reason to relaunch. */}
            <Changes notes={status.notes} />
            <button
              type="button"
              onClick={() => void relaunch()}
              className="mt-2 rounded-md bg-accent px-2.5 py-1 text-[11.5px] font-semibold text-accent-fg hover:bg-accent-hi"
            >
              Relaunch now
            </button>
          </div>
        </>
      );

    case "failed":
      return (
        <div className="flex-1">
          <p className="text-[12.5px] font-medium text-danger">Update failed</p>
          <p className="mt-0.5 max-h-16 overflow-y-auto text-[11.5px] break-words text-ink-3">
            {status.message}
          </p>
          <button
            type="button"
            onClick={onCheck}
            className="mt-2 flex items-center gap-1.5 rounded-md bg-white/[0.08] px-2.5 py-1 text-[11.5px] text-ink-2 hover:bg-white/[0.14] hover:text-ink"
          >
            <IconRefresh className="h-3.5 w-3.5" />
            Try again
          </button>
        </div>
      );
  }
}
