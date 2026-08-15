# Shotly

A Snagit-style capture and annotation tool for macOS, built with Tauri 2 + React.

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

The self-signed certificate below is **development scaffolding only**. It is not
in `tauri.conf.json` — `npm run bundle` supplies it via `APPLE_SIGNING_IDENTITY`,
and `npm run release` supplies the Developer ID one instead. Nothing about it
ships.

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

### Where captures are saved

⌘S writes straight into `~/Documents/Shotly` with no dialog, auto-numbering on
name collisions. ⌘⇧S opens a Save As dialog for anywhere else, and ⌘⇧R reveals
the last save in Finder.

### The library

The home screen lists everything in `~/Documents/Shotly`, newest first. Click a
card to open it full-size in the editor; ⌘L or the back arrow returns to the
library, and ⌘W closes the document first and only puts the window away from
the library (matching every other macOS app). Closing with unsaved annotations
asks once before discarding.

Cards carry Show in Finder and Move to Trash on hover — trashing goes through
Finder so it stays recoverable, and is refused for any path outside the library.

Thumbnails are generated on demand and cached in the temp directory, keyed by
path *and* mtime, so the grid paints immediately with a large library and an
edited file never shows a stale image. `list_library` itself only reads image
headers, never decoding a full file.

## Architecture

```
src-tauri/src/
  capture/
    mod.rs       CaptureBackend trait, Rect/Frame/DisplayInfo types
    cli.rs       screencapture(1) backend + TCC permission checks
    display.rs   CoreGraphics display & window enumeration
  commands.rs    the entire IPC surface
  platform.rs    AppKit escapes (overlay window level, activation policy)
  lib.rs         tray, global hotkeys, window lifecycle

src/
  design/theme.css   design tokens (dark pro palette)
  lib/keys/          shortcut parsing, matching, formatting, useKeymap
  lib/shapes.ts      geometry shared by the screen and export renderers
  lib/export.ts      Canvas2D exporter
  state/             editor store (annotations, selection, history)
  windows/editor/    editor window
  windows/overlay/   transparent selection overlay
```

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

## Status

Verified end-to-end: opening an image (⌘O or drag-drop), drawing arrows, step
badges and blur, and ⌘S export — confirmed by exporting a synthetic test card
and checking the resulting PNG's pixels landed at exactly the expected
coordinates and colours. Also verified: window/tray lifecycle, hotkeys, command
palette, shortcut sheet, permission detection and error reporting.

The selection overlay is confirmed to launch, size itself to the display, load
the frozen frames and report ready — but its **drag-to-select interaction has
not been exercised by a human yet**. It sits at screen-saver window level, which
screen-capture APIs exclude and synthetic input can't reach, so it can only be
tested by hand.

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

Not built: video/GIF recording, scrolling capture, OCR, capture library. The
capture layer is structured so video is the natural next addition.
