# Developing Shotly

Everything about the source. If you only want to *use* Shotly, the
[README](../README.md) is the one you want.

## Running it

```bash
npm run tauri dev
```

> **Note:** this machine's npm cache has root-owned files, so plain `npm install`
> fails. Until that's fixed with `sudo chown -R 501:20 ~/.npm`, install with
> `npm install --cache /tmp/npm-cache`.

### Screen Recording permission (read this before debugging capture)

macOS gates screen capture behind TCC. For an **ad-hoc signed** app — which is
what an unsigned local build is — TCC identifies the app by its *code-signing
identifier* and the binary's *cdhash*, *not* by `CFBundleIdentifier`.

Two consequences that cost real debugging time:

1. **The Settings toggle lies.** Every rebuild produces a new cdhash, so an
   existing grant stops applying — while the row in System Settings still shows
   "Shotly" switched on. The app correctly reports "no permission".
2. **macOS won't re-prompt.** A decision is already recorded for that signing
   identifier, so `CGRequestScreenCaptureAccess()` returns silently and no
   dialog appears.

**This is solved.** The app is signed with a self-signed certificate
("Shotly Local Signing", in the login keychain), set via
`bundle.macOS.signingIdentity`. That changes the designated requirement from a
per-build hash to a stable identity:

```
designated => identifier "com.skuirrels.shotly"
              and certificate root = H"760b34b6fefa9356d08025f50104c8a876814593"
```

No cdhash, so **the grant survives rebuilds** — verified by rebuilding and
confirming the cdhash changed while the requirement did not.

Always build via `npm run bundle`; it signs with that identity and re-registers
with Launch Services.

Grant the permission **once**:

1. System Settings → Privacy & Security → Screen & System Audio Recording.
2. Remove any stale **Shotly** row with **−** — old rows are bound to the
   previous ad-hoc identity and will never match again.
3. Click **+**, press ⇧⌘G, paste
   `~/Source/shotly/src-tauri/target/debug/bundle/macos/`, pick `Shotly.app`.
4. Quit Shotly completely and relaunch — macOS never applies TCC changes to a
   running process.

### Shipping it — none of the above applies to your users

The permission dance above is a **local development** problem, caused by
rebuilding an unsigned app over and over: each rebuild changed its identity, so
macOS stopped recognising it. A released app is built once and its identity
never changes, so none of it happens.

What a user actually does: download the DMG, drag Shotly to Applications, launch
it, press ⌃⇧4, and click **Allow** on one system prompt. That's it — the same
as CleanShot X or Snagit. They never open System Settings, never remove a row,
never relaunch.

To produce that build:

1. **Join the Apple Developer Program** ($99/yr). An "Apple Development"
   certificate is not enough — shipping outside the App Store needs a
   **Developer ID Application** certificate. Create it in Xcode under
   Settings → Accounts → Manage Certificates, or on the developer portal.
2. **Store a notarization credential once:**

   ```bash
   xcrun notarytool store-credentials shotly \
     --apple-id "you@example.com" --team-id "TEAMID" \
     --password "app-specific-password"   # appleid.apple.com, not your real one
   ```

3. **Build.** Tauri signs, notarizes and staples in one step when these are set:

   ```bash
   export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
   export APPLE_ID="you@example.com"
   export APPLE_PASSWORD="app-specific-password"
   export APPLE_TEAM_ID="TEAMID"
   npm run release
   ```

   Output: a signed, notarized `Shotly.dmg` in
   `src-tauri/target/release/bundle/dmg/`.

Without notarization the app still runs, but Gatekeeper shows a scary
"cannot be opened because the developer cannot be verified" warning, and users
have to right-click → Open. Notarization removes that.

Until that certificate exists, `npm run release` falls back to the self-signed
one below, and the published DMG carries the Gatekeeper warning. Setting
`APPLE_SIGNING_IDENTITY` in the environment overrides the fallback:

```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" npm run release
```

Note that **switching identities breaks Screen Recording for everyone already
running Shotly**, because the app updates itself in place and macOS ties that
grant to the signing certificate. It is worth doing once, deliberately, with a
note in the release notes — see [docs/RELEASING.md](docs/RELEASING.md), which
also covers the update manifest and the minisign key that signs it.

### Recreating the development signing certificate

The identity lives in the login keychain; export a `.p12` backup from Keychain
Access if you need it on another machine. To recreate from scratch:

```bash
openssl req -x509 -newkey rsa:2048 -sha256 -days 7300 -nodes \
  -keyout k.key -out c.crt -subj "/CN=Shotly Local Signing/O=Shotly/C=GB" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning"

# macOS cannot read OpenSSL 3's default PKCS#12 MAC — force the legacy algorithms.
openssl pkcs12 -export -macalg sha1 -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES \
  -inkey k.key -in c.crt -name "Shotly Local Signing" -out c.p12 -passout pass:PW

security import c.p12 -k ~/Library/Keychains/login.keychain-db -P PW -T /usr/bin/codesign
security add-trusted-cert -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db c.crt
```

Changing the certificate changes the designated requirement, which invalidates
the TCC grant — you would need to re-add the app in System Settings.

### Updating

Shotly checks for a newer release shortly after launch and every six hours
after that, downloads and installs it in the background, and offers a relaunch
when it is ready. The tray's **Check for Updates…** does the same on demand and
reports the result either way. Payloads are verified against a minisign public
key compiled into the app, so a compromised GitHub release cannot push code to
anyone.

Cutting a release is `npm run bump -- <version>`, commit, push, then
`npm run publish`. The full contract — including what the publish script
refuses to do and why — is in [docs/RELEASING.md](docs/RELEASING.md).

## Architecture

```
src-tauri/src/
  capture/
    mod.rs       CaptureBackend trait, Rect/Frame/DisplayInfo types
    cli.rs       screencapture(1) backend + TCC permission checks
    display.rs   CoreGraphics display & window enumeration
  annotate.rs    the live screen-drawing layer, and its safety machinery
  commands.rs    the bulk of the IPC surface
  hotkeys.rs     the system-wide keys: storage, live rebinding, dispatch
  markup.rs      the shTL PNG chunk that keeps a saved capture editable
  ocr.rs         text and QR/barcode recognition, via macOS Vision
  pin.rs         always-on-top pin windows
  scroll.rs      scrolling capture: session loop and the row-signature stitcher
  combine.rs     several captures composed onto one sheet
  platform.rs    AppKit escapes (window level, activation policy)
  update.rs      the self-updater
  lib.rs         tray, menu, window lifecycle, hotkey dispatch

src/
  design/theme.css   design tokens (dark pro palette)
  lib/keys/          shortcut parsing, matching, formatting, useKeymap
  lib/shapes.ts      geometry shared by the screen and export renderers
  lib/export.ts      Canvas2D exporter
  lib/overlay.ts     placing and resizing pasted images
  state/             editor store (annotations, selection, history)
  windows/editor/    editor and library window
  windows/annotate/  the live screen-drawing layer
  windows/pin/       one pinned capture
  windows/scroll/    scrolling capture: region selection, then the HUD
```

Three windows, three HTML entry points (`index.html`, `annotate.html`,
`pin.html`), all listed in `vite.config.ts`. Each also needs an entry in
`src-tauri/capabilities/` — Tauri v2 grants permissions **per window label**,
and a window that isn't named there can call the app's own commands but not a
single core API. That is not an obvious failure: it looks exactly like a bug in
whatever you just wrote. Pins are matched by the glob `pin-*`.

### Two renderers, one geometry

Annotations draw as **SVG** on screen (crisp at any zoom, free hit-testing,
DOM-addressable handles) and as **Canvas2D** on export (no canvas tainting, real
`blur()` filters). Both compute shapes from `lib/shapes.ts`, so the exported PNG
matches the preview.

### Capture pipeline

The selection overlay never captures anything itself. On hotkey, Rust freezes
every display to PNG, hides the editor so Shotly stays out of its own shot, and
hands the frames to the overlay, which paints them as a frozen backdrop. The
final image is **cropped from that freeze-frame**, so you get exactly the pixels
you saw. A selection spanning two displays is composited at the higher scale
factor.

`CaptureBackend` is a trait — a ScreenCaptureKit implementation (needed for
video) drops in behind it without touching the rest of the app.

### Keyboard

`src/windows/editor/EditorApp.tsx` holds one command registry that is the single
source of truth for key bindings, toolbar tooltips, the ⌘K palette, and the ⌘/
cheat sheet. Adding a command wires up all four.

Global hotkeys are on **Ctrl**+Shift+3/4/5 rather than Cmd+Shift, because macOS
already owns the Cmd variants for its own screenshot tools.

## Two keys that cannot be tested from a script

Worth knowing before you go hunting for a bug that isn't there.

**Escape.** WKWebView keeps it, and under injected input it never reaches the
page at all. Both the annotation layer and the pins treat Escape as a way out,
and both carry a second one that *can* be exercised — ⌃⇧A and ⌘W. If you change
that code, test Escape by hand.

**Native window drags.** `data-tauri-drag-region` and `startDragging()` hand the
window to AppKit's drag loop, which follows the hardware cursor. Nothing
synthetic drives it. The pins therefore move themselves with `setPosition`,
which behaves the same for a user and can actually be verified.

### Selection uses macOS, not a custom overlay — read before changing it

Region and window selection go through `screencapture -i`. Shotly hides its own
window, hands selection to the system crosshair, and opens whatever comes back.

This replaced a custom transparent overlay window, which was **removed
entirely** — the window is no longer even declared in `tauri.conf.json`. That
overlay was full-screen, always-on-top and click-swallowing, so any failure to
paint made the whole desktop unusable, with force-quitting Shotly the only way
out. It did that three separate times. The system selector cannot wedge the
machine, gets Retina and multi-display right, and users already know it.

What was given up: the custom magnifier loupe, the live dimensions HUD, and
arrow-key adjustment of an armed selection. Worth it for a tool that can't brick
the screen. `OverlayApp.tsx` was deleted; the git history has it if the custom
overlay is ever revisited — but read the section below first.

`screencapture -i` blocks until the user finishes, so it runs on its own thread.
Blocking the main thread there would freeze the event loop, because the global
shortcut handler calls it from the main thread.

### Why the custom overlay failed (kept as a warning)

A hidden `WKWebView` suspends and stops running JavaScript. That single fact
broke this window twice:

1. **Waiting for it to report ready before showing it** deadlocked — it was
   hidden, so it never ran, so it never reported.
2. **Showing it before it painted** put a full-screen, invisible,
   click-swallowing window over the desktop. When it failed to paint, the only
   escape was force-quitting Shotly.

The working design: the overlay window is **never hidden**. When idle it is
*parked* — 1x1, moved below the virtual desktop, and mouse-transparent. Its page
therefore stays alive and always has a session listener registered.

Invariants that keep an unusable desktop impossible. Don't remove any of them:

- `set_ignore_cursor_events(true)` whenever there is no painted session. Only
  `overlay_ready` clears it, and only after the page has drawn.
- `overlay_ready` is ignored when no session is pending, so a late report can't
  resurrect an empty overlay.
- A 2.5s watchdog parks the overlay and restores the editor if it never reports.
- Every failure path after the editor is concealed calls `reveal_editor`, or the
  app is left running with no window at all.
- A capture hotkey pressed during a live selection cancels it, giving a
  system-wide way out that doesn't depend on the overlay's own key handler. It
  keys off the `overlay_live` flag, never window visibility — otherwise a
  stuck-visible window turns the hotkey into a permanent no-op.

### Why the window-picker outline was removed (kept as a warning)

Window capture used to draw a red outline around whatever `screencapture -i -w`
was about to take, read from `CGWindowListCopyWindowInfo`: topmost layer-0
window whose bounds contain the cursor.

That list is not a list of what is on the screen. Measured on a real desktop, a
full-screen window ranked *second from front* — opaque, `kCGWindowIsOnscreen`
true, owning application not hidden — was not being composited at all: its own
pixels differed from the screen at its bounds by a mean of 45/255. So the
outline confidently framed a window the user could not see, which is exactly
what it was reported as doing.

Nothing separates the two cases:

- Every key in the window dictionary matches a genuine window — layer, alpha,
  `kCGWindowIsOnscreen`, `kCGWindowStoreType`, `kCGWindowSharingState`.
- `NSRunningApplication.isHidden` is false for both.
- Comparing the window's image against the screen would settle it, but
  `CGWindowListCreateImage` was obsoleted in macOS 15, and — decisively — the
  screen cannot be sampled during a picker session at all, because
  `screencapture -i -w` puts a full-screen sheet of its own in front of
  everything for the duration.

An outline that can point at a window that is not there is worse than no
outline: macOS draws its own highlight, and ours could contradict it. If a
truthful one is ever wanted, it needs Shotly to own window selection too — a
list or grid of windows with live thumbnails, captured by id through the
existing `list_windows` and `capture_window`, where a phantom shows itself for
what it is because its thumbnail does not match anything on screen.

## Not built yet

Video and GIF recording. The capture layer is a trait, so a ScreenCaptureKit
backend for video drops in behind it without touching the rest of the app.
