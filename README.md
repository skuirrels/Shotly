# Shotly

[![Download Shotly](https://img.shields.io/github/v/release/skuirrels/shotly?style=for-the-badge&label=Download%20Shotly&color=2f81f7)](https://github.com/skuirrels/shotly/releases/latest/download/Shotly.dmg)

Screenshots for macOS: capture, mark up, and get on with your day.

Shotly takes the shot, opens it in an editor built for annotating rather than
retouching, and keeps everything you capture in one folder you can actually
find. **Screen annotation** goes a step further and lets you draw straight onto
the live desktop, for when you're explaining something on a call rather than
marking up a picture. It stays out of the way in the menu bar until you press a
key.

---

## Install

1. Download [`Shotly.dmg`](https://github.com/skuirrels/shotly/releases/latest/download/Shotly.dmg)
   — that link always serves the newest build. Apple Silicon only.
2. Open it and drag **Shotly** to Applications.
3. Launch it. macOS asks once for **Screen Recording** permission — click
   **Allow**. Nothing can take a screenshot without it.
4. Quit and reopen Shotly, because macOS only applies that permission to a
   freshly started app.

Shotly lives in the menu bar. Closing its window puts it away rather than
quitting it, so the capture keys keep working. **Settings → General** has
*Open Shotly at login*, which starts it in the menu bar with no window.

It updates itself: it checks shortly after launch and every six hours, installs
quietly in the background, and offers you a relaunch when it's ready. **Check
for Updates…** in the menu bar does it on demand.

---

## Taking a shot

Five keys, and they work in any app:

| | |
|---|---|
| <kbd>⌃⇧4</kbd> | **Region** — drag out the part of the screen you want |
| <kbd>⌃⇧5</kbd> | **Window** — pick from a grid of every open window, shown as it looks |
| <kbd>⌃⇧3</kbd> | **Full screen** |
| <kbd>⌃⇧6</kbd> | **Scrolling capture** — a whole page, taller than the screen |
| <kbd>⌃⇧R</kbd> | **Record** — an area, a window or the screen, as a movie |

They're on Control-Shift rather than Command-Shift because macOS already owns
Command-Shift-3/4/5 for its own screenshot tools, and quietly stealing those
would be rude. **You can change any of them** — see
[Changing the keys](#changing-the-keys).

Region selection uses the macOS selector you already know, complete with its
magnifier and pixel readout.

**Window** opens a picker instead of a crosshair: every open window as a live
thumbnail, filterable by app or title, arrow keys and <kbd>⏎</kbd> to take one.
It reaches windows the pointer cannot — behind other windows, or fully covered —
and because you choose by looking, you always get the window you meant.

### Recording the screen

<kbd>⌃⇧R</kbd>, then say what to record the same way you would frame a shot:
drag out an area, click a window, or take the whole screen. A small panel
appears at the bottom of the display with the elapsed time and the way out —
**Stop and save**, or **Discard**. The same key stops the recording, and so
does the menu bar, which says *Stop Recording* while one is running.

The movie lands in your Shotly folder as an ordinary `.mov` — no editor, no
export step, nothing to convert — and appears in the library alongside your
captures, with a still from the recording and its running time. Picking a window
records *that window*: it follows if you move it, and anything dropped in front
of it stays out.

Double-click it and it plays in Shotly, in a pane beside the editor and the
library — streamed off disk as it plays, so a three-hundred-megabyte recording
starts at once. <kbd>Space</kbd> plays and pauses, <kbd>←</kbd> and <kbd>→</kbd> jump
five seconds (hold <kbd>⇧</kbd> for one), <kbd>Home</kbd> and <kbd>End</kbd> go
to the ends, and there is a speed control and a loop for watching one moment
again. <kbd>Esc</kbd> goes back to the library, and the Player tab holds your
place while you are away. **Open in…** hands the file to QuickTime Player, for
full screen.

**Shortening one** is the scissors on the player. The scrubber becomes a
selection: drag the green handle to where it should start and the red one to
where it should stop, or play until it looks right and press <kbd>I</kbd> and
<kbd>O</kbd> to mark the spot. Dragging a handle scrubs to it, so you are always
looking at the frame you are cutting on, and pressing play reviews just the part
you are keeping.

Then choose which side goes:

* **Keep** throws away everything outside the handles — the reach for the hotkey
  at each end.
* **Cut out** throws away everything *between* them and closes the gap — the
  doorbell, the notification, the minute spent hunting for a menu.

The timeline shows which it is before you commit: whatever survives stays lit,
and what is going is dimmed.

**Cut out reaches a little past the red handle**, and the timeline shows how
far. Video is only cut cleanly at a keyframe — about one a second in a screen
recording — and Shotly resumes at the first safe one beyond your mark rather
than the nearest. That is deliberate: resuming any earlier would leave the last
second of what you cut sitting in the file, invisible in every normal player but
still there. If you are cutting something out because it should not be seen,
this is the difference between it being gone and it being merely hidden.

Either way the cut is lossless and takes about as long as copying the file — a
few seconds even on a recording of several hundred megabytes — because nothing
is re-encoded. The result is filed beside the original as *Recording … trimmed*
and the player switches to it, so sharing or copying next picks up the short
one. Your original is never touched.

**Sending one to someone** is a link, not an attachment — a few minutes of
screen is hundreds of megabytes. **Copy share link**, in the library's
right-click menu and on the player, uploads that one capture and puts a working
link on your clipboard.

Connect an account first, in **Settings → Sharing** — one click, pick the
account, done. Google Drive is the only one today. From then on Shotly uploads
the capture you asked to share into a `ShotlyShared` folder, shares that one
file so the link opens for whoever you send it to, and copies the link. Without
an account there is nothing to upload to, and it says so rather than copying a
link that would open for nobody.

Only what you deliberately share goes up: Shotly asks Google for the narrowest
permission there is, which lets it see the files it created and nothing else.
The rest of your Drive is invisible to it, and so is every capture you never
pressed that button on.

This is separate from **Backup** below, which is a copy of *everything* you
capture, dropped in a folder something else syncs. The two use different
folders on purpose — `ShotlyShared` for what you handed out, `Shotly` for the
second copy of everything.

The panel does not appear in the recording, so you can leave it where it is.
There is no audio: this records the screen, not the room.

### Capturing a whole page

<kbd>⌃⇧6</kbd>, drag out the area once, then **scroll the page yourself** —
Shotly watches the area and stitches everything that scrolls past into one tall
image. A small panel shows the page growing as you go; slow and steady stitches
best. Click **Done** (or press the key again to bail out) and the whole page
opens in the editor.

---

## Marking it up

The shot opens in the editor. Press a letter to pick a tool:

| | | | |
|---|---|---|---|
| <kbd>V</kbd> Select | <kbd>A</kbd> Arrow | <kbd>R</kbd> Rectangle | <kbd>E</kbd> Ellipse |
| <kbd>L</kbd> Line | <kbd>P</kbd> Pen | <kbd>T</kbd> Text | <kbd>O</kbd> Callout |
| <kbd>N</kbd> Step number | <kbd>B</kbd> Blur | <kbd>H</kbd> Highlight | <kbd>S</kbd> Spotlight |
| <kbd>I</kbd> Pick colour | <kbd>M</kbd> Measure | <kbd>G</kbd> Grab text & codes | <kbd>C</kbd> Crop |

A few things worth knowing:

- **Step numbers** count up on their own, for "do this, then this" instructions.
- **Blur** hides anything you shouldn't have captured. **Spotlight** darkens
  everything except the part that matters.
- **Callouts** are boxes you type into; the text colour follows the fill so the
  words stay readable whatever colour you choose.
- **Neon** (<kbd>⇧N</kbd>, or the switch beside the colour) draws a callout as a
  lit sign: a bright edge, a glow around it, white text on a darkened tint of
  your colour. It reads over a bright screenshot as well as a dark one, which a
  plain translucent box does not. The colour picker has a row of neon inks
  underneath the usual nine, and choosing one turns the switch on for you.
  Rectangles and ellipses take the same switch and become a glowing ring —
  no fill, so whatever you are circling still shows through.
- **Pick colour** copies the hex under the pointer to the clipboard as well as
  setting your ink — usually you wanted it for a stylesheet.
- **Measure** draws a dimension line with the distance on it. Drag roughly
  across a gap and both ends snap onto the edges either side, so you get the
  real number without a steady hand — hold <kbd>⌥</kbd> if you'd rather it
  didn't. On a Retina screenshot it reads in points by default (what CSS would
  call it); the **pt/px** switch beside the colour changes that.
- **Everything stays editable.** Reopen a capture Shotly saved and the arrows
  and text are still there to move, recolour or delete.
- Drag an annotation to move it, drag a corner to resize, Alt-drag to draw
  *through* a shape that's in the way.
- Paste an image on top with <kbd>⌘V</kbd> and drag it around — good for
  putting a logo or a second screenshot into the shot.

The rail down the left holds your recent captures: **one click opens one**, and
⌘-click or ⇧-click picks several without opening anything, for a Copy or a
Delete. The library grid keeps double-click-to-open, since there a click is how
you choose what an action applies to.

The live annotation layer (<kbd>⌃⇧A</kbd>) has the neon callout too — press
<kbd>O</kbd>, click where you want it, and type. It draws the same lit box, over
whatever is on the screen.

<kbd>⌘K</kbd> opens a command palette if you'd rather search than remember, and
<kbd>⌘/</kbd> shows every key in one sheet.

---

## Grabbing text — and QR codes — out of a picture

Press <kbd>G</kbd> and drag a box over any text in the capture. Shotly reads it
and puts it on the clipboard — no more retyping an error message out of a
screenshot. Click without dragging to read the whole thing.

The same drag decodes any **QR code or barcode** in the box. A code shows up
first with its own **Copy** button, and — when it's a web link — an **Open**
button that shows you exactly where it goes before you click.

You'll see everything it found, so you can check it before pasting, and click
any single line to copy just that one.

This uses the recognition built into macOS. Nothing is uploaded anywhere.

---

## Pinning a shot to the screen

<kbd>⌘⇧P</kbd> — or right-click a capture in the library and choose **Pin to
screen**.

A pin is a small window that floats above everything, holding one image. It's
for when a screenshot is a *reference* rather than a document: a design you're
copying, a number you're retyping, an error you're working through. Put it
beside your work instead of switching windows every ten seconds.

Drag it anywhere. <kbd>⌘C</kbd> copies it, <kbd>+</kbd> / <kbd>−</kbd> /
<kbd>0</kbd> or ⌘-scroll resize it, <kbd>⌘W</kbd> or the × closes it.
**Close All Pins** in the menu bar clears the lot.

---

## Screen annotation — drawing on the live screen

<kbd>⌃⇧A</kbd> puts a drawing layer over your actual desktop — for explaining
something on a call or a screen share, where marking up a static picture is no
use.

Draw with the same tools. When you need to *use* the machine underneath,
<kbd>⌃⇧D</kbd> hands the mouse back to the desktop and your drawings stay put on
top; press it again to carry on drawing.

**<kbd>esc</kbd> leaves.** Most of what gets drawn on a live screen is said in
the moment and worth nothing afterwards, so leaving keeps nothing — and Shotly
tells you, for a moment, that a second <kbd>esc</kbd> would keep it instead.
Press it and the screen, drawings and all, is filed in your library. The
toolbar's **Exit** button does the same in one go, and <kbd>⌃⇧A</kbd> closes the
layer outright.

The toolbar docks to any edge: drag it, or press <kbd>D</kbd> to send it round
the four sides. Down the left or right it becomes a narrow column.

---

## Your captures

Everything lands in **`~/Documents/Shotly`**, newest first, named the way macOS
names screenshots (`Shotly 2026-08-16 at 14.22.07.png`) so the folder sorts
chronologically on its own.

The **Library** is Shotly's home screen. Search with <kbd>⌘F</kbd>, or narrow by
year and month down the side. Double-click to open one, or right-click for Copy,
Pin, Show in Finder and Move to Trash. Trashing goes through Finder, so it's
recoverable.

### Saving and sharing

| | |
|---|---|
| <kbd>⌘S</kbd> | Save to `~/Documents/Shotly` — no dialog, no questions |
| <kbd>⌘⇧S</kbd> | Save somewhere else |
| <kbd>⌘E</kbd> | Export a flat PNG (defaults to Downloads) |
| <kbd>⌘C</kbd> | Copy the image to the clipboard |
| <kbd>⌘⇧R</kbd> | Show the last save in Finder |

**Save** keeps your annotations editable for later. **Export** flattens them —
about half the file size, and the right choice for emailing, a ticket, or
anywhere the markup doesn't need to be undone.

### Putting captures side by side

Select two or more in the library, right-click, and choose **Combine** — side
by side, stacked, or as a grid. They're laid out on one canvas with an even gap
and opened in the editor, ready to annotate and save as a single file.

To arrange things yourself, the **Canvas** button in the title bar adds blank
space around the capture. Make room, paste another screenshot with <kbd>⌘V</kbd>,
drag it into place — or drag it wherever you like and hit **Shrink-wrap** to
have the canvas take the shape of what's on it. Nothing is destructive: undo
puts it all back.

### Resizing what you share

Click the **size readout** in the middle of the title bar. Pick 75/50/25%,
type an exact width, or — on a Retina screen — one click of **Actual screen
size** stops a 6000-pixel screenshot landing in a ticket. Like cropping, it
never touches the capture itself: undo or 100% puts it back, and it survives
saving and reopening.

---

## Changing the keys

**Settings → Hotkeys** — from the menu bar icon, the Shotly menu, or
<kbd>⌘,</kbd>. Click any shortcut and press a new combination. It takes effect
immediately, with no restart.

Worth knowing: macOS lets two programs claim the same key combination without
telling either one, and whichever is listening closest to the hardware wins. If
a shortcut seems dead, something else on your Mac has taken it. **Press it while
that panel is open — the row lights up when the key reaches Shotly.** If it
never lights up, pick a different combination.

macOS keeps <kbd>⌘⇧3</kbd>, <kbd>⌘⇧4</kbd> and <kbd>⌘⇧5</kbd> for its own
screenshot tools, which is why Shotly ships on <kbd>⌃⇧</kbd>. To hand those keys
to Shotly, switch them off in System Settings first — there's a button on the
Hotkeys tab that opens the right pane.

---

## All the keys

**Anywhere:** <kbd>⌃⇧3</kbd>/<kbd>⌃⇧4</kbd>/<kbd>⌃⇧5</kbd> capture ·
<kbd>⌃⇧6</kbd> scrolling capture · <kbd>⌃⇧R</kbd> record / stop recording ·
<kbd>⌃⇧A</kbd> draw on the screen · <kbd>⌃⇧D</kbd> click through

**Editor:** <kbd>⌘Z</kbd> undo · <kbd>⌘⇧Z</kbd> redo · <kbd>⌘D</kbd> duplicate ·
<kbd>⌫</kbd> delete · <kbd>⌘A</kbd> select all · <kbd>⇥</kbd> next annotation ·
<kbd>[</kbd> <kbd>]</kbd> smaller/larger · <kbd>F</kbd> fill ·
<kbd>⇧S</kbd> shadow · <kbd>⌘]</kbd> <kbd>⌘[</kbd> forward/backward ·
<kbd>⏎</kbd> apply crop · <kbd>⌘=</kbd> <kbd>⌘−</kbd> zoom ·
<kbd>⌘0</kbd> fit · <kbd>⌘1</kbd> actual size · <kbd>⌘L</kbd> back to library ·
<kbd>⌘,</kbd> settings

**Drawing on the screen:** tool letters as above · <kbd>1</kbd>–<kbd>6</kbd>
colours · <kbd>[</kbd> <kbd>]</kbd> size · <kbd>D</kbd> move the toolbar ·
<kbd>C</kbd> clear · <kbd>S</kbd> next display · <kbd>esc</kbd> leave ·
<kbd>esc</kbd> <kbd>esc</kbd> leave and keep it

---

## Building it yourself

Everything about the source — running it locally, signing, architecture, and the
mistakes worth not repeating — is in [docs/DEVELOPING.md](docs/DEVELOPING.md).
Release mechanics are in [docs/RELEASING.md](docs/RELEASING.md).
