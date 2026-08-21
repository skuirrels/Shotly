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

   Output: a signed, notarized `Shotly_<version>_aarch64.dmg` in
   `src-tauri/target/release/bundle/dmg/`. `npm run publish` uploads a copy of
   it named `Shotly.dmg`, so that the README's download link never goes stale.

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
  share/         sending one capture to someone, as a link
    mod.rs       the Provider trait, the registry, and the commands
    google.rs    Google Drive: find the folder, upload, set the permission
    gauth.rs     signing in to Google — OAuth for the provider above
  media.rs       serving a recording to the player, off the main thread
  record.rs      screen recording: what to record, and the child that records it
  trim.rs        marks on a timeline -> the parts of a recording to keep
  compose.rs     writing those parts out as one movie, losslessly
  scroll.rs      scrolling capture: session loop and the row-signature stitcher
  combine.rs     several captures composed onto one sheet
  platform.rs    AppKit escapes (window level, activation policy, capture hiding)
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

A rectangle's corners are the newest thing to live there. `rectRadius` decides
them for both renderers: it clamps the setting to half the shorter side, hands
neon its own lozenge radius instead, and reads markup that predates the setting
as the fixed 4px those rectangles were always drawn with — reading the missing
field as the new default of 0 would reopen someone's saved work with different
corners.

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

They are the user's to change, in **Settings → Hotkeys** — `GlobalHotkeys.tsx`
recording the combination, `hotkeys.rs` registering it and writing it to
`hotkeys.json` in the app config directory. The tray and the Shotly menu both
open that tab through `request_settings`, because the editor window is usually
hidden and its ⌘, cannot be pressed from a window you cannot see. Both menu
items land in the tray's `on_menu_event`: Tauri hands every menu event to every
registered listener, app menu and tray alike.

The ⌘/ sheet lists the global hotkeys read-only and links here. Two panels that
can both record the same key is one panel too many.

**A hotkey handler must not touch the hotkey registry.** The global-shortcut
plugin holds its own registry lock across the whole of the handler you give it,
so anything reached from in there that registers or unregisters a shortcut asks
for a mutex that same thread already holds. On macOS that thread is the *main*
one — the handler is a Carbon callback running inside `[NSApplication
sendEvent:]` — so what stops is not the feature but the entire application: no
drawing, no menu bar, no tray, force-quit only.

That is what the second press of ⌃⇧A did. It reached `annotate::stop`, which
hands Escape back. `hold_escape` now posts to a queue that one thread of its own
drains, which both breaks the cycle and keeps borrow and return in order.

Note the shape of the trap, because the obvious fix is the wrong one: moving the
*whole* handler off the main thread trades a deadlock for a crash. Starting the
annotation layer calls `setCollectionBehavior` on the NSWindow, and AppKit traps
on the spot when that is called from anywhere but the main thread. Window work
belongs there; only the registry call has to leave.

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
outline: macOS draws its own highlight, and ours could contradict it. Window
capture went through `WindowPicker` instead — a grid of windows with live
thumbnails, captured by id — where a phantom shows itself for what it is
because its picture matches nothing you recognise.

The outline is back, and — this is the correction — from the same window list
it was taken from before. The window list was never the problem. Asking it
without filtering it was. See below.

Two things that cost an afternoon to learn, both worth keeping:

- **Full-screen windows sit at layer 1000**, not 0. `is_target` accepted only
  layer 0, so a full-screen app was missing from the list — and since a desktop
  where everything is full screen has *no* layer-0 windows, the picker came back
  empty with nothing to say for itself.
- **A full-screen window cannot be captured by id at all.** `screencapture -l`
  returns its drop shadow and a completely transparent middle, whichever Space
  is active. Measured: centre alpha 0 against 255 for an ordinary window. The
  picker lists such windows and says so, rather than offering an empty frame.

### The outline that does work: a filtered window list (`snap.rs`)

**How Snagit actually does it**, checked against the shipped binaries rather
than guessed at. This section previously claimed the highlight came from
`AXUIElementCopyElementAtPosition`. That was wrong, and it cost a release: it
put window capture behind an Accessibility prompt it never needed, and users who
declined got a grid of thumbnails instead of a highlight.

In `Snagit.app/Contents/Frameworks/SnagitCommon.framework/…/TSCRegionSelection`:

- The window under the pointer is `getWindowInfoForPoint:`, `idOfWindowAtPoint:`
  and `hitTestWindowInfo:atPoint:` on a `WindowInfo` class, over
  `CGWindowListCopyWindowInfo` and `getShareableContentExcludingDesktopWindows:
  onScreenWindowsOnly:` — the window list, hit-tested.
- Phantoms are handled by filtering, not by changing source: `isIgnoredWindow`,
  `isIgnoredWindow:`, `findOverlayWindows`.
- The AX imports *are* there, but read the neighbours: `canScrollForScrollBarElement:`,
  `getCurrentScrollableUIElementAtPoint:`, `scrollAreaForExcelWithElement:`,
  `scrollAreaForWordWithElement:`, `scrollAreaForXcodeWithElement:`. That is
  scrolling capture, plus an optional `disableSubWindowSelection` mode for
  drilling inside a window. Not the highlight.

`Snagit` itself imports only `AXIsProcessTrustedWithOptions`, and
`TSCRegionSelection` uses the silent `AXIsProcessTrusted` — it checks, and
carries on either way.

So Shotly does the same. `Stack::take` snapshots the window list once per
session (nothing can move while the tap holds the mouse) and keeps only what can
be pointed at; `Stack::hit` returns the first window whose frame holds the
point, the list already being ordered front to back. **No permission beyond
Screen Recording.**

The filter is the load-bearing part, and the entry that matters most is the one
this feature died of twice: **drop full-screen windows.** A full-screen window
sits at layer 1000 above everything, covers the display, and macOS reports it as
on screen even when it is on another Space. Measured on this desktop — the
window list's first entry was `layer=1000 0,0 1512x982 Claude`, on a Space that
was not showing — so keeping it means every hit test answers with that window
wherever the pointer goes. Note this is the *opposite* of what the picker wants,
which is why the two filters differ: `is_target` keeps full-screen windows so the
picker can list them and explain they cannot be captured by id, and
`is_pointable` throws them away.

Accessibility is now optional and buys the levels *inside* the window: where
its contents begin, which the outline picks on its own (below), and the toolbar
or single row the wheel steps down onto. `Stack::chain_at` asks `ax::trusted()`
and skips it in silence when it is not granted.

**The property the whole design rests on.** A window that ignores mouse events
is invisible to accessibility hit-testing; one that accepts them is not.
Measured: a floating, `ignoresMouseEvents` overlay placed over another
application's window, probed at its own centre, returned the window *underneath*.
Setting `ignoresMouseEvents = false` on the same overlay changed the answer to
error −25208. So the outline can be drawn over its own target without poisoning
the hit test that positions it — but nothing that accepts a click may ever be
put on screen, which is why the click is taken by a `CGEventTap` instead.

**Ancestry is mostly noise.** At one point inside a web-based application the
raw chain was 24 elements deep, 21 of which had an identical frame. `refine`
drops anything that duplicates the frame outside it, is too small to aim at, or
does not actually contain the pointer — leaving 6 levels worth scrolling
through. The walk also could not reach `AXWindow` within 24 steps at all, which
is why `ax::chain_at` asks for the window directly and puts it at the front
rather than hoping to arrive at it. `Stack::chain_at` now discards that window
and uses the one from the list, so the outline and the captured `CGWindowID`
cannot disagree — but the note stands for anyone tempted to walk upwards.

**Two failures worth not repeating**, both of which made a working feature look
like a broken Mac:

- **Never cache a failed hit test.** For an instant after the overlay is created
  it is still hit-testable, so the first probe of a session can fail. The
  tracker skips ticks where the pointer has not moved — and caching that first
  failure meant a pointer that then never moved left a dimmed screen with no
  outline on it, while the tap swallowed every click. The skip is now only taken
  while something is actually being shown.
- **The tap must not start before the outline is visible.** It is created in
  `snap_ready` and nowhere else. Swallowing clicks is only defensible while the
  user can see what a click would take, so the dangerous half of the feature is
  made to depend on the visible half.

- **Each overlay must listen for its own events.** There is one page per
  display, and each is sent the same event carrying that display's own
  coordinates — but the plain `listen` from `@tauri-apps/api/event` registers
  against *any* target, so every page received every emit and drew whichever
  arrived last. On two screens that meant the outline only ever appeared on one
  of them: the other spent the session drawing its neighbour's rectangle, far
  off its own edge, leaving a dimmed screen with nothing on it and a capture
  that looked broken. `getCurrentWebviewWindow().listen` is scoped to the page
  it is called from, and is what makes `emit_to(label, …)` mean anything.

- **Never ask accessibility about a point when you already know the window.**
  `window_children` looks the window up by process and frame instead of
  hit-testing the pointer, and the reason is measured: with Shotly's editor
  hidden for the capture but still lying under the pointer, a hit test *from
  inside Shotly* comes back as Shotly's own window, while the same test run
  from any other process comes back as the window underneath. Nothing about
  the desktop is different; the caller is. The window list has already decided
  which window is meant — front to back, with Shotly's own filtered out — so
  asking the point again can only introduce a second opinion.

Related: the first target is routinely resolved before the page has finished
loading, so the first `emit_to` goes nowhere. `snap_ready` re-sends the current
outline for exactly that reason.

### Cutting the toolbars off (`ax::content_top`)

Pointing at a window used to mean capturing all of it, ribbon and title bar
included, and cropping that off afterwards is the tax the all-in-one capture
exists to remove. So the outline works out where a window's *contents* begin
and frames those instead — unless the pointer is up on the toolbars, in which
case pointing at them means what it says and the whole window is framed. The
wheel still overrides both: one step up from the contents is the window.

**The rule is geometric, not a list of roles**, because roles are whatever an
application decided to call things. Measured on this desktop: Word's ribbon is
an `AXTabGroup` described as "ribbon", Mail's and Messages' are `AXToolbar`,
and Excel puts an `AXUnknown` under both for the formula bar. What they have in
common is shape — full width, far too short to be the content, stacked at the
top — so `content_top` walks down from the window's top edge, and anything
reaching the current line that spans the window and is short enough moves the
line to its own bottom. Word: 40pt of title bar plus 105pt of ribbon, cut at
137pt of a 1068pt window, which is the same rectangle Snagit frames. A window
that declares nothing useful (Spotify draws its own chrome inside one
`AXGroup`) is left whole, and so is one where the arithmetic would take more
than half the window.

**Chrome answers none of this**, which is what `edges` is for — see below.
Measured on Chrome 151: every accessibility question about the browser —
`AXRole`, `AXWindows`, a hit test over its own tab strip, even *setting*
`AXManualAccessibility` — comes back `kAXErrorAPIDisabled` (−25211), to any
client, trusted or not. Nothing Shotly can do from outside changes it. Native
applications, the Office suite, Mail, Messages and Finder all answer normally.

**The band is deliberately not a window.** `contents` builds a node with
`window: false`, so the capture comes off the screen rather than out of the
window's own backing store — which would hand back the ribbon this exists to
remove.

### When the application will not say (`edges.rs`)

An application that refuses the accessibility API is not an application with
nothing above its contents, and `Bands` keeps those two apart: `Asked::Answer`
is a settled answer, `Asked::Looking` is a window being read off the screen
instead. Only the second ever reaches `edges`.

**A reply is not a description**, and the gate has to know the difference.
Chrome refuses everyone — until it doesn't: querying a Chromium process long
enough switches its accessibility tree on, and Shotly does exactly that, every
tick, for as long as a session runs. What it then answers with is four
children: one `AXGroup` whose frame is the window's frame to the pixel, and the
three 16x16 buttons that close, minimise and zoom it. The window restated, and
its traffic lights.

That is worse than silence. `ax::content_top` correctly finds no chrome in it,
`Bands` reads that as *this window has nothing above its contents*, marks it
`Asked::Answer(None)` — and the pixel fallback, which had been reading those
windows correctly, never runs again for that window. The trim simply
disappears, on the windows it was written for, some minutes into using the app.

`ax::describes_window` is the guard: a child counts only if it is a real
division of the window — at least half its width, at least `MIN_CHROME` tall,
and not simply the window handed back. Nothing qualifying means nothing was
said, `ask` returns the bare `None`, and the window reaches the pixels through
the same three tries an application that is merely busy gets. Structural rather
than a check for Chrome, because a Chromium shell is this shape wherever it
turns up.

The rule there is that window chrome is a stack of full-width strips, so the
boundary is the **last full-width horizontal step** inside the top of the
window — a step, not a line, because the colour has to differ above and below.
That single condition is what separates a toolbar's lower edge from a
spreadsheet gridline or a row of text, which also cross the whole window but
leave the same colour on both sides.

**"Inside the top" is the load-bearing half.** A site with a header band of its
own — GitHub's navigation, an app's coloured title bar — is one more full-width
strip as far as pixels are concerned, and *last* will happily walk into it. The
ceiling is what stops that, and it is set by the only population that reaches
this code: browsers, because everything else answers accessibility. Chromium's
tab strip and toolbar come to 87pt and a bookmarks bar adds about 33pt, so
`MAX_CUT` is **130pt** — over the tallest real browser chrome, under where a
site's header tends to end. It was 200pt until a Chrome window over a GitHub
pull request cut at 141.5pt, below the repository nav, where the answer was 87.
Two Chrome windows showing different sites both measure 87pt with the ceiling
in place. `stops_at_the_browser_and_not_inside_the_page` holds that profile.

**Why it is safe to ship a heuristic.** Measured across a desktop of windows,
it is right on Chrome (87pt, the browser chrome exactly), a terminal (the tab
bar) and Spotify (58pt, its top nav), and wrong on Excel, where it lands in the
grid instead of under the ribbon. Excel never reaches it — Excel answers
accessibility, and answers correctly. **Every window the rule gets wrong is a
window that never asks it**, which is the entire argument for the gate.

**Cost**: one `capture_window_flush` and a PNG decode, measured at ~230ms, so it
runs on a thread of its own and the answer arrives a beat after the pointer
does. Until it lands the outline frames the whole window — never wrong, briefly
less specific. `flush` matters: with the drop shadow on, the image is inset on
every side, and unevenly, so a row of pixels would not be a point on screen.

**How Snagit does it, as far as can be told.** The behaviour was worth copying
because Snagit has it, so the mechanism was worth finding. It is not
accessibility (Chrome refuses everyone), not Apple Events — those exist in
`SnagitHelper`, running `execute javascript "document.title = window.innerHeight"`
through the tab's title, but that is scrolling capture and needs a permission
prompt plus Chrome's *Allow JavaScript from Apple Events*, which is off — and
not a private API or an extension, neither of which is in the bundle. What
`TSCRegionSelection` does link is ScreenCaptureKit and `CGBitmapContext`: it
rasterises screen content while you hover. And Snagit's own capture history on
this machine holds thirteen Chrome captures at 2048×981 from a 2048×1068
window — **87pt trimmed, the same figure `edges` arrives at on the same
window**. So: pixels, almost certainly, and the same pixels.

## Screen recording (`record.rs`)

`screencapture -v` does the recording, for the same reasons the stills go
through the same binary — and one more: it needs no permission Shotly does not
already hold, where a ScreenCaptureKit pipeline would mean owning an
`AVAssetWriter`, a frame clock and every codec decision. The three targets are
one flag each: `-R x,y,w,h` for an area, `-l <windowid>` for a window (it
follows the window and excludes anything in front of it), `-D <n>` for a
display.

Four things about it are worth knowing before changing any of it.

**Sound is one flag and one permission.** `-g` puts the default input device
on the movie's audio track, which is the microphone and only the microphone —
what the Mac is *playing* is not on offer from this binary at any price, and
getting it means the owned ScreenCaptureKit pipeline the paragraph above exists
to avoid. So every string in the UI says "microphone" rather than "audio", and
Settings says outright what is not included. That is a promise the code can
keep; "record audio" is not.

The permission is the interesting half. `screencapture` is a child process, but
macOS attributes its microphone access to whoever is *responsible* for it —
Shotly — which is why `NSMicrophoneUsageDescription` lives in Shotly's
`Info.plist` and not anywhere nearer the recording. This was confirmed the hard
way while building the feature: running `screencapture -g` from a shell raised
the prompt against the terminal's app, named it, and quoted *its* usage
description.

Three places carry the switch, and the third one is not redundancy. The
recording overlay has it because that is the moment the question is being
asked; Settings has it because that is where switches live; and the **tray**
has it because the menu bar is the one way in that never shows the overlay —
*Record Whole Screen* starts the instant it is chosen, so without a tick in
that menu there is no way to ask for sound on that path at all. All three read
and write one file, so there is one answer to what the switch means.

Two consequences shape `platform::microphone`. The prompt is raised when the
switch is turned on, never at the shutter — a permission dialog that arrives a
second into a recording is a dialog sitting on top of the thing being recorded,
to be answered while the clock runs. And `start()` re-checks access rather than
trusting the switch: wanting the microphone and being allowed it are different
facts, so the panel's microphone glyph reflects what is actually being recorded.
A recording that is quietly silent is worse than one that plainly has no sound.

Whether `-g` reaches the command line is asserted in `platform/macos/recorder.rs`
rather than tested by hand: it is decided three layers up, it decides whether a
recording has sound at all, and the only way to see it on a running child is to
read another process's argv.

**SIGINT is how a recording ends, not how it is aborted.** `screencapture`
catches it and writes the movie's index; a `SIGKILL` leaves a file with frames
in it that nothing will play. `finish()` therefore interrupts, then waits up to
twenty seconds. There is one test for this and it is `#[ignore]`d because it
records the screen for two seconds — run it by hand after touching how the
recorder is started or stopped:

```bash
cargo test --lib -- --ignored interrupting
```

**A dead panel saves the recording; it does not cancel it.** This is the one
place the watchdog does the opposite of everywhere else in the app. Before the
shutter opens, an overlay that stopped answering is a full-screen click target
and gets removed. Once recording, the movie is being written by a process that
does not care whether anyone is watching, and the panel is only a way to stop
it — so silence means *save what you have*. The same reasoning covers quitting:
`RunEvent::Exit` calls `record::wrap_up`, or the child outlives Shotly and
records until the machine is turned off.

**The panel is invisible to the recording**, via `NSWindowSharingNone` — see
`platform::hide_from_capture`. That is what lets it sit over the display it is
recording rather than having to dodge the region the way the scrolling-capture
HUD does.

**The page asks for its phase; it does not wait to be told.** Recording the
whole screen opens a window that is a panel from birth and says so
milliseconds before the page exists to hear it. Relying on that event put the
full-screen selection overlay inside a 232-point window — a clipped prompt with
nothing pressable, over a recording that had already started. `record_phase` is
the pull; the event still covers the overlay-becomes-panel handover, where the
page is very much alive.

The editor is hidden for the whole recording — it would otherwise be *in* it —
so saving presents it again (`commands::present_editor`) and the toast has
somewhere to land. Without that the feature was indistinguishable from one that
does nothing at all, which is exactly how it was reported.

### Movies in the library (`video.rs`)

Recordings are listed beside the captures. Two things the image crate cannot
answer, both handled without a new dependency:

* **Size and duration** are read from the file's own `moov` atom — `mvhd` for
  the running time, the first `trak`'s `tkhd` for the display size. Only atom
  headers are read on the way there, which matters when the file is a hundred
  megabytes and the library lists it on every refresh. The `tkhd` field offsets
  are the part to get right: the first attempt was four bytes out, the synthetic
  test agreed with the mistake, and a real movie was what caught it. That test
  now spells the layout out.
* **The poster frame** comes from `qlmanage -t`, so it is the same picture
  Finder shows, at the size asked for, with no codec decisions of ours. It
  lands in the same mtime-keyed thumbnail cache as everything else, so it is
  generated once per recording — and once more, in the background, the moment a
  recording is saved, because the next thing that happens is usually the grid
  opening.

  **`library_thumbnail` is `async` and that is load-bearing.** A synchronous
  `#[tauri::command]` runs on the main thread — see the `Blocking` default in
  tauri-macros' `wrapper.rs` — and this one shells out to QuickLook, measured at
  3.1 seconds the first time after login. The library asks for one per card as
  the editor opens, so with a recording in the library that was a frozen
  interface on every launch, reported as "hangs on startup". The work now goes
  through `spawn_blocking`, and `qlmanage` itself is given a deadline and killed
  if it overruns: it is somebody else's process, backed by a daemon, and a
  thumbnail is not worth waiting on for ever.

The recents rail filters movies out. It sits beside the editor and every row in
it is one click from being annotated; a row that cannot do that reads as broken.

### Playing one (`Player.tsx`)

Double-clicking a recording opens it in a third pane beside the editor and the
library — a plain `<video>` element pointed at `convertFileSrc(path)`, so the
file is streamed off disk by Tauri's asset protocol, which answers range
requests in one-megabyte slices. A three-hundred-megabyte recording therefore
starts at once and is never held in memory; nothing new was added to the Rust
side for any of this.

**Two lines in `tauri.conf.json` are what make it work, and both are easy to
lose in a merge:**

* `media-src 'self' asset: http://asset.localhost blob:` in the CSP. Without
  it `default-src` applies, the movie is refused, and the element fires
  `error` — which shows the "can't play this one" fallback rather than a black
  rectangle, so the symptom is quiet.
* `$DOCUMENT/Shotly/**` in `assetProtocol.scope`. The capture folder and
  nothing else: `$DOCUMENT/**` would hand the webview every document on the
  machine to satisfy one directory. The scope's first path component is
  resolved against `document_dir()`, the same call `commands::library_dir`
  makes, so the two cannot drift.

Everything else is in the component:

* The library's poster frame is the `poster` attribute, so the first frame is
  on screen before the movie has decoded anything.
* The mute button only appears when `audioTracks` is non-empty — a mute button
  for silence is a control that does nothing. Shotly's own recordings only have
  a track when the microphone switch was on for them, so the button comes and
  goes by itself and needs to know nothing about that switch.
* **The editor's keymap keeps its ⌘ shortcuts here and gives up the rest.**
  Space, the arrows and Home/End mean something in both maps, and leaving both
  live meant an arrow seeking the movie *and* nudging an annotation in the pane
  behind it. But the fix for that used to be switching the whole map off, which
  was much too much: opening a recording quietly killed ⌘K, ⇧⌘R, ⌘, and every
  other shortcut in the app until the movie was closed again. The division is
  the one the player's own handler already makes — it returns early on anything
  with ⌘ on it — and the one macOS makes between a view's keys and the menu
  bar's. Two exceptions, ⌘W and ⌘L, are answered by the player itself and are
  filtered out by name; without that they would close the movie and the
  document under it in one keystroke.
* `harness/player.html` runs the whole pane in a browser against a generated
  test clip. What it cannot reach is the asset protocol, which is exactly the
  half that the two config lines above govern — check that in the app.

### Trimming and cutting (`trim.rs`, `compose.rs`, `TrimBar.tsx`)

The scissors in the transport turns the scrubber into a selection: a green
handle where the selection starts, a red one where it ends. Snagit's shape,
deliberately — it is a control people arrive already knowing, and the colours
are half of why. `I` and `O` set a mark at the playhead without moving the
picture; dragging a handle *does* move the picture, so you are always looking
at the frame you are about to cut on.

Two modes, and the track shows the difference rather than describing it —
whichever stretches survive are lit, the rest are dimmed:

* **Keep** throws away everything outside the marks. The dead air at each end.
* **Cut out** throws away everything between them and closes the gap. The
  doorbell, the notification, the minute spent hunting for a menu.

Underneath they are the same operation. `trim::plan` turns a mode and two marks
into a list of the parts worth keeping — one part for a keep, two for a cut —
and `compose::write` lays that list into an `AVMutableComposition` and exports
it. Everything that can go wrong with a selection (marks crossed, a selection
of nothing, one that is the whole recording, a cut that would leave nothing
behind) is decided in `plan`, which needs no file on disk to test.

**Why AVFoundation and not a subprocess.** The first version was
`/usr/bin/avconvert --start --duration`, in the spirit of `screencapture` and
`qlmanage`, and for one span it was exactly right. A cut is where that runs
out: `avconvert` writes one span per run, and macOS ships no command that will
join two movies back together. The join has to happen in-process, and once
there is a composition it holds one segment as easily as two — so the converter
had nothing left to do. What that bought besides the cut: no child process to
supervise, real progress to report, and errors that say what went wrong instead
of dumping a usage screen on stderr.

**Why it stays lossless.** `AVAssetExportPresetPassthrough` copies the sample
data rather than decoding and re-encoding it, so a cut costs about what copying
the file costs and the pixels are the ones that were recorded. It stays
frame-accurate because the composition's segments carry edit lists: the copied
data can only begin at a sync sample, but playback starts at the instant asked
for. Joining is safe for the same reason it is fast — both segments come from
one asset, so they are the same codec at the same size and there is no format
negotiation to get wrong.

**The original is never overwritten.** The result lands as `<name> trimmed` and
the player switches onto it. A screenshot can be taken again; thirty seconds of
something happening on screen cannot. One suffix for both modes, so shortening
a shortened recording gives `X trimmed (2)` rather than `X trimmed cut trimmed`.

#### Why a cut resumes later than you asked

Passthrough copies samples rather than re-encoding them, so the samples of a
segment that starts anywhere but time zero are copied **from the previous sync
sample onwards** — the first frame cannot be decoded otherwise — and the run-up
is hidden behind an edit list rather than deleted. Measured on a real recording:
cutting 4s out of the middle left **0.92 seconds of the cut footage in the
file**, invisible in QuickTime, Safari, Chrome and Drive, and recoverable with
`ffmpeg -ignore_editlist 1`.

Snapping the segment onto a sync sample does **not** fix it, which was worth
finding out the hard way. AVFoundation copies from the sync sample *before* the
one a segment starts on, even when the segment starts exactly on one — measured,
a segment beginning at 8.120 (itself a keyframe) had its media copied from
7.085, the keyframe before it. The hidden run-up therefore always ends exactly
at the segment start, which is exactly the edge of what was removed. Its
position relative to the segment cannot be argued with; only the segment start
can be moved.

Measured precisely, the copied media starts **one frame before** that keyframe —
1.02, 0.87 and 0.96 frames across three cuts on two recordings. So the run-up
begins somewhere inside the keyframe interval *before* the resume point. Naming
the first keyframe at or after the mark k0, and the next two k1 and k2:

* Resuming at **k1** puts the run-up inside `k0-1 .. k0`, which is before the
  mark. Measured: marking 7.103 — itself a keyframe — left 15 ms of the marked
  footage in the file. A one-step rule looks right on paper and leaks.
* Resuming at **k2** puts it inside `k0 .. k1`. A sample cannot begin before the
  keyframe preceding it, so the run-up cannot begin before k0, and k0 is at or
  after the mark. That is an argument rather than a measurement, and it holds at
  any frame rate — a guard of "one frame" would have worked on these recordings
  and quietly failed on a slower one.

Verified on both recordings, four marks including one sitting exactly on a
keyframe: every run-up lands clear of its mark, with 1.0–2.2 s to spare.

It costs up to three keyframe intervals — about three seconds, since
`screencapture -v` writes a keyframe a second — so the player draws the real
extent rather than the mark.

The overshoot is drawn as its own **striped** stretch rather than folded into
the removal band. Drawn as one flat band, the red handle sat in the middle of
it as the edge of nothing, which reads as a bug rather than as rounding — it
was reported as one. Handle to handle is solid, handle to resume point is
striped, and each handle is the edge of something again.

#### Or don't round at all: `Precision::Exact`

The rounding is only needed because passthrough copies compressed samples. Ask
`compose` to encode the frames again and the whole problem goes away: the cut
lands on the mark, the output has **one segment, no edit list and zero unshown
frames** — verified — and no keyframes are consulted at all.

What it costs is measured, not guessed:

| | 13 s recording | 7 min recording |
|---|---|---|
| `Fast` (passthrough) | 0.6 s | 0.6 s |
| `Exact` (H.264, `encode`) | ~6 s | **334 s** |

`Exact` is the **default**. It started as the opt-in — the 500× cost difference
seemed decisive — but the surprise runs the other way around: someone reaching
for scissors expects the cut to land where they marked it, and "it takes a
minute" is a better surprise than "it took two seconds more than I asked and
left a hidden tail". `Fast` is one click away in the summary — the mode note is
a button, because a note you can act on beats a note plus a control somewhere
else, in a row that has already been too narrow once. Choosing it makes the
striped overshoot appear at once, so the trade is visible before it is paid.

**Written by hand, not by preset.** `AVAssetExportSession` only takes named
presets, and a preset chooses the picture as well as the codec:
`AVAssetExportPresetHighestQuality` — the only H.264 one — silently downscaled a
4096×2304 recording to 3840×2160 *and* halved its frame rate, 53.7 fps down to
28.6. The HEVC preset held both but changed the codec, which matters for a file
whose whole point is to be sent to somebody.

So `encode` drives `AVAssetReader` and `AVAssetWriter` directly: decoded frames
out of the composition, H.264 back in at the source's own width, height and
frame rate, with the bit rate the source was already using and a keyframe a
second to match `screencapture -v`. Every value is stated rather than defaulted,
because the defaults are exactly what the presets chose. Verified on two
recordings: 3944×2062 at 56.35 fps and 3160×1926 at 57.33 fps, against sources
at 56.55 and 56.98 — same codec, same size, same rate, one segment, zero unshown
frames.

Audio is copied rather than re-encoded — nil settings on both the reader output
and the writer input. Shotly's own recordings are silent, but the library holds
whatever is put in it, and dropping someone's audio because our recorder never
makes any would be a poor way to find that out. Checked on a clip with an AAC
track: 20 s in, 15 s out, both streams.

Both tracks are pumped in one loop rather than one after the other, so the
writer interleaves them the way a player wants to read them back.

Two consequences worth holding on to:

* **`resume` is deliberately not idempotent.** Fed its own output it steps
  again. The *mark* is what gets stored and passed about; the resume point is
  derived from it every time. That is also why the handle is not snapped onto
  it — snapping would throw the mark away and let the next drag round it on.
* **Keep pays none of this.** What a Keep discards is the dead air at the ends,
  so the run-up it hides is dead air too. Paying up to two seconds of the part
  somebody wanted, to bury a second of what they did not, is the wrong way
  round. `keeping_never_rounds_a_mark` pins that.

Sync samples come from `compose::sync_points`, walking an `AVSampleCursor`.
Under a millisecond on a short recording and about 17 ms on a seven-minute one,
so the player reads them once when the scissors are pressed.

#### Two things 0.9.5 got wrong, both worth not repeating

**`video_trim` was synchronous.** A sync `#[tauri::command]` runs on the main
thread — the same trap `library_thumbnail` documents above — so the whole
interface froze for the length of every trim. The button never even repainted
to say it was working, because the thread that would have drawn it was the
thread doing the waiting. It is `async` over `spawn_blocking` now, and the
button fills as `compose` reports progress.

**The app aborted on a panic in WebKit's URL-scheme handler.** The crash
report's faulting thread was a tokio blocking worker inside
`wry::…::url_scheme_handler::start_task`, which is where `media::serve_async`
answers range requests. WKWebView throws if you answer a task it has already
stopped, and swapping the player's source when a trim lands does exactly that
to an in-flight request. wry wraps that delivery in `objc2::exception::catch`
because it expects to have to — but `panic = "abort"` left nothing to catch
with. The profile is `panic = "unwind"` now, so a panic on a worker costs that
one piece of work instead of the session. The player also pauses before
exporting, so there is usually nothing in flight to cancel.

Two related changes came out of diagnosing it, and both are about never
spending that hour again: the release profile keeps its symbol table
(`strip = "debuginfo"`), and `lib.rs` installs a panic hook that appends the
message and location to `~/Library/Logs/Shotly/panics.log`. A packaged app has
no terminal, so without that the one line naming the file and the assumption
goes nowhere at all.

## The main thread and files that are not really there

Five hang reports in two days, every one the same stack: the main thread, inside
a WebKit URL-scheme callback, stopped in `apfs_materialize_dataless_file_ext`.
Two of them were startup hangs (`Time Since Fork: 20s`, `36s`), the rest froze a
session already in progress, for up to 26 seconds.

Two facts combine into that:

1. **Both of Shotly's scheme handlers are synchronous and run on the main
   thread.** The `ipc:` one dispatches `#[tauri::command]`s — a plain `fn`
   command runs *on the main thread* (tauri-macros' `Blocking` default), and
   only an `async fn` is moved off it. The `asset:` one is worse: Tauri's asset
   protocol opens and reads the file inline, on the calling thread, with no way
   to opt out.
2. **A file's bytes may not be on the disk.** macOS marks a file whose contents
   a provider — iCloud Drive, Dropbox, Google Drive — has evicted with
   `SF_DATALESS`. `stat` still answers instantly, so name, size and date are
   free. Reading one byte blocks until the provider has fetched *the whole
   file*. This machine had thirteen such files on the Desktop, one of them
   345 MB.

So the rules here are:

* **Anything that opens a file the user owns is an `async` command** that does
  the work in `spawn_blocking` — `list_library`, `open_image`,
  `read_capture_bytes`, `image_data_url`, `library_thumbnail`. If such a command
  then needs to touch a window (`open_image` shows the editor, which changes the
  activation policy), that half goes back through `run_on_main_thread`. A `fn`
  where an `async fn` belongs is invisible in review and shows up as a frozen
  app on someone else's machine.
* **A thumbnail already made is served whatever became of the original.** The
  cache moved out of `$TMPDIR` — which macOS empties whenever it likes — into
  `$APPCACHE`, and the dataless check now sits *after* the cache hit rather than
  before it. Reading our own cache touches nothing in the library; only
  *generating* a thumbnail has to read the capture, and that is what a download
  would be. The version that checked first turned a whole evicted library into
  grey rectangles.

  The scope in `tauri.conf.json` has to include `$APPCACHE/**` for the same
  reason it includes `$TEMP/**`: the webview loads those files over `asset:`,
  and a cache the protocol cannot reach is a grid of broken-image icons.

* **What was measured is remembered.** Dimensions and duration come from inside
  the file, so an evicted capture has none — and "0 × 0" is a worse answer than
  the truth from the last time it could be read. `remember`/`recall` keep them
  beside the thumbnail, keyed on path and mtime like everything else here.

* **Listing a folder must never download anything.** `read_library` checks
  `is_dataless` before it opens anything, and a capture in that state is listed
  from its `stat` alone — no dimensions, no duration, no thumbnail, and the grid
  says "In the cloud" rather than "0 × 0". The thumbnail command refuses these
  too, because the grid asks for one per card as you scroll and a folder of
  recordings would quietly become a gigabyte of downloads.
* **The player refuses a cloud recording outright** and offers QuickTime, which
  downloads it with a progress bar. Fetching hundreds of megabytes because a
  video element asked for four bytes of header — with no progress and no way to
  cancel — is not something to do on the user's behalf. `media.rs` refuses these
  too, as a backstop.
* **The asset scope is `$TEMP/**` and `$DOCUMENT/Shotly/**`, and that is all.**
  It used to include `$DESKTOP`, `$DOWNLOAD`, `$PICTURE` and `$APPDATA`, none of
  which anything asked for — three `assetUrl` call sites exist, and they read a
  thumbnail, a scratch capture and a recording. Those extra roots were a way for
  the webview to read the user's Desktop *and* the most likely source of the
  0.7.9 freeze, since that is where the evicted files are.

### The `media` scheme (`media.rs`)

Recordings do not go through `asset:` at all. They are served by a scheme of
Shotly's own, registered with `register_asynchronous_uri_scheme_protocol`, whose
handler may answer *later* — so the read happens in `spawn_blocking` and the
main thread returns immediately. Measured with `sample` during playback: 2,570
samples over three seconds, **zero** blocking-read frames on the main thread,
and the `read` sitting on a `tokio-rt-worker` where it belongs.

Worth knowing if you touch it:

* It serves **one directory**, the capture folder, and checks containment by
  canonicalising both sides — which resolves `..` and follows symlinks, so
  neither a crafted path nor a symlink planted in the folder points out of it.
  That is also why the `asset:` scope could shrink back to `$TEMP/**` alone.
* `convertFileSrc` percent-encodes the *whole* path, separators included, so the
  path component arrives as one escaped blob behind the authority's slash. The
  first version trimmed leading slashes off a literal path and quietly made it
  relative; the tests build their URLs the way the frontend does, which is what
  caught it.
* One chunk or a range, with no third case: a file that fits in `CHUNK` comes
  back whole in a 200, and anything larger is ranged from the first request
  onwards — including a request that arrives with no `Range` header at all,
  which is what a media engine sends first and means "start playing", not "send
  me 300 MB".
* A reply must describe **what it sent**, not what was asked for. A capped range
  that claims the range it was given is an off-by-one nobody sees until seeking
  lands in the wrong place, which is why the range arithmetic has tests of its
  own.

## Share links (`share/`)

Sharing is one capture, on purpose, to one person. Right-click a capture, Copy
share link, and Shotly uploads **that file** — from wherever it sits in the
library, no backup and no synced folder involved — into a folder called
`ShotlyShared`, marks that one file readable by anyone with the link, and puts
the link on the clipboard. Nothing else in the library moves and nothing else
becomes readable.

**The seam is a trait, and that is the load-bearing decision here.** Uploading a
file, finding-or-making a folder, and turning a file id into a URL are the same
three moves on every service; only the endpoints and the OAuth dance differ. So
the app talks to `Provider` and never to Google:

```rust
pub trait Provider: Sync {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn available(&self) -> bool;   // this build has credentials for it
    fn connected(&self) -> bool;   // this Mac has an account
    fn connect(&self, open: &dyn Fn(&str) -> Result<(), String>) -> Result<(), String>;
    fn disconnect(&self);
    fn upload(&self, path: &Path, progress: &mut dyn FnMut(u64, u64)) -> Result<Link, String>;
}
```

`share_providers` hands the list to Settings, which renders whatever is in it
without naming anything. Adding OneDrive or Dropbox is a new file implementing
the trait and one line in `all()` — no frontend work, no new commands.

**What this replaced, and why it is worth recording.** Until 0.9.x an
unconnected Shotly made links by reading Drive for desktop's private SQLite
index at `~/Library/Application Support/Google/DriveFS/<account>/metadata_sqlite_db`
to recover the id of a file the backup had already synced. It was a genuinely
neat trick — one 9ms recursive CTE, no OAuth, no tokens — and it was the wrong
shape:

* It made sharing conditional on backing up **into Google Drive specifically**.
  The capture in your own Shotly folder was never the thing being shared; a copy
  of it was, if one existed and had finished uploading.
* The index carries names, ids and parents and **no permissions at all**, so it
  could produce a link but never make one work. Sharing meant sending the user
  to the folder in Drive to set *anyone with the link* by hand — which shares
  every capture in it, including ones taken later and never sent to anyone.
* It depended on Google's undocumented private store, and it put the whole
  feature inside the Backup screen, where it read as part of backing up.

All of it is gone. One code path, one provider interface, and the file on your
disk is the file that gets sent.

`ShotlyShared` is deliberately not the backup's `Shotly` folder: everything in
one has been handed to someone on purpose and nothing in the other has, and a
test asserts the two names differ.

### The Google provider (`share/google.rs`, `share/gauth.rs`)

* **The scope is `drive.file`.** Google shows the app only the files the app
  itself created, so find-the-folder cannot stumble onto a folder of the user's
  with the same name and a bug here cannot reach the rest of their Drive. That
  limit is enforced on their side, which is the only kind worth relying on.

  It was the wide `drive` scope for one release, so that it could share the copy
  Drive-for-desktop had already synced and skip the upload. A bad trade, worth
  recording as one: `drive` is *restricted*, so a published client needs an
  annual third-party security assessment, and the alternative — every user
  creating their own Cloud project, consent screen and test-user entry — is a
  ten-minute setup where Snagit's is ten seconds. `drive.file` is
  non-sensitive: an ordinary consent screen, no assessment, and the client ships
  inside the app like every other desktop application's.
* **The flow** is the one Google specifies for an installed app: loopback
  redirect on `127.0.0.1` with a port the OS hands out, plus PKCE. The client
  secret proves nothing in an app anyone can unzip; the code verifier does, and
  it never leaves the process.
* **A refresh token goes in `google.json`, mode `0600`, in the app's config
  directory** — deliberately *not* the login keychain, and this is the one
  decision here most likely to look wrong at a glance.

  The legacy macOS keychain authorises "Always Allow" against the binary's
  code-directory hash. Shotly updates itself, so every update invalidates every
  grant, and macOS then prompts *per read, per item*. This module read on every
  call, so a user saw ten or more dialogs in a session and answering them
  achieved nothing that survived the next update.

  The fix Apple intends is the Data Protection keychain, which authorises by
  team id via a `keychain-access-groups` entitlement and survives updates. It
  needs a Developer ID from the Apple Developer Program; an ad-hoc or
  self-signed build falls back to the legacy keychain and its prompts. **When
  that certificate is bought, move this** — `keyring` reaches that keychain with
  its "Protected" target — and migrate the file away in the same release.

  What is at stake is smaller than it looks: a `drive.file` refresh token can
  reach only the files Shotly created, not the user's Drive. Reading a `0600`
  file in the app's own directory means already running as that user, and such
  an attacker can equally drive the app or lift the access token out of memory.
  An install that signed in under the old scheme is migrated on first launch —
  read once, written to the store, deleted from the keychain — which is the
  last prompt anyone sees.
* **Access tokens live in memory** for their hour, with a minute's headroom so
  one never expires mid-request.
* **`invalid_grant` disconnects.** A refresh token revoked from the Google
  account page fails identically for ever; dropping it means the next attempt
  offers to connect instead of failing the same way again.
* **The upload is resumable**, in 8 MB chunks, emitting `share:progress`. These
  are recordings: a 300 MB upload that fails at 90% with no progress shown is
  the worst of both worlds, and one with no progress at all is
  indistinguishable from a hang.

`upload` returns `{ url, shared }` rather than a bare string, because the
difference is the whole feature: a link that is correct but opens for nobody
looks like success on the clipboard and fails at the far end. Google sets the
permission as part of the upload, so it is true there — a provider that could
not would have to say so, and the toast words itself from that flag.

## Neon — one recipe, two renderers

The lit boxes are a `Style` flag, not a tool: a callout you have already dragged
out and typed into can become one, and the same switch turns a rectangle or an
ellipse into a glowing ring. What they look like lives in **one** function,
`neonPaint` in `shapes.ts`, because two renderers draw it and a glow is the
easiest thing in this codebase to get subtly different — CSS `drop-shadow` and
canvas `shadowBlur` are not the same primitive. `harness/neon.html` draws the
same shapes through both, one above the other, so a drift shows up as two boxes
that do not match.

Two things there are load-bearing:

* **The scrim.** A neon box is four layers — near-black wash, thin colour wash,
  bright border, glow — and the wash is not decoration. Tint alone looks right
  over the dark screenshots the style was designed against and turns white text
  into pale-on-pale over a bright one, and a capture tool cannot know which it
  is about to be dropped on. With the scrim, the ink is a constant `#FFFFFF`
  rather than `contrastInk`. Measured over a bright blue screenshot, the fill
  comes out at luma 66/255 — white text on it is about 9:1.

  A bare neon rect or ellipse gets **no** scrim, deliberately: it is a ring
  drawn around something, and washing down the thing you are pointing at would
  defeat it.

* **`shadowBlur` ignores the transform.** Same trap as the backdrop's shadow —
  see `shadowScale`. `withGlow` scales by hand, or a halved export comes back
  with a glow at twice the size it should be.

The neon inks are a second row in the picker rather than a replacement, and
picking one switches neon on: a swatch that shows you a lit chip and then draws
a flat box is the picker lying about what it does. They carry no ⌘-digit
shortcuts, which stay with the original nine.

## Turning shapes — one number, and a room tilted the other way

A shape carries an `angle` and nothing else. Its geometry stays square to the
axes and the turn happens at draw time, about the shape's **own centre** —
`rotate()` on a group in SVG, `ctx.rotate` on the canvas. That one decision is
why rotation cost so little: the stored width of a rectangle is still its
width, text still wraps to a horizontal line length, a callout laid out at 30°
is laid out exactly as it would be at 0°, and dragging a turned shape is still
a translation, because the centre is the one point a rotation does not move.

Resizing is where it would have got expensive, and doesn't. A corner drag on a
turned shape is the same drag it always was, seen from a room tilted the other
way: `unspun` takes the pointer there, `unspunBox` takes the shape, the
ordinary anchor-and-opposite-corner arithmetic runs untouched, and `respunBox`
takes the answer back. What the last step is really doing is holding the corner
under the pointer still — the shape hangs off its centre, and a resize moves
that centre, so without it a turned shape swings out from under the hand, more
the further round it is. `spin.test.ts` pins exactly that: drag a corner of a
33° box and both the dragged corner and the anchor land where they should.

The frame and all eight handles turn with the shape, which is the point of the
side ones: on a shape lying on its side, the handle on its top edge stretches
it sideways on screen, because that is its top edge. The cursor is rounded to
the nearest of the four macOS resize arrows for the same reason.

**Two shapes cannot be turned as a whole**, and both fail the same way — by
reaching outside their own box. The blur samples the picture underneath it, so
its *window* tilts while its pixels stay where they are: the transform goes on
the clip path, not the group, and on the canvas the context turns, sets the
clip, and turns back before the image goes down. The spotlight darkens
everything around it, so its cover has to stay square to the capture while the
hole leans: the hole is written out corner by corner instead of as a rectangle.
`spinsItself` in `AnnotationLayer` names them; `withSpin` in `export.ts` skips
the same two. Get this wrong and it looks like a rendering bug in the blur
rather than a rotation one.

Lines and numbered steps do not turn. A line is already pointed wherever its
ends are, and turning a step would turn its number over; both say what they
mean with the handles they have. See `canRotate`.

In the live overlay a selection can hold several shapes, and a rigid turn of a
group is each piece turned in place with its centre carried round the pivot —
`spinStroke`, two lines, exactly that. The frame takes the selection's angle
when they all agree on one and stands upright when they do not, because a pile
of shapes lying at different angles has no direction that is "along" it.

Markup version 10. An older build would ignore the angle and draw everything
square to the page, which is the most literally different picture on that list.
`harness/spin.html` has every turnable kind at an angle, with the exporter's
version of the same shapes beside it.

## Zooming and pushing the canvas around

Two things here are not obvious and both were arrived at the hard way.

**The wheel listener is native, not React's `onWheel`.** React attaches wheel
handlers *passively* at the root, where `preventDefault` does nothing — so the
pane would zoom and scroll at the same time, with the WebView zooming itself
underneath both. `addEventListener("wheel", …, { passive: false })` in an
effect is the only version that works. A trackpad pinch arrives as a wheel
event with `ctrlKey` set, in every engine and on every platform, so ⌘ and pinch
share one path.

**The zoom is read from the store, not from the closure.** A flick of the wheel
delivers several events inside one frame and React has not re-rendered between
them, so a `zoom` captured by the effect is the same stale number every time
and all but one notch is silently lost. Zustand writes synchronously, so
`useEditor.getState().zoom` is already the value the previous event asked for
and notches compound. The zoom *rendered on the page* is measured off the stage
rect rather than remembered, for the same reason.

Keeping the point under the cursor still is a layout effect, and measured
rather than calculated: it reads the stage rect after the commit and corrects
`scrollLeft`/`scrollTop` by the difference. That way it is right whether the
capture is scrolled, centred in a pane bigger than itself, or inset by a
backdrop frame — none of which it has to know about. It has to be a *layout*
effect: one tick later and the capture visibly jumps.

The one case it cannot hold is a capture small enough to fit the pane, where
there is no room to scroll and the content stays centred. That is fine and not
worth fixing: the whole picture is on screen, so nothing is sliding out of
view. Anchoring matters exactly when you are zoomed past the edges, and there
it is exact to a rounding error on the integer scroll offsets.

A zoom that nobody aimed — the toolbar buttons, ⌘+, the menu — keeps the
*middle of the pane* instead of the cursor. The middle is recorded in document
coordinates after every commit by a second layout effect, declared after the
one that reads it so that what it holds during a zoom is where the pane was
looking when that zoom began. Without it every step of the toolbar zoom walks
off towards the top-left corner, because that is where a scroll container's
origin is and nothing else was asking to be kept.

**A centred canvas could not be scrolled to its own left edge**, and that one
line of CSS was two bug reports. `justify-content: center` on a scroll
container throws the overflow on the *start* side away: once the capture is
wider than the pane, its left-hand third sits at a negative offset that no
scroll position can reach — measured in the running app at 244%, the stage
began 3308px to the left of a scroll origin whose maximum was 0. So the pane
opened somewhere in the middle of the picture, every gesture that steers by
scrolling died against the clamp, and a pan that could only move one way read
as a pan that did not work at all. `justify-center-safe` and `items-center-safe`
centre it while it fits and pin it to the start once it does not. Anything
inside a scroll container wants the safe variants; the plain ones are a trap
that only springs on content larger than its pane.

**The canvas has room around it, and that is what makes the gesture do
anything.** Panning here is scrolling a pane, so with the capture sized exactly
to fit there is nothing to scroll and holding space did nothing at all — which
is what "space to move does not work" turned out to mean the first two times it
was reported. Half a pane of room on every side, recomputed by the same
observer that recomputes the fit, means the picture can always be pushed
somewhere, at any zoom, the way it can in Figma. Two traps came with it:

- The room is **`box-sizing: content-box`**, against the app's border-box
  default. Under border-box, `min-width: 100%` with 554px of padding a side
  leaves a content box of nothing, the capture overflows one way only, and the
  room ends up on two sides instead of four — measured as a maximum scroll of
  exactly `scrollWidth - clientWidth` on one axis and a picture that would not
  centre.
- The pane is now *always* scrollable, so the scrollbars are hidden. A bar on a
  picture that plainly fits reads as something being wrong.

Centring is done by **watching the stage with a `ResizeObserver`**, not by
reacting to the numbers that feed it. A capture takes several commits to reach
its final size — fit is measured from the pane, applied as a zoom, and laid out
— and the size on the page is the last of them to be true. Only while fitting:
a zoom you drove yourself has an anchor of its own.

Space-to-pan is a **capture-phase** handler on the viewport that stops there.
Anything less and the press also reaches the stage, so letting go leaves a
rectangle behind wherever the pan ended. The key itself is claimed on the
capture phase too: a `keydown` listener on the window in the *bubble* phase is
the last thing an event reaches, and `useKeymap` stops every chord it owns dead
on the way down. The hand is a mode rather than a shortcut, so it is taken
where nothing can have swallowed it yet.

Two details of *holding* a key, both of which only bite on a real keyboard and
neither of which a scripted key press can reproduce. `preventDefault` goes
**before** the `e.repeat` guard: held down, space does not send one keydown but
a stream of them, and each one carries the same default action, so skipping the
repeats let the pane page itself downwards under a hand trying to drag it. And
whether a press starts a pan is read from a **ref**, not from the state the
cursor is drawn from: the two only disagree between the key arriving and React
committing, which is exactly the moment a fast hand puts the button down. The hand cursor is forced onto every
descendant with `[&_*]:cursor-grab`, because the shapes carry SVG `cursor`
attributes and the stage carries an inline style, and a descendant rule is the
only thing that outranks both.

## Groups, locks, and the one door a selection comes through

Both features are one rule each, and both rules live inside `select` in the
store rather than at the half-dozen places that choose a selection — clicking,
shift-clicking, Tab, Select All, the context menu. A group that came apart in
one of them would be a group nobody could trust.

**A group is a shared id**, not a tree. `AnnotationBase.group` is a string;
grouping a selection that already spans groups flattens them into one. Nesting
would buy a hierarchy nobody drawing on a screenshot has ever asked for, at the
price of every click becoming a question about depth. `familyOf` is what the
canvas asks when a shape is pressed, and shift-click adds or removes a whole
family rather than picking a member out of the middle.

**A locked shape is one that cannot be selected.** That is the whole of it:
nothing in the editor changes a shape without selecting it first, so a single
rule in one place keeps locked shapes safe from every edit at once — including
the ones added next year. The SVG layer gives them `pointer-events: none`, so a
press goes through to whatever is underneath, which is the entire reason to
lock the spotlight that was covering everything. Locking deselects on purpose,
and `Unlock all` is the way back.

Aligning is `align` and `distribute`, on **spun** bounds so a turned shape
lines up by the box you can see. Distribution evens out the *gaps* rather than
the centres — three boxes of different widths spaced by their centres leave
gaps that visibly differ, which is the thing anyone reaching for the command
was trying to fix. The keys are Figma's (⌥A ⌥D ⌥W ⌥S, ⌥H ⌥V, ⌃⌥H ⌃⌥V) because
anyone who wants them already has the muscle memory, and they are bound by
`code` so they survive ⌥ turning A into å.

## Arrows that bend, and arrows that stick

Two features that sound related and share almost no code.

**The bend is one number.** `LineAnnotation.bend` is how far the line bows out
of the straight run between its ends, as a fraction of the distance between
them — so a bent arrow dragged longer keeps its shape instead of flattening.
One scalar rather than a stored control point, because two renderers have to
agree exactly and a scalar cannot drift: `bendControl` derives the quadratic in
one place, and the SVG preview and the Canvas2D exporter both draw *that*
quadratic — `Q` and `quadraticCurveTo` are the same curve. Sampling one and
curving the other would agree to about a pixel, which is exactly the kind of
difference that only shows up on a saved file.

The arrow is the exception, because a filled outline offset either side of a
quadratic is not itself a quadratic. `bowedArrow` walks it in 48 steps. Note
what it does *not* do: the straight case is still the original seven points of
exact arithmetic, kept separate rather than made a special case of the walk,
because thousands of saved captures depend on it and rebuilding it out of
samples would move every one of them for no gain. `shapes.test.ts` pins that.

**A connector is a line whose ends are kept on a shape's edge** — not a line
that has forgotten where it is. `fromId`/`toId` name the shapes; the
coordinates stay authoritative and stay true. This is the whole design, and the
alternative is worth stating: resolving the ends at draw time would mean every
renderer needed the rest of the document to know where one arrow was, and
`boundsOf` would stop being a function of its argument. Instead `rerouted` runs
inside the store after anything that can move a shape, and the coordinates
catch up. Hit-testing, the exporter, the markup format and a build of Shotly
that has never heard of connectors all keep working unchanged.

Two details that are easy to get wrong. Taking hold of an end **unties it
first**, or the rerouting puts it straight back every frame and the end cannot
be dragged anywhere at all. And a bond whose shape has been deleted is dropped
rather than remembered, so an undo that brings a different shape back cannot
inherit it.

## Lining shapes up — a pull, and a line that says why

`lib/guides.ts` is pure arithmetic on axis-aligned boxes and knows nothing
about pointers, React or annotations beyond `spunBoundsOf`. That is deliberate:
the whole feature is worth a couple of pixels, so the only way to know it is
right is to assert on numbers, and `guides.test.ts` does.

A gesture hands it one box and gets back `{ dx, dy, guides }`. Three coordinates
per axis take part — near edge, centre, far edge — for the moving box and for
every target, where the targets are the other annotations' *spun* bounds plus
the page itself. Rotation needs no special case anywhere in this file: a turned
shape snaps by the rectangle it visibly occupies, which is the only rectangle a
guide could honestly be drawn against.

Two passes, and the second one is not optional. The first finds the smallest
correction any mark can make; the second re-asks every mark *at the corrected
position* and keeps all of them that still agree. A shape that lines up with two
things and admits to one looks like it moved on its own.

Which box gets passed in is the whole of the caller's job, and it differs by
gesture:

| Gesture | Box handed to the snapper | Why |
|---|---|---|
| move | the union of the selection's spun bounds | dragging three shapes lines *the group* up, which is what the marching rectangle looks like it should do |
| resize | the dragged point alone, and only at `angle === 0` | snapping the box would drag the anchored corner off the spot it is pinned to |
| create | the corner under the hand | same reason: the other corner is where the drag began |

Modifiers already meant things, so snapping had to fit around them rather than
take a key of its own. Shift is an axis lock on a move and a square/angle
constraint on a create — a snap on a locked axis would quietly undo the
constraint the user is holding down, so it is dropped, guides and all. **⌘
suspends snapping**, which is the Figma convention and the only free modifier
left.

Even spacing is the second half, and it only fires on an axis where alignment
found nothing: both pulling at once lands a shape somewhere it was never
dragged. It matches against gaps that already exist between neighbours in the
same row, and skips any target the moving box sits *inside* — the page is one
of those, and a margin to the capture's edge is not a gap anyone is evening up.

`harness/guides.html` has the shapes arranged to trigger both: a column sharing
a left edge, and a row already an even 60 apart.

## One tool, one ink

Colour, weight and the rest used to be a single shared setting, so picking
yellow for a highlight made the next arrow yellow. They are now one slot per
tool in local storage — `shotly.style.<tool>` — read whole on every tool
switch and written whole on every change. `sanitize` validates field by field
so one bad number costs one setting rather than the lot, and a slot that has
never been written falls back to the old shared keys, so upgrading doesn't
throw away the ink someone has been working in.

The slot name is the tool id, which for every drawing tool is *also* the
annotation kind it produces. That coincidence is load-bearing: `slotFor` picks
the selected shape's kind over the tool in hand, so recolouring a selected
arrow teaches the arrow tool whatever tool happens to be up, with no lookup
table. The working style only moves when the change belongs to the tool in
hand — otherwise one click on a selected shape would follow you into the next
shape you drew.

`shownStyle` is the other half: every control reads whichever style it is about
to write, which is the selected shape's own when there is one. The toolbar used
to show the tool's ink while a shape drawn in something else was selected, so
every control read as wrong until you touched it.

⌥⌘C / ⌥⌘V carry a whole style from one shape to another, including the parts
the receiving shape has no use for — an arrow ignores a corner radius, and
carrying it means the same look still lands on a rectangle later. Two commands
rather than a mode: a mode needs a place in the toolbar, a cursor, and a way
out of it.

## A blur has to be a redaction

Two separate things were wrong here, and the second one was worse.

**`ctx.filter` does not work in the WebView this app ships in.** The property
stores the string and reads it back — `ctx.filter = "blur(6px)"` then
`ctx.filter` gives you `"blur(6px)"` — and every drawing operation ignores it.
So the blur and pixelate tools looked right on screen, because the preview is
an SVG `feGaussianBlur` and that does work, and came out **completely sharp in
every saved and exported file**. Nobody had checked, because the two renderers
are supposed to agree and the preview looked correct.

`blurredCopy` replaces it with the oldest trick there is: draw the picture very
small, then draw it back up. The downscale averages neighbouring pixels and
throws the rest away; the upscale cannot invent what was lost. Three passes,
because repeatedly averaging a box converges on a Gaussian, and a factor of
`2r`, because one box of width `d` has variance `d²/12`, variances add, and
three of them matching a Gaussian of standard deviation `r` gives `d = 2r` —
which is the number `feGaussianBlur` and `blur(Npx)` both take, so the export
matches the preview rather than merely resembling it.

Do not put `ctx.filter` back. If you need another filter, check it on a real
build first: the harness runs in an ordinary browser, where it works.

**And the original was carried unblurred.** `markup.rs` tucks the
**unannotated original** into every saved PNG, which is
what makes a capture re-editable and is also, on its own, a hole: a screenshot
with an API key blurred out was shipping the key, one undo away from anybody
with Shotly. `renderRedactedOriginal` closes it. Before the original is
embedded, the editor redraws it at natural size with every blur burnt in, and
*that* is what goes in the file.

Three things about it are deliberate:

* **Only `blur`.** Highlight and spotlight are emphasis, and the shape is still
  a shape — movable, resizable, deletable. What changes is that moving it
  reveals blurred pixels rather than the secret.
* **Natural size, not the document.** The crop and the output scale are both
  undoable view settings; the embedded picture is the one that goes on disk. So
  the blurs are shifted by the crop origin on the way in.
* **Null when nothing is blurred**, so an ordinary save costs no second encode.

⌘⇧B is the other half: one pass of the recogniser that is already there for the
text grab, with `looksSensitive` (`lib/redact.ts`) deciding which lines to
cover. It runs over the whole **file**, not the visible document, so a line
cropped out of view is blurred too — otherwise the crop is simply the other way
the secret gets out. `redact.test.ts` has as many cases for prose, version
numbers and timestamps staying clear as it does for secrets being caught: a
pass that blurs half an ordinary screenshot gets switched off, and a switched-
off pass catches nothing.

What is *not* covered, and should be said plainly: cropping alone is still
non-destructive, so a capture cropped to hide something still carries it. That
is the documented behaviour of the crop and changing it would break the promise
the rest of the editor makes.

## Searching what the pictures say

`textindex.rs` reads every still once and keeps the words in
`app_config_dir/text-index.json`, keyed on modification time. Not in
`~/Documents/Shotly`, which is the user's folder and syncs; not inside the
files, which would rewrite captures nobody touched and put a copy of everything
a screenshot says into a file about to be emailed.

The reading is batched — four at a time, paced, saved before each batch
returns — because recognition is around a quarter of a second a picture and a
first run over a big library is minutes. Stopping halfway costs nothing. The
library pane drives it, since the library is where searching happens, and shows
what it is doing **only while a search is active and the index is incomplete**:
a permanent progress bar for work nobody asked for is noise, but a search that
silently cannot see half the library is a lie.

The grid narrows on the filename immediately and widens as the index answers.
That order matters — a search that showed nothing until a round trip finished
would feel broken at exactly the moment it was being useful.

## Dragging a capture out of the window

HTML drag-and-drop can hand another *web page* a file; the pasteboard it writes
is not the one AppKit reads when the drop lands on Slack. So `platform::dragout`
starts a real `NSDraggingSession` on the window's content view, with the file's
URL as the pasteboard item — which is what Finder does.

Two details are not obvious. The **event** it wants is the mouse event that
started the drag, and by the time a command has crossed the IPC boundary the
current event may be anything; one is synthesised at the pointer's position in
the window, which is honest, because the front end really has just recognised a
drag. And the **source** object answering `sourceOperationMaskForDraggingContext`
is made once and never released: AppKit keeps only a weak reference, and a
source freed mid-drag is a crash in somebody else's process. It offers `Copy`
and never `Move`, so a drop can never take a capture away.

`lib/dragout.ts` is the other half, and everything in it is about the events
stopping: once the native session starts, the web view sees no move and no
release, and the click that would have followed never arrives. State is reset
at the moment the drag is handed over, not on a `pointerup` that may never come.

## The corner a capture lands in

`shelf.rs` is the alternative to opening the whole editor for a screenshot that
is going to be pasted somewhere and forgotten. **Off by default**, in
Settings → General: it changes what the capture key *does*, and that is not a
habit to rearrange under anyone.

It is the only path that files a capture from Rust. Every other one hands the
frame to the editor, which saves it on arrival — and that cannot work here,
because the whole point is that the editor is never shown, and *a webview in a
hidden window runs no JavaScript*. The editor would take the capture and
quietly never file it.

`deliver_capture` is the seam, and it is separate from `deliver` on purpose:
the shelf only makes sense for something the user just photographed. Opening a
file, combining several, or capturing from the window picker already has the
editor in front and in charge. Any failure falls through to `deliver` — a
capture that could not be put in the corner must never be a capture that
vanished.

## Window level and Spaces — the rule for every overlay

A window created while a full-screen app is in front belongs to the **desktop**
Space, not the one the user is looking at. `alwaysOnTop` does not change that:
it is a floating-level window on a Space nobody is on. For an overlay that is
invisible, unreachable, and — because macOS never composites it, and suspends
the WebView of a window it never composites — unable to report that it painted,
which its own watchdog then reads as a hung renderer and tears down.

Every overlay therefore has to say where it lives. Which of the two treatments
it gets depends on one question: **does it take the mouse across the whole
display?**

| Window | Takes the mouse? | Treatment |
|---|---|---|
| `snap` outline | No — `ignore_cursor_events` throughout, clicks come from a CGEventTap | `elevate_overlay_window`: screen-saver level, all Spaces |
| recording panel | Only its own 232 points | `elevate_overlay_window` |
| capture shelf | Only its own corner, and never focused | `elevate_overlay_window` |
| recording selection | Yes, full screen | `show_on_every_space`: Space membership only |
| `scroll` selection + HUD | Yes, full screen | `show_on_every_space` |
| `annotate` layer | Yes, full screen | `follow_active_space` — moves to the active Space |

The line is about what a wedged window costs. A full-screen click target raised
above the menu bar is a full-screen click target with the *tray behind it*, and
the tray is one of the ways out of an overlay that has stopped answering — the
state this app has been bricked by more than once. Small panels and
click-through outlines have no such cost, so they get the level as well as the
Space.

If you add an overlay, pick a row. Neither treatment is the default.

## Not built yet

GIF recording, and audio — `screencapture -g`/`-G` can record an input device,
which is a different feature with its own permission prompt.

Windows. [WINDOWS.md](WINDOWS.md) is the assessment and the plan: what ports
free, what has to be built, and what shipping both platforms from one repository
costs. Its parity rule applies from the day the port starts, not from the day it
lands — every feature added after that point needs both halves, or a recorded
decision that it has one.
