# Shotly on the Mac App Store

Nothing in here is built, and none of it is scheduled. This is an assessment,
written down so the question does not have to be answered from scratch every
time it comes up.

**The short version: the App Store costs a rewrite of the capture engine and
the loss of two features, and buys nothing that a Developer ID certificate does
not already buy.** The recommendation at the bottom is to ship
[Developer ID](DEVELOPING.md) instead. Everything between here and there is the
evidence for it.

---

## The two destinations are not the same errand

Both need the same $99 Apple Developer Program membership, and there the
resemblance ends.

|                     | Developer ID (direct download)     | Mac App Store                        |
| ------------------- | ---------------------------------- | ------------------------------------ |
| Code changes        | none                               | most of `platform/macos`             |
| App Sandbox         | no                                 | mandatory                            |
| Hardened Runtime    | yes                                | no (the sandbox replaces it)          |
| Notarization        | yes, automated by Tauri            | no (review replaces it)              |
| Ships as            | `.dmg`                             | `.pkg`, uploaded, reviewed           |
| Self-updates        | yes — [`RELEASING.md`](RELEASING.md) | forbidden                           |
| Time to first ship  | an afternoon                       | weeks                                |
| Features lost       | none                               | Interact, the accessibility outline  |

[`DEVELOPING.md`](DEVELOPING.md) already documents the left-hand column end to
end. This document is only about the right-hand one.

---

## The shape of the problem

Shotly's central design decision is *don't own the pipeline, shell out to the
system*. It is stated in [`capture/cli.rs`](../src-tauri/src/capture/cli.rs) —
shelling out to `screencapture(1)` "buys correct colour profiles, Retina backing
stores and multi-display geometry with none of the Objective-C interop" — and
again in [`record.rs`](../src-tauri/src/record.rs), where owning a
ScreenCaptureKit pipeline would mean "an `AVAssetWriter`, a frame clock and
every codec decision".

The App Sandbox's central rule is that an application may not reach outside its
own container, and that includes reaching for the system's own tools and
expecting them to do work on its behalf. A sandboxed child process inherits the
sandbox; `screencapture` inside one cannot talk to the window server the way it
needs to, and the TCC grant that makes screen recording legal is held against
Shotly, not against a binary it spawned.

Then there is the second half of Shotly's identity. The outline that frames
whatever is under the pointer, and the Interact hotkey, are both built on
`AXUIElementCopyElementAtPosition` — and **a sandboxed application cannot be
granted accessibility trust at all.** Not "must ask the user"; cannot.

So this is the same bill [`WINDOWS.md`](WINDOWS.md) prices for the port —
*building the pipelines the macOS version deliberately declined to own* — except
that it is payable on macOS, where the pipelines already work, in exchange for a
shelf listing.

---

## What the sandbox takes

### 1. `screencapture(1)`, in four places

Every still, every video and every scroll tile currently comes out of a
subprocess.

| Call site | What it does |
| --------- | ------------ |
| [`capture/cli.rs:249`](../src-tauri/src/capture/cli.rs#L249) | `ScreencaptureCli::run` — displays, windows, crops |
| [`capture/cli.rs:382`](../src-tauri/src/capture/cli.rs#L382) | `-i` crosshair and `-i -w -o` window picker |
| [`platform/macos/recorder.rs:30`](../src-tauri/src/platform/macos/recorder.rs#L30) | `-v -x`, plus `-g` for the microphone |
| [`scroll.rs:1176`](../src-tauri/src/scroll.rs#L1176) | one `-R`/`-l` grab per tile of a scrolling capture |

All four become ScreenCaptureKit, in process:

- **Stills** — `SCScreenshotManager`, which is macOS **14.0+**. `tauri.conf.json`
  currently sets `minimumSystemVersion` to `13.0`, so the floor moves and Ventura
  users are dropped.
- **Video** — `SCStream` into `SCRecordingOutput` (macOS 15+) or an
  `AVAssetWriter` you drive yourself. The second one is the frame clock and the
  codec decisions `record.rs` declined to own.
- **The microphone** — `-g` no longer exists to do it for you. The input device
  becomes an `AVCaptureDevice` mixed into the writer, which also means the
  wording of `NSMicrophoneUsageDescription` in
  [`Info.plist`](../src-tauri/Info.plist) stops being true: the comment there
  says the microphone is opened by a child process, and it would no longer be.
- **The interactive crosshair** — there is no system selector to borrow. The
  comment at `capture/cli.rs:363` explains that `-i` *replaced* a custom overlay
  which could wedge the machine when it failed to paint; the store build brings
  that overlay back, and its failure mode with it.

This is the single largest item in the document and most of the calendar time.

### 2. The accessibility API

[`ax.rs`](../src-tauri/src/ax.rs) and
[`platform/macos/pointer.rs:74`](../src-tauri/src/platform/macos/pointer.rs#L74)
call `AXUIElementCopyElementAtPosition`, `AXUIElementCopyAttributeValue` and
`AXIsProcessTrusted`. Unavailable to a sandboxed process.

That takes with it:

- **The window outline**, which would have to fall back to
  `CGWindowListCopyWindowInfo` — the exact API `ax.rs` documents having moved
  *away* from, because that list "contains windows that report themselves
  frontmost, opaque and `kCGWindowIsOnscreen` while not being composited at
  all". `SCShareableContent` is the sandbox-legal replacement and is a window
  list, not a hit test: it can say which windows exist, never "what would a
  click here land on".
- **Scroll-to-tighten**, which walks the element ancestry to find something
  smaller than the window worth framing. There is no ancestry without AX.
- **Interact** ([`lib.rs:209`](../src-tauri/src/lib.rs#L209)) — gone outright.

### 3. The event tap

[`pointer.rs:527`](../src-tauri/src/platform/macos/pointer.rs#L527) creates a
session-level `CGEventTap` so a window-pick session can take the click without
the overlay accepting it — which it must never do, because an overlay that
accepts mouse events becomes visible to the hit test and poisons the answer.
Event taps need the same accessibility trust, so they go the same way, and the
overlay has to start accepting clicks. On the store build there is no hit test
left to poison, so this is survivable; it is listed because it is a second
rewrite hiding inside the first.

### 4. Finder, `open` and `qlmanage`

[`platform/macos/shell.rs`](../src-tauri/src/platform/macos/shell.rs) shells out
three more times, and each has a sandbox-legal replacement:

| Now | Then |
| --- | ---- |
| `osascript` → `tell Finder to delete` (`:47`) | `NSFileManager.trashItem` |
| `/usr/bin/open` (`:64`) | `NSWorkspace.open` / `activateFileViewerSelecting` |
| `/usr/bin/qlmanage` (`:172`) | `QLThumbnailGenerator` |

The AppleScript one is the only real trap: driving another application by Apple
Event needs a `temporary-exception.apple-events` entitlement, and reviewers
routinely reject those when a framework call would do. Here one would.

### 5. Self-updating

Forbidden on the store — the store *is* the update mechanism. Out come
`tauri-plugin-updater`, [`update.rs`](../src-tauri/src/update.rs), the
`updater` block and `createUpdaterArtifacts` in `tauri.conf.json`, the
`updater:default` capability, `process:allow-restart`, the tray's **Check for
Updates…**, and `scripts/publish.mjs`.

The minisign key in `~/.tauri/shotly.key` does not stop mattering. Every copy of
Shotly already installed from a DMG has that public key and that GitHub URL
compiled in, and a store build cannot serve them. Shipping to the store does not
retire the direct-download channel; it adds a second one that has to be released
in step with the first, or the DMG users quietly stop receiving updates.

### 6. `macOSPrivateApi`

`tauri.conf.json` sets `"macOSPrivateApi": true`, which is also
`features = ["macos-private-api"]` in `Cargo.toml`. Private API use is an
automatic rejection. Turning it off costs the transparent-window support it was
turned on for; what exactly breaks has to be measured rather than guessed.

### 7. The login item

[`lib.rs:141`](../src-tauri/src/lib.rs#L141) uses
`MacosLauncher::LaunchAgent`, which writes a plist into `~/Library/LaunchAgents`
— outside the container, so it fails silently in a sandbox. The replacement is
`SMAppService.mainApp`, which also means `AUTOSTART_ARG` (`--opened-at-login`,
`lib.rs:59`) has nothing to set it: `SMAppService` passes no arguments. The
"start hidden when the system launched me" logic at `lib.rs:357` needs a
different signal.

### 8. The library folder, and the backup targets

Captures land in `~/Documents/Shotly`
([`commands.rs:733`](../src-tauri/src/commands.rs#L733)), which a sandboxed app
cannot create or write to without the user choosing it in an `NSOpenPanel`
first, and holding onto it afterwards as a security-scoped bookmark. Every path
that reaches the library — [`media.rs`](../src-tauri/src/media.rs)'s scheme
handler, the asset protocol scope, the thumbnailer, the backup mirror — has to
start and stop that bookmark's access.

Backup is worse than inconvenient. `backup_targets`
([`backup.rs:87`](../src-tauri/src/backup.rs#L87)) discovers iCloud, Dropbox and
the rest by listing the user's home directory. A sandboxed app cannot list
`$HOME`, so the feature stops being "here are the cloud folders you have" and
becomes "please go and find one" — a different, worse feature.

### 9. The keychain

[`gauth.rs:92`](../src-tauri/src/share/gauth.rs#L92) already writes this down:
the legacy login keychain authorises by binary identity, the Data Protection
keychain authorises by team id through a `keychain-access-groups` entitlement,
and the second is what Apple intends. The store build gets that entitlement by
force. What has to be tested is `migrate_from_keychain` (`:173`), which reads
items an unsandboxed Shotly wrote — from inside a container that may not be
allowed to see them. If it cannot, store users signed into Google today sign in
again, which is survivable but should be a decision rather than a surprise.

### 10. The loopback OAuth server

[`gauth.rs:408`](../src-tauri/src/share/gauth.rs#L408) binds a `TcpListener` on
`127.0.0.1` for Google's installed-app flow. This is legal in a sandbox, but it
needs `com.apple.security.network.server` on top of `network.client`, and a
listening socket is something reviewers ask about. `ASWebAuthenticationSession`
does the same job with no listener and no extra entitlement, and is worth the
swap on its own merits.

---

## What survives untouched

Worth stating, because the list above reads like the whole app:

- **The global hotkeys.** `tauri-plugin-global-shortcut` resolves to
  `global-hotkey` 0.8.0, whose macOS implementation is Carbon
  `RegisterEventHotKey` (`kEventHotKeyPressed` in its `ffi.rs`). That is
  sandbox-legal and needs no entitlement — the one system-wide capability
  Shotly has that survives intact.
- **OCR.** [`ocr.rs`](../src-tauri/src/ocr.rs) and `platform::text` are Vision,
  in process, no network.
- **Trimming.** [`trim.rs`](../src-tauri/src/trim.rs) is `AVMutableComposition`
  and `AVAssetExportSession` — already the in-process design the capture path
  would be moving towards.
- **The clipboard and drag-out.** `NSPasteboard` and `NSDraggingSession` are
  fine; pasteboard writes are one of the sanctioned ways out of a container.
- **The asynchronous media scheme.** [`media.rs`](../src-tauri/src/media.rs)
  needs bookmark-scoped access around its reads and is otherwise unaffected.
- **HTTPS to Google.** `network.client`, and nothing more.

---

## The one piece of good news

`CaptureBackend` ([`capture/mod.rs:118`](../src-tauri/src/capture/mod.rs#L118))
is a real seam, for the same reason it made Windows Phase 0 cheap:
`ScreencaptureCli` is an implementation of it, not the thing itself. Seven
methods — `capture_displays`, `crop`, `capture_interactive`, `capture_window`,
`capture_window_flush`, `list_windows`, `displays` — and a ScreenCaptureKit
backend is a second `impl` beside the first, selectable at build time.

That is genuinely most of the plumbing already done. It does not reach recording
(`record.rs` spawns its child directly through `platform::recorder`) or the
scrolling capture (`scroll.rs` spawns its own), and both of those should be
moved behind the same seam before anything else is attempted — that work is
worth doing whether or not the store ever happens, because it is also what the
Windows port needs.

---

## What Shotly would be, on the shelf

| Feature | Store build |
| ------- | ----------- |
| Region, window, fullscreen capture | works, on a new engine |
| Scrolling capture | works, on a new engine |
| Recording, with microphone | works, on a new engine |
| The accessibility window outline | degraded — window list, phantoms and all |
| Scroll-to-tighten | gone |
| Interact | gone |
| Backup to a cloud folder | degraded — user picks it by hand |
| Save straight to `~/Documents/Shotly` | user picks it once, then works |
| Open at login | works, via `SMAppService` |
| Global hotkeys | works, unchanged |
| OCR, trim, annotate, pin, share | works, unchanged |
| Auto-update | gone (the store does it) |
| Ventura (13.x) support | gone |

---

## The work, in order

Rough, and the first item dominates everything after it.

| # | Work | Size |
| - | ---- | ---- |
| 1 | Move recording and scrolling behind `CaptureBackend` | small — worth doing regardless |
| 2 | ScreenCaptureKit stills backend | large |
| 3 | ScreenCaptureKit recording + `AVCaptureDevice` microphone | large |
| 4 | A selection overlay to replace `screencapture -i` | medium, and it is the overlay that could wedge the machine |
| 5 | `SCShareableContent` outline; delete Interact and scroll-to-tighten | medium |
| 6 | Replace `osascript`/`open`/`qlmanage` | small |
| 7 | Security-scoped bookmarks through every path that touches the library | medium, and touches everything |
| 8 | `SMAppService`, strip the updater, turn off the private API | small |
| 9 | Entitlements, provisioning profile, `.pkg` packaging, upload script | medium — Tauri does not do this for you |
| 10 | App Store Connect metadata, privacy labels, review | small, but calendar time you do not control |

---

## The paperwork

Once the code is capable of it:

- **Apple Developer Program membership.** There is none today —
  `package.json` signs with `Shotly Local Signing`, and
  `scripts/publish.mjs` still lists that as an allowed authority.
- **Certificates**: *3rd Party Mac Developer Application* and *3rd Party Mac
  Developer Installer*, which are not the *Developer ID Application*
  certificate [`DEVELOPING.md`](DEVELOPING.md) asks for. A store build and a
  DMG build are signed by different identities.
- **A registered App ID** for `com.skuirrels.shotly`, plus a Mac App Store
  provisioning profile embedded in the bundle as
  `Contents/embedded.provisionprofile`.
- **A `.pkg`.** Tauri bundles `app` and `dmg` and neither is uploadable. The
  store path needs its own script: `codesign` the bundle with the entitlements
  below, `productbuild --component`, then `xcrun altool`/`notarytool` upload.
- **`CFBundleVersion` must increase, monotonically, forever.**
  `scripts/bump.mjs` tracks only the marketing version, and the store rejects a
  build number it has seen before — including one from a build that was later
  withdrawn.
- **`LSApplicationCategoryType`** in `Info.plist` (`bundle.category` is
  `Productivity`, which the DMG path never needed to make official).
- **App Store Connect metadata**: 1024px icon, screenshots at the required
  sizes, description, keywords, support URL, **privacy policy URL**, age
  rating, export compliance (HTTPS only — exempt, but the question must be
  answered), and **App Privacy labels**, which have to disclose the Google
  Drive sharing since it moves user content off the machine.

---

## The entitlements file that does not exist

There is no `.entitlements` anywhere in the repository today, because nothing
has ever needed one. The store build's would be roughly:

```xml
<key>com.apple.security.app-sandbox</key>                        <true/>
<key>com.apple.security.device.audio-input</key>                 <true/>
<key>com.apple.security.network.client</key>                     <true/>
<key>com.apple.security.network.server</key>                     <true/>
<key>com.apple.security.files.user-selected.read-write</key>     <true/>
<key>com.apple.security.files.bookmarks.app-scope</key>          <true/>
<key>com.apple.security.keychain-access-groups</key>
<array><string>$(TeamIdentifierPrefix)com.skuirrels.shotly</string></array>
```

`network.server` disappears if the OAuth flow moves to
`ASWebAuthenticationSession`, which it should. Note what is *not* on the list
and cannot be added: there is no entitlement for accessibility, and none for
event taps.

---

## Recommendation

Ship Developer ID.

The store asks for a rewritten capture engine, a resurrected overlay that was
deliberately deleted for hanging the machine, the loss of Interact and the good
window outline, a raised OS floor, and a permanent second release channel — in
exchange for a listing. CleanShot X, Shottr and Snagit all ship Developer ID,
and the screen-capture tools that are on the store are the ones that gave up
exactly these features to get there.

[`DEVELOPING.md`](DEVELOPING.md) already describes the alternative: join the
program, create a *Developer ID Application* certificate, store a notarytool
credential, set four environment variables, `npm run release`. No code changes,
no features lost, no review queue, and the auto-update path in
[`RELEASING.md`](RELEASING.md) keeps working.

Revisit this document if store distribution ever becomes a business requirement
rather than a preference. The order of work above still holds, and item 1 is
worth doing on its own.
