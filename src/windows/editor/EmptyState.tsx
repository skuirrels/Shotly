import { useEffect, useState } from "react";
import { IconCamera } from "@/components/icons";
import { Kbd } from "@/components/ui/Kbd";
import * as ipc from "@/lib/ipc";

/**
 * Shown above the library when macOS hasn't granted Screen Recording.
 *
 * Separate from the empty-library hero because the two are unrelated: a full
 * library with no permission still needs this, and an empty one with
 * permission doesn't.
 */
export function PermissionNotice() {
  const [granted, setGranted] = useState<boolean | null>(null);

  useEffect(() => {
    void ipc.capturePermissionStatus().then(setGranted);

    // The user may grant permission in System Settings while this window is
    // open, so re-check whenever they come back to it.
    const recheck = () => void ipc.capturePermissionStatus().then(setGranted);
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, []);

  if (granted !== false) return null;

  return (
    <div className="mb-5 rounded-xl border border-warn/25 bg-warn/8 p-3.5 text-center">
      <p className="text-[12.5px] text-ink-2">
        macOS needs <strong className="text-ink">Screen Recording</strong> permission before Shotly
        can capture anything. Add <strong className="text-ink">Shotly</strong> in Settings, then
        relaunch.
      </p>
      {/* macOS caches this process's answer, so granting while Shotly runs has
          no effect until it restarts. Say so, and offer the restart. */}
      <p className="mt-1.5 text-[11.5px] text-ink-4">
        Already granted it? macOS won't apply the change to a running app.
      </p>
      <div className="mt-2.5 flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => void ipc.openScreenRecordingSettings()}
          className="rounded-lg bg-white/[0.08] px-2.5 py-1.5 text-[12px] font-medium text-ink hover:bg-white/[0.13]"
        >
          Open System Settings
        </button>
        <button
          type="button"
          onClick={() => void ipc.restartApp()}
          className="rounded-lg bg-accent px-2.5 py-1.5 text-[12px] font-semibold text-accent-fg hover:bg-accent-hi"
        >
          Relaunch Shotly
        </button>
      </div>
    </div>
  );
}

/**
 * What fills the library before anything has been captured.
 *
 * The capture modes themselves live in the toolbar now, so this points at them
 * rather than repeating them — one place to start a capture, not two that can
 * drift apart.
 */
export function EmptyLibrary() {
  const [library, setLibrary] = useState<string | null>(null);

  useEffect(() => {
    void ipc.saveLibraryPath().then(setLibrary);
  }, []);

  return (
    <div className="flex flex-col items-center px-8 py-16 text-center">
      <div className="mb-4 grid size-14 place-items-center rounded-2xl bg-accent/12 text-accent">
        <IconCamera className="size-7" width={28} height={28} />
      </div>

      <h1 className="text-[17px] font-semibold">Nothing captured yet</h1>
      <p className="mt-1 max-w-[380px] text-[13px] text-ink-3">
        Use <strong className="font-medium text-ink-2">Capture</strong> in the toolbar. Shotly stays
        in your menu bar, and the hotkeys work from any app.
      </p>

      <div className="mt-6 flex flex-col items-center gap-2">
        <p className="flex items-center gap-1.5 text-[12px] text-ink-4">
          Press <Kbd shortcut="Mod+/" muted /> for all shortcuts
          <span className="mx-1">·</span>
          <Kbd shortcut="Mod+K" muted /> for commands
        </p>
        <p className="flex items-center gap-1.5 text-[12px] text-ink-4">
          <Kbd shortcut="Mod+S" muted /> saves to
          <button
            type="button"
            onClick={() => library && void ipc.revealInFinder(library)}
            className="font-mono text-[11.5px] text-ink-3 underline decoration-dotted underline-offset-2 hover:text-ink"
          >
            Documents/Shotly
          </button>
        </p>
      </div>
    </div>
  );
}
