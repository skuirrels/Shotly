import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Mirrors `Status` in `src-tauri/src/update.rs`.
 *
 * Rust owns the update cycle — it runs on a schedule whether or not this
 * window exists — so everything here is a read of state that lives over there.
 */
export type UpdateStatus =
  | { state: "checking" }
  | { state: "upToDate" }
  | { state: "downloading"; version: string; received: number; total: number | null }
  | { state: "ready"; version: string; notes: string | null }
  | { state: "failed"; message: string };

const EVENT = "update:status";

/** Ask Rust to check now. Results arrive over the event, not the promise. */
export const checkForUpdates = () => invoke<void>("check_for_updates");

/** Whatever the background schedule concluded while this window was away. */
const pendingUpdate = () => invoke<UpdateStatus | null>("pending_update");

export { relaunch };

/**
 * Subscribe to the update cycle.
 *
 * `dismiss` is deliberately local and unpersisted: it clears the notice for
 * this sitting, and the next scheduled check brings it back if the update is
 * still waiting. An update you have to be told about exactly once, and can
 * then silently forget, is how machines end up running last year's build.
 */
export function useUpdates() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    // The scheduled check almost always lands while the editor is hidden in
    // the menu bar, so the live event is only half the story.
    void pendingUpdate().then((s) => s && setStatus((prev) => prev ?? s));

    const pending = listen<UpdateStatus>(EVENT, (e) => setStatus(e.payload));
    return () => {
      void pending.then((fn) => fn());
    };
  }, []);

  // "Up to date" has a short shelf life — it answers a question the user just
  // asked and then stops being interesting. Everything else stays put.
  useEffect(() => {
    if (status?.state !== "upToDate") return;
    const timer = window.setTimeout(() => setStatus(null), 2600);
    return () => window.clearTimeout(timer);
  }, [status]);

  const check = useCallback(() => void checkForUpdates(), []);
  const dismiss = useCallback(() => setStatus(null), []);

  return { status, check, dismiss };
}
