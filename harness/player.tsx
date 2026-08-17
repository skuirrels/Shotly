import { useState } from "react";
import { createRoot } from "react-dom/client";
import "./harness.css";
import { Player } from "@/windows/editor/Player";

/**
 * The player pane over a real movie file.
 *
 * A plain browser can't reach Tauri's asset protocol, so the stub's
 * `convertFileSrc` hands back the path unchanged and Vite serves the sample
 * clip from the harness folder. Everything above that line — the transport,
 * the scrubber, the keys, the speed menu — is the shipping component.
 *
 * `sample.mov` is twelve seconds of a test pattern, not a real capture:
 *
 *     ffmpeg -f lavfi -i "testsrc=size=1280x720:rate=30:duration=12" \
 *       -pix_fmt yuv420p -c:v libx264 -movflags +faststart harness/sample.mov
 */
const MOVIE = {
  path: "/sample.mov",
  name: "Recording 2026-08-17 at 13.58.12.mov",
  modified: Date.now(),
  seconds: 12,
  cloud: false,
};

function Harness() {
  // The editor holds the pane's place the same way: an open/closed flag and a
  // remembered position, so leaving and coming back can be exercised here.
  const [open, setOpen] = useState(true);
  // State rather than the editor's ref, only so the button below can show the
  // remembered position back to you.
  const [resume, setResume] = useState(0);

  return (
    <div className="relative flex h-screen flex-col bg-base text-ink">
      {open ? (
        <Player
          movie={MOVIE}
          startAt={resume}
          onLeave={setResume}
          onClose={() => {
            console.log("close");
            setOpen(false);
          }}
          onError={(m) => console.error(m)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="m-auto rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-accent-fg"
        >
          Back to the player (resumes at {resume.toFixed(1)}s)
        </button>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
