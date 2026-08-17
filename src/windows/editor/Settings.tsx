import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import clsx from "clsx";
import {
  IconCheck,
  IconClose,
  IconFolder,
  IconGear,
  IconKeyboard,
} from "@/components/icons";
import { IconButton } from "@/components/ui/IconButton";
import * as ipc from "@/lib/ipc";
import type { BackupSettings, BackupTarget } from "@/lib/types";
import { GlobalHotkeys } from "./GlobalHotkeys";

/**
 * Settings, in tabs.
 *
 * Hotkeys first, and first by some distance: they are the only part of Shotly
 * that can be broken by software the user installed months ago and has since
 * forgotten about, and the only fix is to come here and pick another
 * combination. Everything else in this dialog is set once and never revisited.
 *
 * Reachable from the app menu, the tray and ⌘, — see `request_settings` in
 * `src-tauri/src/commands.rs` for why the tray matters: the editor window
 * spends most of its life hidden, and a keyboard shortcut you cannot press is
 * a poor way to get at the screen for fixing keyboard shortcuts.
 */

export type SettingsTab = "hotkeys" | "backup";

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: "hotkeys", label: "Hotkeys", icon: <IconKeyboard /> },
  { id: "backup", label: "Backup", icon: <IconFolder /> },
];

export function Settings({
  tab: initialTab = "hotkeys",
  onClose,
}: {
  tab?: SettingsTab;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  /** True while a hotkey row is listening for a combination. */
  const [recording, setRecording] = useState(false);

  // Reopening on a different tab — from the tray, say, while the dialog is
  // already up — has to move to it, not sit on whatever was showing.
  useEffect(() => setTab(initialTab), [initialTab]);

  // Escape closes it — unless a hotkey row is listening, where Escape is the
  // way to abandon the recording. Asked of the list rather than inferred from
  // event order: both handlers are on the window, and which one sees the key
  // first is not something to hang a dialog's behaviour on.
  useEffect(() => {
    if (recording) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording, onClose]);

  return (
    <div
      className="animate-in-fade fixed inset-0 z-[8000] flex items-center justify-center bg-black/50 p-8"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="surface-pop animate-in-pop flex max-h-full w-[min(600px,95vw)] flex-col overflow-hidden rounded-2xl"
        role="dialog"
        aria-label="Settings"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-white/8 px-4 py-3">
          <h2 className="flex items-center gap-2 text-[14px] font-semibold">
            <IconGear className="text-ink-3" />
            Settings
          </h2>
          <IconButton icon={<IconClose />} label="Close" onClick={onClose} bare />
        </div>

        <div
          className="flex shrink-0 gap-1 border-b border-white/8 px-3 py-2"
          role="tablist"
          aria-label="Settings sections"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={clsx(
                "flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium transition-colors",
                tab === t.id
                  ? "bg-white/[0.1] text-ink"
                  : "text-ink-3 hover:bg-white/[0.05] hover:text-ink-2",
              )}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        <div className="overflow-y-auto p-4">
          {tab === "hotkeys" ? <Hotkeys onRecording={setRecording} /> : <Backup />}
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- hotkeys

function Hotkeys({ onRecording }: { onRecording: (active: boolean) => void }) {
  return (
    <>
      <GlobalHotkeys onRecording={onRecording} />

      <div className="mt-4 border-t border-white/8 pt-3">
        <p className="text-[11.5px] text-ink-4">
          macOS keeps ⌘⇧3, ⌘⇧4 and ⌘⇧5 for its own screenshot tools, so Shotly ships on ⌃⇧
          instead. To hand those keys over, switch them off in System Settings first — then they
          are free to record here.
        </p>
        <button
          type="button"
          onClick={() => void ipc.openKeyboardSettings()}
          className="mt-2 flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.06] px-2.5 text-[12.5px] text-ink-2 hover:bg-white/[0.1] hover:text-ink"
        >
          Open Keyboard Shortcuts…
        </button>
      </div>
    </>
  );
}

// --------------------------------------------------------------------- backup

/**
 * Backing up is a copy into a folder something else already syncs, rather than
 * an upload to anybody's API. See `src-tauri/src/backup.rs` for why that is the
 * right trade and what it costs.
 */
function Backup() {
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [targets, setTargets] = useState<BackupTarget[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);

  useEffect(() => {
    void ipc.backupSettings().then(setSettings);
    void ipc.backupTargets().then(setTargets);
  }, []);

  const configure = useCallback(async (enabled: boolean, destination: string | null) => {
    setNote(null);
    try {
      setSettings(await ipc.backupConfigure(enabled, destination));
    } catch (e) {
      setNote({ text: String(e), bad: true });
    }
  }, []);

  const runNow = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const report = await ipc.backupNow();
      const parts = [
        report.copied > 0 ? `${report.copied} copied` : null,
        report.skipped > 0 ? `${report.skipped} already there` : null,
        report.failed > 0 ? `${report.failed} failed` : null,
      ].filter(Boolean);
      setNote({
        text: parts.length > 0 ? parts.join(" · ") : "Nothing to copy",
        bad: report.failed > 0,
      });
    } catch (e) {
      setNote({ text: String(e), bad: true });
    } finally {
      setBusy(false);
    }
  }, []);

  const chooseFolder = useCallback(async () => {
    const picked = await openDialog({ directory: true, title: "Choose a backup folder" });
    if (typeof picked === "string") void configure(true, picked);
  }, [configure]);

  return (
    <>
      <h3 className="mb-1.5 text-[11px] font-semibold tracking-wider text-ink-4 uppercase">
        Backup
      </h3>
      <p className="mb-3 text-[11.5px] text-ink-4">
        Keep a second copy of every capture in a folder your cloud app already syncs. Shotly
        copies the file; Google Drive, Dropbox or iCloud does the uploading — so there is no
        account to connect and nothing of yours held anywhere by Shotly.
      </p>

      {settings === null ? null : (
        <>
          <div className="space-y-1">
            {targets.map((target) => (
              <Choice
                key={target.path}
                label={target.label}
                hint={target.path}
                chosen={settings.enabled && settings.destination === target.path}
                onClick={() =>
                  void configure(
                    // Clicking the folder already in use turns the backup
                    // off, which is the obvious meaning of clicking a tick.
                    !(settings.enabled && settings.destination === target.path),
                    target.path,
                  )
                }
              />
            ))}

            {targets.length === 0 && (
              <p className="rounded-lg bg-white/[0.04] px-3 py-2 text-[12px] text-ink-3">
                No cloud folders found. Install and sign in to Google Drive, Dropbox or
                OneDrive — or pick any folder below.
              </p>
            )}

            {/* A destination that isn't one of the detected ones — an
                external disk, a network share, or a cloud app that mounts
                itself somewhere unusual. */}
            {settings.destination && !targets.some((t) => t.path === settings.destination) && (
              <Choice
                label="Chosen folder"
                hint={settings.destination}
                chosen={settings.enabled}
                onClick={() => void configure(!settings.enabled, settings.destination)}
              />
            )}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void chooseFolder()}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.06] px-2.5 text-[12.5px] text-ink-2 hover:bg-white/[0.1] hover:text-ink"
            >
              <IconFolder />
              Choose folder…
            </button>

            <button
              type="button"
              onClick={() => void runNow()}
              disabled={!settings.destination || busy}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.07] px-2.5 text-[12.5px] font-medium text-ink hover:bg-white/[0.12] disabled:opacity-40"
            >
              {busy ? "Backing up…" : "Back up everything now"}
            </button>
          </div>

          {note && (
            <p className={clsx("mt-2.5 text-[11.5px]", note.bad ? "text-danger" : "text-ink-3")}>
              {note.text}
            </p>
          )}

          <p className="mt-3 border-t border-white/8 pt-2.5 text-[11px] text-ink-4">
            New captures are copied as they are saved. Nothing is ever deleted from the backup
            — trashing a capture in Shotly leaves the copy where it is.
          </p>
        </>
      )}
    </>
  );
}

function Choice({
  label,
  hint,
  chosen,
  onClick,
}: {
  label: string;
  hint: string;
  chosen: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors",
        chosen
          ? "bg-accent/15 shadow-[inset_0_0_0_1px_var(--color-accent)]"
          : "bg-white/[0.04] hover:bg-white/[0.07]",
      )}
    >
      <span
        className={clsx(
          "grid size-[18px] shrink-0 place-items-center rounded-full",
          chosen ? "bg-accent text-white" : "ring-1 ring-white/20 ring-inset",
        )}
      >
        {chosen && <IconCheck />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] text-ink">{label}</span>
        <span className="block truncate text-[11px] text-ink-4">{hint}</span>
      </span>
    </button>
  );
}
