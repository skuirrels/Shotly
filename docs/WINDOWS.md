# Shotly on Windows

Phase 0 is built and on `main`; everything after it is a plan. The line
between the two is [Phase 0 — done](#phase-0--done).

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

An unusual amount of the codebase was nonetheless ready for it, which is what
made Phase 0 cheap: `CaptureBackend` was already a real seam, `platform.rs`
already carried `cfg(not(target_os = "macos"))` stubs for all five of its
functions, and `capture/display.rs` already used the `mod imp` pattern the rest
of the split copied. That head start was real; it did not reach as far as
recording, pointing, or the clipboard, and those are what Phase 0 built homes
for.

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

How fast the target moves is not hypothetical, and this document now has two
data points of its own. `drive.rs` — 322 lines, two macOS couplings — landed in
`2c9dd12` during the afternoon this document was written, became an entry in
the table below, and was then deleted and replaced by
[`share/`](../src-tauri/src/share/), which is nearly portable. That was the
cheap direction. The expensive one followed within days: recording trim and cut
([`trim.rs`](../src-tauri/src/trim.rs) + what is now
[`platform/macos/editor.rs`](../src-tauri/src/platform/macos/editor.rs), 1,157
lines) landed as a pure AVFoundation pipeline, and is now the second-largest
item in the table. Two
features, two weeks, one net gain of roughly two porting-weeks. Over four
months, unmanaged, the gap moves faster than one developer tracking it.

---

## The plan

Single developer, calendar weeks, with the parity gate in force. Nothing can be
deferred past first Windows release, which is what pushes this above a
reduced-scope estimate.

| Phase | Work | Est. |
|---|---|---|
| ~~**0. Foundations**~~ | ~~`platform/` split, the traits, `platform.ts`, the CI ratchet~~ — **done**, see [Phase 0](#phase-0--done) | ✓ |
| **1. Stills** | Capture backend, display/window enumeration, the region selector overlay, window picker, per-monitor DPI | 4–5 wk |
| **2. Shell integration** | Clipboard, trash, reveal, video thumbnails, cloud-folder discovery, tray, hotkeys, autostart | 2 wk |
| **3. The expensive three** | Recording; trim and cut; scrolling capture and live annotation | 7–8 wk |
| **4. OCR and parity sweep** | `Windows.Media.Ocr`, barcodes via `rxing`, then a pass over the parity table | 2 wk |
| **5. Release** | Installer, Authenticode, dual-platform `latest.json`, the update test on both | 2 wk |

**≈ 17–19 weeks remaining**, plus certificate procurement lead time running in parallel
from day one. (19–22 including Phase 0, which is now done; recording trim and
cut landed after the first estimate and added roughly two weeks — see the
parity note above.)

Phase 0 was a pure refactor that changed nothing for Mac users, and it is what
makes the parity rule enforceable. It is done — everything below now has
somewhere to go.

---

## One app that happens to run in two places

"Windows looks the same, behaves the same" needs to be made mechanical, or it
decays into whatever each pull request happened to do. The rule has two halves.

**Everything above the traits is identical, not similar.** One frontend, one
`theme.css`, one editor store, one command registry, one library, one file
naming scheme, one update cadence. The Windows build renders the same pixels
from the same components; there is no `EditorApp.windows.tsx` and there never
will be. Behaviour lives above the seam — a capture is taken, named, filed and
annotated by shared code — and only the syscall underneath differs.

**Difference is allowed only where the OS's own conventions demand it**, and
every such difference goes through one module rather than being decided at the
call site. The complete list, which is short and should stay short:

| Differs | macOS | Windows |
|---|---|---|
| Keyboard glyphs | ⌃⌥⇧⌘Z | `Ctrl+Shift+Z` |
| Primary modifier (`Mod`) | ⌘ | Ctrl |
| Shell nouns | Finder, Trash, menu bar, System Settings | Explorer, Recycle Bin, tray, Settings |
| Window chrome | traffic lights, left, 86px inset | caption buttons, right |
| Font stack | `-apple-system, SF Pro Text…` | `Segoe UI Variable, Segoe UI…` |
| Capture hotkey defaults | ⌃⇧3/4/5/6/R (avoiding ⌘⇧3/4/5) | free to reconsider — the conflict is `Win+Shift+S`, and PrintScreen is the key users reach for |
| Tray conventions | left-click opens the menu | left-click activates, right-click menus |

The mechanism is a single `src/lib/platform.ts`, established in Phase 0 while
its answer is still always "macos": the OS name once, `Mod`'s identity, the
glyph formatter, and a nouns dictionary (`nouns.reveal` → "Show in Finder" /
"Show in Explorer", and so on). Today the frontend contains **no platform
detection at all** — which is the best possible starting state, because it
means every future difference has to be introduced deliberately, through this
one file, where review can see it. Scattered `if (isWindows)` at call sites is
the failure mode; the module exists so there is never a reason to write one.

A sweep for the nouns finds roughly thirty user-visible strings — "Show in
Finder" and "Move to Trash" in `TopBar.tsx`, `Library.tsx` and `EditorApp.tsx`'s
command registry, "System Settings" in the permission error, "menu bar" in
`SnapApp.tsx`'s hint. Half a day, best spent before the list grows.

Two places where "the same" needs a decision rather than a rule:

* **Window chrome.** `titleBarStyle: Overlay` in `tauri.conf.json` is
  macOS-only, and `TopBar.tsx` hardcodes `pl-[86px]` for the traffic lights.
  Windows wants `decorations: false` with the top bar as the drag region and
  either custom caption buttons (more sameness, more work — minimize/maximize/
  close, snap layouts on 11) or standard chrome (less work, visibly different).
  Custom buttons are the answer that honours "looks the same"; the inset
  becomes a `platform.ts` token either way.
* **WebView2 is Chromium, not WebKit.** Same markup, same tokens — but
  `backdrop-filter`, SVG filters and font smoothing all render slightly
  differently, and the neon recipe leans on all three. "Looks the same" here
  means a side-by-side pass with real eyes, not an assertion.

## Repo layout

This is what Phase 0 built, and it is what is on disk now. Inline
`cfg(target_os)` worked at fifteen sites and would not have survived two full
implementations inside 1,300-line files:

```
src-tauri/src/
  platform/
    mod.rs           picks a side, and states the rule
    macos/
      chrome.rs      window level, Spaces, sharing type   (was platform.rs)
      clock.rs       localtime_r
      editor.rs      AVFoundation passthrough + exact cut (was compose.rs)
      paths.rs       ~/Library/Application Support
      pointer.rs     cursor, AX hit-testing               (was half of ax.rs)
      recorder.rs    screencapture -v, and SIGINT
      shell.rs       NSPasteboard, Finder trash, QuickLook, CloudStorage
      text.rs        Vision
    windows/         the same eight, as documented stubs
```

Each Windows module names the API that will implement it and what changes when
it does — `SetWindowDisplayAffinity` for `hide_from_capture`, `GetLocalTime`
for the clock, `IShellItemImageFactory` for poster frames, and the three ways
round Media Foundation's missing edit lists for `editor`.

One concern stayed outside `platform/`, on purpose: **`capture/`** is already
its own seam — `CaptureBackend` is a trait with a swappable implementation,
which is the same idea arrived at earlier; folding it in is worth doing and is
not urgent. (`share::gauth`'s keychain migration keeps a `cfg` too, but it is
a one-time rescue from a store only macOS ever had, not an abstraction with a
second implementation to write.)

What the split turned up, which is the part worth keeping in mind for the rest
of the port: the seam is usually further down than it looks. `Precision` and
`Segment` moved *up* into `trim.rs`, `ax.rs`'s geometry never had to move at
all, and `video.rs` came out entirely portable once one function left it.

Everything above the split — the stitcher, the session loops, the safety
watchdogs, the geometry, the whole editor — stayed where it was and stays
shared. That was the point of doing this before the implementations.

---

## Phase 0 — done

The groundwork is in. It changed no behaviour on macOS and every step landed
with the tests green; what follows is what exists now, so the rest of this
document can be read against it.

**`src-tauri/src/platform/`**, with `macos/` and `windows/` holding the same
eight modules each — `chrome`, `clock`, `editor`, `paths`, `pointer`,
`recorder`, `shell`, `text`. The Windows side is stubs, but stubs that carry
the API to call and the reason: `platform/windows/editor.rs` sets out the three
ways round Media Foundation's missing edit lists, `shell.rs` names the OneDrive
attributes that make `is_dataless` mandatory rather than cosmetic.

**What moved, and what turned out to be portable after all.** The interesting
half of this phase was discovering how much did not need to move:

* `compose.rs` → `platform/macos/editor.rs`, but `Precision` and `Segment` went
  the *other* way, into `trim.rs` with the planning. They are the vocabulary the
  planner and the writer share, so putting them beside the planner means no
  platform's writer can quietly mean something else by `Fast`.
* `ax.rs` split rather than moved: `Node`, `refine` and `at_level` are pure
  geometry with tests and stayed portable; only the three questions that reach
  for `AXUIElement` went to `platform::pointer`.
* `video.rs` lost `poster` to `platform::shell` and is now entirely portable —
  the MP4 atom parsing never needed a platform at all.
* Three identical copies of the six-line cursor reader, in `snap.rs`,
  `annotate.rs` and `capture/cli.rs`, became one.
* `stamped_stem`'s `libc::localtime_r` became `platform::clock::local_now`;
  `gauth`'s hardcoded `Library/Application Support` became
  `platform::paths::config_dir`; `keyring` is now a macOS-only dependency,
  because migrating out of the login keychain is a macOS-only thing to need.

**`src/lib/platform.ts`** — the one file that knows which OS this is, holding
`Mod`'s identity, the shortcut formatter's two spellings, the shell nouns and
the titlebar inset. Roughly thirty user-visible strings now read from it.
`keys.ts` matches `Mod` against ⌘ or Ctrl accordingly, and `formatShortcut`
renders `⇧⌘Z` or `Ctrl+Shift+Z`.

**Tests**, because the refactor had to be provably behaviour-preserving: 119
Rust (up from 113) and 16 front-end, from none. The new ones deliberately pin
the things the port will be tempted to change — that a DPI tag written is a DPI
tag read back, that a stamped stem carries a plausible *year* and not just a
plausible shape (a zeroed `tm` formats as 1900 and would otherwise pass), that
the Windows-shaped `http://media.localhost/…` URI serves identically to
`media://localhost/…`, and both halves of the keyboard grammar.

**`.github/workflows/ci.yml`** — the ratchet, and it is live. macOS runs
typecheck, both test suites and a build. Windows runs `cargo check`. Both
block.

The Windows job took three runs to go green and did not waste any of them:

1. It died in `objc2`, before reaching Shotly at all — `objc2-core-video` was
   sitting in the general dependency list while every sibling was gated, so a
   `compile_error!` meant for Apple platforms was being compiled on Windows.
2. With that gated it reached our code and found four things: a POSIX-only
   `chmod` in `share::gauth` (now `platform::paths::restrict_to_owner`, whose
   Windows side states plainly what returning `Ok` costs), and two stubs that
   a careless edit had deleted from `platform/windows/shell.rs` — an edit made
   on a Mac, reviewed on a Mac, with every local check green.
3. Green.

**Shotly now compiles for Windows.** As stubs that refuse at runtime, not as a
working application — everything below is still to build. But the thing worth
defending exists from here: nothing can reach for a macOS API from shared code
without turning the job red, which is what keeps the split honest over a port
measured in months rather than days.

One casualty worth recording. `scroll`'s `keeps_up_at_retina_size_in_debug`
asserts wall-clock time, and a shared runner managed 462ms against its 450ms
bound on code that had not changed — the same commit had passed minutes
earlier. It now returns early under `CI`. A timing bound on somebody else's
hardware measures how busy that hardware is, and a flaky test on a blocking
job is worse than no test: it teaches people that red means nothing, which is
the one thing this workflow exists to prevent.

> **Worth knowing before trying to run the Windows check locally:** it cannot be
> done from a Mac. `ureq`'s rustls pulls in `ring`, whose build script needs a C
> compiler targeting Windows, so the cross-check dies in a dependency long
> before it reaches Shotly's own code. (On a real Windows runner `ring` builds
> fine — the wall is the cross-compile, not the crate.) CI on `windows-latest`
> is the only place this is observable without `cargo-xwin` and a Microsoft
> EULA, which is precisely why the job has to block rather than inform.

### The tap, which took a second sitting

`snap.rs`'s `CGEventTap` was the one piece held back from the sweep, and the
reason is worth keeping: it is ~200 lines whose failure mode is a desktop
nobody can use — this codebase has been there — and **nothing automated can
verify a move of it**. A tap needs a live event stream, so no unit test
reaches it; scripted input warps the cursor rather than reproducing a drag, so
no scripted check does either. Moving it inside a refactor sweep would have
been an unverifiable change to the most dangerous code in the app.

It moved afterwards, on its own, against a debug build with somebody at the
keyboard — outline following, click taking the window, drag taking the region.
`platform::pointer` owns the tap and the state it produces; `snap.rs` keeps
what a verdict means.

Two things fell out of doing it separately. The drag rule reaches the tap as a
`fn` pointer, because what counts as a drag is `snap`'s policy and not the
tap's — and it is still evaluated *inside the callback*, on the points the
events carried, rather than recomputed later from the stored cells, which
would have raced the next press. And `dragged_to` and `drag_point` became pure
functions taking explicit points, so the drag tests exercise the rule instead
of poking globals, and the mutex that serialised them disappeared.

The Windows counterpart should be smaller rather than equivalent. There is no
rule there that a click-catching overlay is invisible to hit-testing, so the
overlay can take its own clicks and the system-wide hook may not be needed at
all — see `platform/windows/pointer.rs`.

---

## Subsystem by subsystem

### Ports unchanged

All 17,412 lines of TypeScript — including the trim bar and the player's cut
handles, which sit entirely above `compose::write`. `combine.rs`, `markup.rs`,
`pin.rs`, `update.rs`, `hotkeys.rs`, the `Rect`/`Frame` geometry in
`capture/mod.rs`, `video.rs`'s `probe()` (hand-rolled MP4 atom parsing, no
platform calls), and the stitcher, gap detection and stall watchdog in
`scroll.rs` — whose platform contact is one `shoot()` function
([`scroll.rs:1157`](../src-tauri/src/scroll.rs:1157)) plus the window lookups
it borrows from `snap`, all behind the same two traits. The planning half of
`trim.rs` — which turns marks into a segment list and needs no file on disk to
test — is portable too; `platform::editor` is the platform half, and
`editor::write` is the seam it was already shaped like.

### Has to be built

| Subsystem | Rust LOC | Windows approach | Est. |
|---|---|---|---|
| Recording | 894 | Windows Graphics Capture + Media Foundation `SinkWriter`. Bundling ffmpeg is the alternative — ~80 MB and a licensing conversation. | 3–4 wk |
| Trim and cut | 1,157 | `platform/macos/editor.rs` is AVFoundation end to end: passthrough export with edit lists, and an exact-cut H.264 re-encode. Media Foundation `SourceReader`/`SinkWriter`; see the note below — the passthrough trick does not translate whole. | 1.5–2 wk |
| Still capture + enumeration | 635 | WGC, or DXGI Desktop Duplication. Per-monitor DPI v2. Real geometry replaces the `pHYs`-chunk scale inference, which has no analogue. | 2–3 wk |
| Window outline and picker | 1,988 | `EnumWindows` + `DWMWA_CLOAKED` + `DWMWA_EXTENDED_FRAME_BOUNDS`. `CGEventTap` → `WH_MOUSE_LL`. Sub-window resolution via UI Automation. | 2–3 wk |
| Region selector | — | No `screencapture -i`. The full-screen overlay has to be built. | 1–2 wk |
| Live annotation | 614 | `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST`. | 1 wk |
| OCR and barcodes | 254 | `Windows.Media.Ocr` is built in. **No barcode reader** — needs `rxing`. | 1 wk |
| Clipboard | ~150 | `CF_HDROP` + `CF_DIBV5`. | 3–5 d |
| Video thumbnails | ~60 | `IShellItemImageFactory`. | 2–3 d |
| Cloud-folder discovery | ~80 | `%USERPROFILE%\OneDrive`, Dropbox's `info.json`, the Drive letter. | 2 d |
| Share links | ~10 | `share/` is HTTP (`ureq` + rustls), OAuth over a loopback redirect, and a `0600` token file. Two small couplings: `gauth::config_dir` hardcodes `Library/Application Support` (use Tauri's config-dir API), and the `keyring` dependency is built `apple-native`-only — correctly, since it exists solely to migrate tokens out of an older install's login keychain, which no Windows machine has. `cfg` the migration out. | ½ d |
| Trash and reveal | ~40 | `IFileOperation::DeleteItem`; `explorer /select,`. | 1 d |

Share links are worth a second look, because the estimate for them went from
3–4 days to half of one — and not by being deferred. The original `drive.rs`
read Drive for desktop's SQLite index through `/usr/bin/sqlite3`, two macOS
couplings and a system binary Windows does not ship. Replacing it with an
upload through Drive's own API was done for a product reason (a link that works
when it is copied, from any capture, without a synced folder) and happened to
delete nearly all of the platform coupling with it. The general point is worth
keeping: a feature built on somebody's private local file is nearly always
costed as a port, and the API it was avoiding is nearly always portable.

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

Since this document was first written, recording grew an editor.
[`trim.rs`](../src-tauri/src/trim.rs) and
[`platform/macos/editor.rs`](../src-tauri/src/platform/macos/editor.rs) turn
two marks on a timeline into a
shorter movie, two ways: a lossless passthrough export whose cut points ride on
edit lists, and an exact H.264 re-encode for when the mark must be the mark.
The planning layer is portable; the pipeline is AVFoundation end to end, and
one of its two tricks does not translate. Media Foundation's MP4 sink writes no
edit lists, so the frame-accurate-yet-lossless cut — the thing that module's
header spends three paragraphs earning — has no direct Windows equivalent:
passthrough cuts land on sync samples, and frame accuracy costs the re-encode.
Shotly already owns an exact re-encode path, so the feature survives; the
*default* changes character, and that is a product decision to make knowingly
rather than a porting detail. One genuine consolation: on Windows the recorder
is ours, so the keyframe cadence is ours — a one-second GOP is a choice, not a
property of `screencapture -v` to be discovered, and every cut gets cheaper the
shorter it is.

If the schedule has to give somewhere, recording and its editor are the only
items large enough to matter — and giving here means breaking the parity
requirement. That trade should be made deliberately, not discovered in week
fourteen.

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
[`media.rs:314`](../src-tauri/src/media.rs:314) hardcodes `media://localhost/`
while Windows produces `http://media.localhost/`. The handler's URI parsing
needs both forms.

**WebView2 is Chromium, not WebKit.** Expect differences in `backdrop-filter`,
SVG filter rendering and font smoothing — all of which the neon recipe in
`docs/DEVELOPING.md` leans on. Budget a day of visual reconciliation and check
the two-renderer invariant still holds: the Canvas2D export must keep matching
the SVG preview on both platforms.

Everything else the frontend needs — the nouns dictionary, `platform.ts`, the
chrome inset — is in [One app that happens to run in two
places](#one-app-that-happens-to-run-in-two-places) above.

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
refusal checks have grown since this document was first written and every one of
them survives a move to CI unchanged: no republishing a live version, no
publishing an unpushed commit, no silent change of signing identity, no release
without a `CHANGELOG.md` entry for it, and no release whose compiled-in Google
OAuth client Google itself does not recognise
([`check-google-client.mjs`](../scripts/check-google-client.mjs) — bought by
0.9.3, which shipped placeholder credentials that passed a format check). These
are the valuable part and should survive the rewrite. Add one: **refuse to
publish unless both platform artefacts are present.** A manifest naming only one
of them is how the platforms silently drift apart.

The Google client check also names a third secret that has to move to CI
alongside the two signing identities: the release builds read the OAuth client
from `.env.release`, which lives only on the build machine today. Same
treatment as the minisign key — into the repository's secrets, not into a fresh
one.

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
[`platform::chrome`](../src-tauri/src/platform/macos/chrome.rs), the whole "Window level and
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
5. **Does recording hold the schedule?** With its editor it is 5–6 weeks of
   the 17–19 remaining, and it is
   the only item whose omission would visibly break parity. If it slips, the
   decision is whether Windows ships without it or both platforms wait.
