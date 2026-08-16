# Shotly

Screenshots for macOS: capture, mark up, and get on with your day.

Shotly takes the shot, opens it in an editor built for annotating rather than
retouching, and keeps everything you capture in one folder you can actually
find. It stays out of the way in the menu bar until you press a key.

---

## Install

1. Download the latest `Shotly.dmg` from
   [Releases](https://github.com/skuirrels/shotly/releases/latest).
2. Open it and drag **Shotly** to Applications.
3. Launch it. macOS asks once for **Screen Recording** permission — click
   **Allow**. Nothing can take a screenshot without it.
4. Quit and reopen Shotly, because macOS only applies that permission to a
   freshly started app.

Shotly lives in the menu bar. Closing its window puts it away rather than
quitting it, so the capture keys keep working.

It updates itself: it checks shortly after launch and every six hours, installs
quietly in the background, and offers you a relaunch when it's ready. **Check
for Updates…** in the menu bar does it on demand.

---

## Taking a shot

Four keys, and they work in any app:

| | |
|---|---|
| <kbd>⌃⇧4</kbd> | **Region** — drag out the part of the screen you want |
| <kbd>⌃⇧5</kbd> | **Window** — click a window and Shotly takes it whole |
| <kbd>⌃⇧3</kbd> | **Full screen** |
| <kbd>⌃⇧6</kbd> | **Scrolling capture** — a whole page, taller than the screen |

They're on Control-Shift rather than Command-Shift because macOS already owns
Command-Shift-3/4/5 for its own screenshot tools, and quietly stealing those
would be rude. **You can change any of them** — see
[Changing the keys](#changing-the-keys).

Region and window selection use the macOS selector you already know, complete
with its magnifier and pixel readout.

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

## Drawing on the live screen

<kbd>⌃⇧A</kbd> puts a drawing layer over your actual desktop — for explaining
something on a call or a screen share, where marking up a static picture is no
use.

Draw with the same tools. When you need to *use* the machine underneath,
<kbd>⌃⇧D</kbd> hands the mouse back to the desktop and your drawings stay put on
top; press it again to carry on drawing. Press <kbd>⌃⇧A</kbd> again to leave,
and the screen — drawings and all — is saved to your library.

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

<kbd>⌘/</kbd> → **System-wide**. Click any shortcut and press a new combination.
It takes effect immediately.

Worth knowing: macOS lets two programs claim the same key combination without
telling either one, and whichever is listening closest to the hardware wins. If
a shortcut seems dead, something else on your Mac has taken it. **Press it while
that panel is open — the row lights up when the key reaches Shotly.** If it
never lights up, pick a different combination.

---

## All the keys

**Anywhere:** <kbd>⌃⇧3</kbd>/<kbd>⌃⇧4</kbd>/<kbd>⌃⇧5</kbd> capture ·
<kbd>⌃⇧6</kbd> scrolling capture · <kbd>⌃⇧A</kbd> draw on the screen ·
<kbd>⌃⇧D</kbd> click through

**Editor:** <kbd>⌘Z</kbd> undo · <kbd>⌘⇧Z</kbd> redo · <kbd>⌘D</kbd> duplicate ·
<kbd>⌫</kbd> delete · <kbd>⌘A</kbd> select all · <kbd>⇥</kbd> next annotation ·
<kbd>[</kbd> <kbd>]</kbd> smaller/larger · <kbd>F</kbd> fill ·
<kbd>⇧S</kbd> shadow · <kbd>⌘]</kbd> <kbd>⌘[</kbd> forward/backward ·
<kbd>⏎</kbd> apply crop · <kbd>⌘=</kbd> <kbd>⌘−</kbd> zoom ·
<kbd>⌘0</kbd> fit · <kbd>⌘1</kbd> actual size · <kbd>⌘L</kbd> back to library

**Drawing on the screen:** tool letters as above · <kbd>1</kbd>–<kbd>6</kbd>
colours · <kbd>[</kbd> <kbd>]</kbd> size · <kbd>D</kbd> move the toolbar ·
<kbd>C</kbd> clear · <kbd>S</kbd> next display

---

## Building it yourself

Everything about the source — running it locally, signing, architecture, and the
mistakes worth not repeating — is in [docs/DEVELOPING.md](docs/DEVELOPING.md).
Release mechanics are in [docs/RELEASING.md](docs/RELEASING.md).
