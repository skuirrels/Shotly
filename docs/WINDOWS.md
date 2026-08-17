# Shotly on Windows

A plan, not a record. Nothing here is built yet.

Shotly is macOS-only today, and the constraint on the port is that it must not
stay a separate thing: **one repository, one version number, and both platforms
released together**. That requirement does more to shape the work than any
individual API does, so it comes first.

---

## The shape of the problem

Shotly's central design decision is *don't own the pipeline, shell out to the
system*. It is stated in [`capture/cli.rs`](../src-tauri/src/capture/cli.rs) —
shelling out to `screencapture(1)` "buys correct colour profiles, Retina backing
stores and multi-display geometry with none of the Objective-C interop" — and
again in [`record.rs`](../src-tauri/src/record.rs), where owning a
ScreenCaptureKit pipeline would mean "an `AVAssetWriter`, a frame clock and
every codec decision". The same instinct picked Vision for OCR and QuickLook for
poster frames.

That decision is correct on macOS and has no Windows equivalent. Windows ships
no `screencapture`, no `screencapture -v`, no Vision, no `qlmanage`. There is a
built-in OCR engine and that is about the end of the good news.

**So this is not a translation. It is building the pipelines the macOS version
deliberately declined to own.** Every estimate below follows from that.

An unusual amount of the codebase is nonetheless ready for it. `CaptureBackend`
is a real seam, `platform.rs` already carries `cfg(not(target_os = "macos"))`
stubs for all five of its functions, and `capture/display.rs` uses the
`mod imp` pattern that the rest of the port should copy. The head start is real;
it just does not reach as far as recording, pointing, or the clipboard.

---

## What "same repo, same release" costs

Three consequences, none of them optional.

### Releases have to move to CI

A Windows installer cannot be built on a Mac, and the current release path is
`npm run publish` on the maintainer's laptop. Simultaneous release therefore
means a GitHub Actions matrix — `macos-14` and `windows-latest` — building both
halves, and a final job that assembles one `latest.json` naming both platforms
and publishes the release atomically.

This is the single largest structural change in the whole port, and it is worth
doing early, well before any Windows code exists, because it also protects Mac
releases from a broken Windows tree.

### The signing key has to move — but must not be regenerated

[`RELEASING.md`](RELEASING.md) anticipates this: *"If releases ever move to CI,
generate a fresh key with a passphrase and keep both halves in the runner's
secret store."*

**Do not follow that advice literally.** Every installed copy of Shotly has the
current public key compiled in. A fresh keypair means no existing installation
can ever be updated again — the exact failure the same document warns about two
paragraphs earlier. The existing key has to move into GitHub secrets as it is.

Adding a passphrase to the *existing* key without changing the key material is
the thing to investigate: minisign's `-C` flag changes a secret key's password
in place. Tauri stores its private key base64-encoded rather than as a raw
minisign file, so this needs verifying end-to-end on a scratch key before it is
attempted on the real one. If it does not work, ship the key to CI without a
passphrase and rely on the secret store — that is no worse than the status quo,
where it sits mode `600` on one laptop.

Either way, moving it to CI finally gives it a second copy, which
[`RELEASING.md`](RELEASING.md) has been asking for.

The macOS side keeps its own constraint on top of this: the Screen Recording
grant is bound to the signing certificate's designated requirement, so the CI
runner must import the *same* identity, not generate one. This is the natural
moment to switch to a Developer ID certificate — a one-time break for existing
users that has to be announced, and better done once, deliberately, than
stumbled into later.

### Parity becomes a moving target

Windows will take months. If Mac development continues normally during that
time, the target moves faster than the port closes on it.

> **The rule, from the day Phase 0 lands:** every new feature ships with both
> implementations, or it ships behind a trait method that is explicitly
> `unimplemented` on one platform and recorded in the parity table below. No
> feature reaches `main` having only ever been considered on one platform.

This is a real tax on Mac development and it should be accepted knowingly.
The alternative — a freeze on Mac features until Windows catches up — is worse,
because it makes the port's cost invisible while it is being paid.

How fast the target moves is not hypothetical.
[`drive.rs`](../src-tauri/src/drive.rs) — 322 lines, two macOS couplings — landed
in `2c9dd12` during the afternoon this document was written, and is already an
entry in the table below that did not exist when the estimate above was drafted.
That is one feature in one afternoon. Over four months, unmanaged, the gap grows
faster than one developer closes it.

---

## The plan

Single developer, calendar weeks, with the parity gate in force. Nothing can be
deferred past first Windows release, which is what pushes this above a
reduced-scope estimate.

| Phase | Work | Est. |
|---|---|---|
| **0. Foundations** | `platform/` split, the new traits, Windows compiling with stubs, CI matrix building both platforms on every PR | 2 wk |
| **1. Stills** | Capture backend, display/window enumeration, the region selector overlay, window picker, per-monitor DPI | 4–5 wk |
| **2. Shell integration** | Clipboard, trash, reveal, video thumbnails, cloud-folder discovery, tray, hotkeys, autostart | 2 wk |
| **3. The expensive two** | Recording; scrolling capture and live annotation | 5–6 wk |
| **4. OCR and parity sweep** | `Windows.Media.Ocr`, barcodes via `rxing`, then a pass over the parity table | 2 wk |
| **5. Release** | Installer, Authenticode, dual-platform `latest.json`, the update test on both | 2 wk |

**≈ 17–19 weeks**, plus certificate procurement lead time running in parallel
from day one.

Phase 0 is a pure refactor that changes nothing for Mac users, and it should
still land first. It gets cheaper the earlier it happens and it is what makes
the parity rule enforceable.

---

## Repo layout

Inline `cfg(target_os)` works at today's density — fifteen sites — and will not
survive two full implementations inside 1,300-line files. Generalise the
`mod imp` pattern that `capture/display.rs` already uses:

```
src-tauri/src/
  platform/
    mod.rs           the traits, and the re-export of whichever backend is active
    macos/
      capture.rs     screencapture(1), CoreGraphics enumeration
      recorder.rs    screencapture -v and its SIGINT lifecycle
      pointer.rs     CGEventTap, AX hit-testing  (today's snap.rs + ax.rs)
      shell.rs       NSPasteboard, Finder trash, QuickLook, CloudStorage
      chrome.rs      window level, Spaces, sharing type  (today's platform.rs)
      text.rs        Vision
    windows/
      capture.rs     Windows.Graphics.Capture / DXGI
      recorder.rs    WGC + Media Foundation SinkWriter
      pointer.rs     WH_MOUSE_LL hook, EnumWindows + DWM, UI Automation
      shell.rs       CF_HDROP/CF_DIBV5, IFileOperation, IShellItemImageFactory
      chrome.rs      layered windows, SetWindowDisplayAffinity
      text.rs        Windows.Media.Ocr + rxing
```

Five traits, of which one exists:

- **`CaptureBackend`** — already defined in `capture/mod.rs`. Keep as-is.
- **`Recorder`** — start, stop-and-keep, discard, elapsed. Today's `record.rs`
  reaches for `Command` and `libc::kill` directly; the session state machine and
  the HUD above it are portable and should stay in `record.rs`.
- **`Pointer`** — cursor position, what is under it, and exclusive capture of
  the next click. `snap.rs` and `annotate.rs` both want this and neither can
  currently ask for it.
- **`Shell`** — clipboard, trash, reveal, thumbnails, sync-folder discovery,
  and the dataless/offline check.
- **`WindowChrome`** — today's `platform.rs`, unchanged in shape.

Everything above those traits — the stitcher, the session loops, the safety
watchdogs, the geometry, the whole editor — stays where it is and stays shared.
That is the point of doing the split before the implementations.

---

## Subsystem by subsystem

### Ports unchanged

All 15,710 lines of TypeScript. `combine.rs`, `markup.rs`, `pin.rs`,
`update.rs`, `hotkeys.rs`, the `Rect`/`Frame` geometry in `capture/mod.rs`,
`video.rs`'s `probe()` (hand-rolled MP4 atom parsing, no platform calls), and
the row-signature stitcher in `scroll.rs` — of which only the one `shoot()`
function at [`scroll.rs:835`](../src-tauri/src/scroll.rs:835) touches the
system.

### Has to be built

| Subsystem | Rust LOC | Windows approach | Est. |
|---|---|---|---|
| Recording | 894 | Windows Graphics Capture + Media Foundation `SinkWriter`. Bundling ffmpeg is the alternative — ~80 MB and a licensing conversation. | 3–4 wk |
| Still capture + enumeration | 635 | WGC, or DXGI Desktop Duplication. Per-monitor DPI v2. Real geometry replaces the `pHYs`-chunk scale inference, which has no analogue. | 2–3 wk |
| Window outline and picker | 1,617 | `EnumWindows` + `DWMWA_CLOAKED` + `DWMWA_EXTENDED_FRAME_BOUNDS`. `CGEventTap` → `WH_MOUSE_LL`. Sub-window resolution via UI Automation. | 2–3 wk |
| Region selector | — | No `screencapture -i`. The full-screen overlay has to be built. | 1–2 wk |
| Live annotation | 614 | `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST`. | 1 wk |
| OCR and barcodes | 254 | `Windows.Media.Ocr` is built in. **No barcode reader** — needs `rxing`. | 1 wk |
| Clipboard | ~150 | `CF_HDROP` + `CF_DIBV5`. | 3–5 d |
| Video thumbnails | ~60 | `IShellItemImageFactory`. | 2–3 d |
| Cloud-folder discovery | ~80 | `%USERPROFILE%\OneDrive`, Dropbox's `info.json`, the Drive letter. | 2 d |
| Drive links | 322 | Same DriveFS database, at `%LOCALAPPDATA%\Google\DriveFS`. But **Windows ships no `sqlite3` binary**, so the two `Command::new("/usr/bin/sqlite3")` calls become a `rusqlite` dependency. | 3–4 d |
| Trash and reveal | ~40 | `IFileOperation::DeleteItem`; `explorer /select,`. | 1 d |

Drive links are worth a second look, because they are the one case where the
port improves the Mac side rather than merely matching it. Adopting `rusqlite`
removes the shell-out on *both* platforms, leaves `drive.rs` with one
implementation and a per-platform path constant, and drops a dependency on a
system binary whose presence was never guaranteed. Do it once, for both, rather
than adding a second code path.

### Recording is the one to worry about

Everything else on that list has a Windows API that does roughly what the macOS
one did. Recording does not. `screencapture -v` is a whole capture-encode-mux
pipeline behind a command line, and the replacement is Windows Graphics Capture
feeding a Media Foundation `SinkWriter`: a frame clock, an H.264 encoder
configuration, and a mux — precisely the work [`record.rs`](../src-tauri/src/record.rs)
was written to avoid.

Two consequences for the design above it. The `SIGINT`-writes-the-index
behaviour that the module's safety model rests on has no counterpart — on
Windows, finalising the file is an explicit `SinkWriter::Finalize` call, which
is *better*, but the "a lost HUD saves the recording rather than cancelling it"
guarantee has to be re-established rather than inherited. And the frame clock is
now ours, so dropped frames and variable frame rate become Shotly's problem for
the first time.

If the schedule has to give somewhere, this is the only item large enough to
matter — and giving here means breaking the parity requirement. That trade
should be made deliberately, not discovered in week fourteen.

### The region selector deserves its own note

[`capture/cli.rs:327`](../src-tauri/src/capture/cli.rs:327) is an extended
argument for *not* owning the selection overlay, written after a custom one
"failed to paint" and left "the desktop unusable and Shotly had to be
force-quit". `docs/DEVELOPING.md` keeps the whole post-mortem under the heading
*"Why the custom overlay failed (kept as a warning)"*.

Windows gives no way to avoid rebuilding it. `ms-screenclip:` hands back no
geometry and no reliable path, so it is not a substitute.

Read that warning before writing the overlay, and carry over the guards that
[`scroll.rs`](../src-tauri/src/scroll.rs) documents — mouse-transparent until
the page reports it painted, a heartbeat whose silence is treated as death, and
a way out owned by Rust that runs none of the page's code. Windows is more
forgiving than macOS here: a wedged topmost window can still be killed from Task
Manager. Less catastrophic is not the same as acceptable.

---

## The front end

Genuinely portable, with one design problem and a handful of chores.

**The modifier model needs rethinking.** `Chord` in
[`src/lib/keys/keys.ts:10`](../src/lib/keys/keys.ts:10) carries `mod` and `ctrl`
as separate booleans — `mod` is Cmd — and `matchesChord` hardcodes
`e.metaKey !== chord.mod`. On Windows `mod` must become Ctrl, at which point
`mod` and `ctrl` are the same key and a chord asking for both is unsatisfiable.

The saving grace is that nothing currently asks for both: a sweep of the front
end finds `ctrl` used in exactly two places, `TopBar.tsx:521` and
`AnnotateApp.tsx:2031`, and both merely *display* a global capture hotkey rather
than matching one. So the fix is small today and will not stay small — settle
the model in Phase 0, before more bindings are written against it.

**`formatShortcut` renders ⌃⌥⇧⌘ unconditionally** and needs a Windows branch
producing `Ctrl+Shift+6`. `Kbd.tsx` follows from it.

**Hotkey defaults need review, not translation.** `Ctrl+Shift+3/4/5/6/R` were
chosen because macOS owns Cmd+Shift+3/4/5. On Windows the conflict is `Win+Shift+S`
instead, so the current defaults are free — but PrintScreen is the key Windows
users will reach for first and should probably be offered.

**`convertFileSrc` already handles the scheme difference**, but
[`media.rs:272`](../src-tauri/src/media.rs:272) hardcodes `media://localhost/`
while Windows produces `http://media.localhost/`. The handler's URI parsing
needs both forms.

**WebView2 is Chromium, not WebKit.** Expect differences in `backdrop-filter`,
SVG filter rendering and font smoothing — all of which the neon recipe in
`docs/DEVELOPING.md` leans on. Budget a day of visual reconciliation and check
the two-renderer invariant still holds: the Canvas2D export must keep matching
the SVG preview on both platforms.

---

## Release engineering

The target: one tag, two artefacts, one manifest, published together.

```
.github/workflows/release.yml
  build-macos    → Shotly.app.tar.gz + .dmg, signed with the stable identity
  build-windows  → Shotly-setup.exe + .nsis.zip, Authenticode-signed
  publish        → assembles latest.json with both platform keys, uploads, tags
```

`latest.json` gains a second entry beside the existing one:

```json
{
  "platforms": {
    "darwin-aarch64":  { "signature": "…", "url": "…Shotly.app.tar.gz" },
    "windows-x86_64":  { "signature": "…", "url": "…Shotly-setup.nsis.zip" }
  }
}
```

[`scripts/publish.mjs`](../scripts/publish.mjs) currently hardcodes
`dmg/Shotly_${version}_aarch64.dmg` and writes a single-platform manifest. Its
refusal checks — no republishing a live version, no publishing an unpushed
commit, no silent change of signing identity — are the valuable part and should
survive the rewrite. Add one: **refuse to publish unless both platform artefacts
are present.** A manifest naming only one of them is how the platforms silently
drift apart.

Authenticode is a procurement task with a lead time, so start it in week one. A
standard OV certificate still leaves SmartScreen warning until reputation
accrues; an EV certificate skips that and costs more. For a paid tool with a
download page, EV is probably the right answer — but decide early, because the
first Windows release is the worst possible time to be building reputation from
zero.

The update test in [`RELEASING.md`](RELEASING.md) — install version N−1, use
**Check for Updates…**, confirm the relaunch and that Screen Recording survived
— has to be run on both platforms every release. On Windows the equivalent of
the final check is confirming the installer replaced the binary while the app
was running, which is the failure mode NSIS is most likely to produce.

---

## Things that are easier on Windows

Worth saying, because the list above is relentlessly one-directional.

**The phantom-window problem largely dissolves.**
[`ax.rs`](../src-tauri/src/ax.rs) opens with a long account of why
`CGWindowListCopyWindowInfo` could not be trusted — it lists windows that report
themselves onscreen while not being composited — and the accessibility API was
adopted to work around it. Windows answers the same question directly:
`DWMWA_CLOAKED` tells you whether the compositor is actually showing a window.
The outline can likely be built from `EnumWindows` alone, and the 469 lines of
AX machinery shrink to something much smaller.

**Spaces stop existing.** Every `NSWindowCollectionBehavior` decision in
[`platform.rs`](../src-tauri/src/platform.rs), the whole "Window level and
Spaces" section of `DEVELOPING.md`, and `follow_active_space` — all of it is
simply absent on Windows. Virtual desktops exist but do not impose the same
problem on an accessory application.

**Hiding the HUD from the recording has an exact equivalent.**
`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` does what
`NSWindowSharingNone` does, on Windows 10 2004 and later. The recording panel
can keep sitting over the display it is recording.

**No TCC.** No permission prompt, no per-build identity trap, no "quit and
reopen before the grant applies". Most of `DEVELOPING.md`'s first forty lines
have no Windows counterpart.

---

## Traps that carry over

**Cloud-evicted files.** [`commands.rs:520`](../src-tauri/src/commands.rs:520)
documents five hang reports in two days, all from reading a file whose bytes
iCloud had evicted, on the main thread. Windows has the identical hazard through
OneDrive Files On-Demand — `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` and
`FILE_ATTRIBUTE_OFFLINE`. The `cfg(not(target_os = "macos"))` stub currently
returns `false`, so a naive port reintroduces a bug that has already been paid
for once. This is the single easiest thing on this page to forget.

**Mixed-DPI multi-monitor.** The macOS code arrives at backing scale three
different ways — the display mode, the PNG's `pHYs` chunk, the display under the
cursor — because each is wrong somewhere. Windows has its own version of this
mess: per-monitor DPI awareness v2, and a WebView2 that must be told about it.
Assume it will take longer than it looks.

**The overlay-wedge lesson.** See the region selector note above. The warnings
in `DEVELOPING.md` were bought with real debugging time and they are about a
class of bug, not about AppKit.

---

## Open questions

Resolve these before committing to the schedule; each could move a phase.

1. **Can the existing minisign key take a passphrase in place?** Verify
   `minisign -C` against Tauri's base64 key format on a scratch key. If not, the
   key goes to CI unprotected — acceptable, but decide rather than discover.
2. **Developer ID now or later?** Moving Mac builds to CI is the cheapest moment
   to switch, and switching breaks the Screen Recording grant once. Doing it in
   the same release as the Windows launch bundles two announcements into one.
3. **WGC or DXGI for stills?** WGC is the modern path and shares code with the
   recorder; DXGI Desktop Duplication is lower-level and better documented for
   single-frame grabs. Prototype both in Phase 0 — an hour each, and it
   determines the shape of Phase 1.
4. **Windows 10 floor, or Windows 11 only?** `WDA_EXCLUDEFROMCAPTURE` needs
   10 2004; WGC needs 1903. A Windows 11 floor removes a class of conditional
   and is defensible for a new port.
5. **Does recording hold the schedule?** It is 3–4 weeks of the 17–19, and it is
   the only item whose omission would visibly break parity. If it slips, the
   decision is whether Windows ships without it or both platforms wait.
