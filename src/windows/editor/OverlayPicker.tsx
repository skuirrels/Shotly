import { useEffect, useState } from "react";
import { IconOverlay } from "@/components/icons";
import { IconButton } from "@/components/ui/IconButton";
import { Kbd } from "@/components/ui/Kbd";
import { Popover } from "@/components/ui/Popover";
import * as ipc from "@/lib/ipc";
import { type OverlaySource, overlayFromClipboard, overlayFromLibrary } from "@/lib/overlay";
import type { LibraryItem } from "@/lib/types";
import { useEditor } from "@/state/editorStore";
import { useThumbnail } from "./thumbnails";

/**
 * Where an overlay comes from: the clipboard, or another capture.
 *
 * One panel for both because they answer the same question — "which picture
 * goes on top?" — and the clipboard alone would have hidden the library behind
 * a round trip through some other app.
 */
interface Props {
  /** The capture being edited, which is not worth offering as its own overlay. */
  currentPath?: string;
  onNotify: (text: string) => void;
}

/** Enough to reach for without turning the panel into a second library. */
const SHOWN = 24;

export function OverlayPicker({ currentPath, onNotify }: Props) {
  return (
    <Popover
      align="center"
      trigger={({ open, toggle }) => (
        <IconButton
          icon={<IconOverlay />}
          label="Overlay an image"
          shortcut="Mod+V"
          active={open}
          tooltipSide="top"
          onClick={toggle}
        />
      )}
    >
      {({ close }) => <Panel currentPath={currentPath} onNotify={onNotify} close={close} />}
    </Popover>
  );
}

function Panel({ currentPath, onNotify, close }: Props & { close: () => void }) {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [busy, setBusy] = useState(false);

  // Read the library when the panel opens rather than when the editor loads:
  // most sessions never reach for this.
  useEffect(() => {
    let cancelled = false;
    void ipc
      .listLibrary()
      .then((next) => !cancelled && setItems(next))
      .catch(() => !cancelled && setItems([]));
    return () => {
      cancelled = true;
    };
  }, []);

  /** Both sources funnel through here so failures read the same either way. */
  const insert = async (load: () => Promise<OverlaySource | null>) => {
    setBusy(true);
    try {
      const source = await load();
      if (!source) {
        onNotify("No image on the clipboard");
        return;
      }
      useEditor.getState().addOverlay(source);
      close();
    } catch (e) {
      onNotify(`Could not place that image: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const candidates = (items ?? []).filter((i) => i.path !== currentPath).slice(0, SHOWN);

  return (
    <div className="w-[292px] p-1" aria-busy={busy}>
      <button
        type="button"
        disabled={busy}
        onClick={() => void insert(overlayFromClipboard)}
        className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left hover:bg-hover disabled:opacity-50"
      >
        <span className="text-[12.5px] font-medium text-ink">Paste from clipboard</span>
        <Kbd shortcut="Mod+V" muted />
      </button>

      <p className="px-2 pt-1.5 pb-1 text-[11px] font-semibold tracking-wider text-ink-4 uppercase">
        From library
      </p>

      {items === null ? (
        <p className="px-2 py-3 text-[11px] text-ink-4">Reading the library…</p>
      ) : candidates.length === 0 ? (
        <p className="px-2 py-3 text-[11px] text-ink-4">No other captures yet.</p>
      ) : (
        <div className="grid max-h-[232px] grid-cols-3 gap-1 overflow-y-auto p-1">
          {candidates.map((item) => (
            <Candidate
              key={item.path}
              item={item}
              disabled={busy}
              onChoose={() => void insert(() => overlayFromLibrary(item.path))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Candidate({
  item,
  disabled,
  onChoose,
}: {
  item: LibraryItem;
  disabled: boolean;
  onChoose: () => void;
}) {
  const { url, failed } = useThumbnail(item.path, item.modified, item.cloud);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onChoose}
      title={item.name}
      className="grid h-[62px] place-items-center overflow-hidden rounded-md border border-line bg-inset hover:border-accent/60 disabled:opacity-50"
    >
      {url && !failed ? (
        <img src={url} alt="" draggable={false} className="max-h-full max-w-full object-contain" />
      ) : (
        <span className="text-[10px] text-ink-4">{failed ? "Unreadable" : ""}</span>
      )}
    </button>
  );
}
