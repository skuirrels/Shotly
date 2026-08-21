# Changelog

What changed in each release, newest first. Versions before 0.10.10 are the
commit subjects as they were written at the time; from 0.10.10 the entries are
written for whoever is reading them in the update notice.

The release notes on GitHub and the "what's new" text the in-app updater shows
are both taken from this file — see `docs/RELEASING.md`. A version with nothing
written here cannot be published.

## 0.10.22 — 2026-08-21

- Shapes can be turned. Selections now have a handle on each of the four
  flat sides as well as the corners, and a green grip above the top edge
  that rotates whatever is selected — hold Shift to snap to 15°. The frame
  turns with the shape, so a handle on its top edge still stretches its
  top edge however far round it has been taken. Both in the editor and on
  the live annotation layer, where a whole selection turns as one piece.
- Pressing the annotation hotkey a second time no longer hangs Shotly.
  Ctrl+Shift+A with the layer already up froze the app outright — no
  drawing, no menu bar, no tray, force-quit only. It closes the layer, as
  it always meant to.

## 0.10.21 — 2026-08-20

- Pointing at a browser frames the page for as long as the app is running.
  The trim that removes a browser's toolbars used to stop working part way
  through a session — the outline would quietly go back to taking the whole
  window, and stay that way until Shotly was restarted. Chrome, Edge, Brave,
  and anything else built on Chromium: Slack, Teams, VS Code, Discord.

## 0.10.20 — 2026-08-20

- Pointing at a web page frames the whole page again. Capturing a browser
  outlined the page from below the site's own header — a repository's
  navigation, an app's coloured title bar — because the trim that removes the
  browser's toolbars kept going and took the site's with them. It now stops
  where the browser stops.

## 0.10.19 — 2026-08-20

- Rectangles have a corner radius. Square by default, which is what a box
  drawn round a button or a paragraph should be — the old fixed rounding was
  too slight to look deliberate and too much to look sharp. The control sits
  beside the stroke width, rounds a rectangle you have already drawn, and is
  remembered, so rounded or square stays whichever you chose.
- Shotly notices a new version sooner. The update check now asks for the
  release manifest without a cache in the way, so a version published minutes
  ago is not read as one that does not exist yet.

## 0.10.18 — 2026-08-20

- Capture what a window is showing, rather than the toolbars above it. Point at
  a page and Shotly frames the page; point at the ribbon and it frames the whole
  window, because that is what you pointed at. Captures of a Word document used
  to arrive with two inches of ribbon across the top to be cropped off by hand.
  Scroll up to take the whole window anyway, scroll down to tighten further in.
- The same in Chrome, Edge and Brave, which tell nothing to anyone about where
  their toolbars end. Where an application will not say, Shotly works it out
  from the window itself.
- Groundwork for a Windows version: everything platform-specific now lives in
  one place, and both platforms are built and checked on every push.

## 0.10.17 — 2026-08-19

- Capture works on every screen again. With more than one display, the
  crosshairs, the selection band and the window outline were only ever drawn
  on one of them — every other screen dimmed and then showed nothing at all,
  which made capturing there look broken.
- The menu bar offers one Capture Anything instead of separate Capture Region,
  Capture Window and Capture Screen items. It opens the same overlay the
  editor's Capture button does: click a window, click the desktop, or drag out
  an area. Capture Window from List is still there for a window that is hidden
  behind another.

## 0.10.16 — 2026-08-19

- The "what's new" list in the update notice reads properly again: a change
  described over several lines was arriving as several separate items.

## 0.10.15 — 2026-08-19

- Every update now says what changed. The notice that appears when a new
  version has been installed lists the release's changes instead of only its
  version number.

## 0.10.14 — 2026-08-19

- Dragging out an area now follows the pointer. The selection was drawn from
  where macOS said the pointer was, and during a capture it does not move,
  so the crosshairs stayed pinned to the corner however far you dragged.

## 0.10.13 — 2026-08-19

- Press and hold to start an area and crosshairs now mark the corner it starts
  from, instead of nothing happening until the pointer had travelled far enough
  to count as a drag.

## 0.10.12 — 2026-08-19

- One capture that takes whatever you point at: click a window for that window,
  click the desktop for the whole screen, or press and drag for an area. It is
  the default for the Capture button, and is called **Anything**.

## 0.10.11 — 2026-08-19

- The capture button says "Capture" rather than naming the mode it happens to
  be set to, which read as a filter instead of something to press.

## 0.10.10 — 2026-08-19

- Scrolling capture crosses a gap in the page. A chapter end taller than the
  screen used to stop the capture and blame you for scrolling too fast; now
  everything after the gap is captured too.
- Coming to rest on the bottom of the capture clears the warning, instead of
  leaving it up after you had already done what it asked.
- **New blank image** (⌘N): a canvas at your screen's density to paste captures
  onto and arrange by hand.
- **New image from clipboard** (⌘⇧V, and in the menu bar): whatever picture you
  copied, opened as a capture of its own.

## 0.10.9 — 2026-08-18

- Make scrolling capture work on a window at all

## 0.10.8 — 2026-08-18

- Point the stall warning the way the page actually went

## 0.10.7 — 2026-08-18

- Notice when a scrolling capture has been left behind

## 0.10.6 — 2026-08-18

- Let a text box be edited again, let ⌘Z undo the typing in it, and put recording in the app's capture menu

## 0.10.5 — 2026-08-18

- Give the keyboard its undo back

## 0.10.4 — 2026-08-18

- Give a pending crop its buttons, and stop the header clipping

## 0.10.3 — 2026-08-18

- Default to the exact cut, and give the view tabs their icons on top

## 0.10.2 — 2026-08-18

- Stop the rounding overshoot looking like a broken handle

## 0.10.1 — 2026-08-18

- Keep an exact cut in H.264, at the recording's own size and frame rate
- Put the marks' times under the handles

## 0.10.0 — 2026-08-18

- Drop an import the H.264 preset left behind
- Offer an exact cut, for when the mark has to be the mark

## 0.9.9 — 2026-08-18

- Close the last 15ms of a cut that could still leak

## 0.9.8 — 2026-08-18

- Make a cut out actually remove what it says it removes

## 0.9.7 — 2026-08-18

- Stop clipping the line that names the trim keys
- Describe sharing as it actually works

## 0.9.6 — 2026-08-18

- Cut a section out of the middle, and stop the trim freezing the app

## 0.9.5 — 2026-08-18

- Trim the dead air off a recording
- Pin the OAuth scope, because widening it cannot be undone

## 0.9.4 — 2026-08-18

- Refuse to ship an OAuth client Google has never heard of

## 0.9.3 — 2026-08-17

- Take the refresh token out of the login keychain
- Stop asking the keychain the same question over and over
- Make sharing a thing any cloud can do

## 0.9.2 — 2026-08-17

- Keep showing a library the cloud has taken the contents of

## 0.9.1 — 2026-08-17

- Use the client that is already there, instead of asking for it again
- Delete the OAuth client setup from the app entirely

## 0.9.0 — 2026-08-17

- Share to Drive the way every other app does it: narrow scope, own client

## 0.8.8 — 2026-08-17

- Let Shotly share a Drive link itself, with a connected account

## 0.8.7 — 2026-08-17

- Stop promising a Drive link is public, and offer the switch that makes it
- Write down what a Windows port would take

## 0.8.6 — 2026-08-17

- Copy a Drive link to a capture, without connecting an account

## 0.8.5 — 2026-08-17

- Centre a live callout's words, and give it the neon inks

## 0.8.4 — 2026-08-17

- Neon callouts on the live screen, opening at login, and the address in About

## 0.8.3 — 2026-08-17

- Serve recordings from a worker thread, and open from the rail in one click

## 0.8.2 — 2026-08-17

- Stop the main thread reading files, and centre callout text in WebKit

## 0.8.1 — 2026-08-17

- Neon: draw a callout, a rect or an ellipse as a lit sign

## 0.8.0 — 2026-08-17

- Play recordings in Shotly rather than handing them to QuickTime

## 0.7.9 — 2026-08-17

- Test the recording flow, and stop the timing tests measuring the machine

## 0.7.8 — 2026-08-17

- Keep thumbnails off the main thread

## 0.7.7 — 2026-08-17

- Show recordings in the library, and let the panel find its own phase

## 0.7.6 — 2026-08-17

- Put the recording panel in front, and every overlay on the right Space

## 0.7.5 — 2026-08-17

- Record the screen: an area, a window, or the whole display

## 0.7.4 — 2026-08-17

- Give the hotkeys a settings screen, and three ways to reach it

## 0.7.3 — 2026-08-17

- Select, multi-select and delete from the recents rail

## 0.7.2 — 2026-08-17

- Stop the annotation layer bricking the screen, and opening where you can't see it

## 0.7.1 — 2026-08-17

- One capture overlay per display

## 0.7.0 — 2026-08-17

- core-graphics 0.24 -> 0.25, and drop events properly

## 0.6.9 — 2026-08-17

- Take the safe dependency updates
- Show the desktop while choosing a scrolling capture, and snap to a window

## 0.6.8 — 2026-08-16

- Ask for accessibility when the wheel needs it, and read a trackpad's scroll

## 0.6.7 — 2026-08-16

- Send the toolbar's Window button through Rust like the hotkey

## 0.6.6 — 2026-08-16

- Bring the window to the Space you are on

## 0.6.5 — 2026-08-16

- Escape leaves the annotation layer; twice keeps it

## 0.6.4 — 2026-08-16

- Switch the tap back on instead of ending the session

## 0.6.3 — 2026-08-16

- Draw the outline on the desktop, not on a black screen
- Find the window under the pointer in the window list, not accessibility
- Remember the colour and stroke width

## 0.6.2 — 2026-08-16

- Name screen annotation in the README

## 0.6.1 — 2026-08-16

- Remember which tool was in hand

## 0.6.0 — 2026-08-16

- Give arrows weight, and a shaft that doesn't taper
- Drop the chevron from Save

## 0.5.0 — 2026-08-16

- Always link to the newest disk image
- Outline the window under the pointer, from accessibility

## 0.4.0 — 2026-08-16

- Pick a window to capture by looking at it

## 0.3.3 — 2026-08-16

- Remove the window-picker outline: it could not tell the truth

## 0.3.2 — 2026-08-16

- Fix scrolling capture losing the thread on an ordinary scroll

## 0.3.1 — 2026-08-16

- Give the scrolling overlay the watchdog the annotation layer has

## 0.3.0 — 2026-08-16

- Tell the docs about measuring and combining
- Combine captures onto one canvas, and room to arrange them
- Measure distances, with the ends snapped to real edges
- Double Escape leaves annotation mode without saving

## 0.2.0 — 2026-08-16

- Show the scroll HUD in the harness, and restore the editor on an early finish
- Tell the README about codes, resizing and scrolling capture
- Scrolling capture: a page taller than the screen, in one piece
- A browser harness for the exporter and the editor's dialogs
- Resize the export without touching the capture
- Read QR codes and barcodes in the same look as the text

## 0.1.18 — 2026-08-16

- Keep a second copy of every capture

## 0.1.17 — 2026-08-16

- Frame a capture for sharing
- Point the README at people who use Shotly

## 0.1.16 — 2026-08-16

- Pin a capture to the front of the screen

## 0.1.15 — 2026-08-16

- Read the text back out of a capture

## 0.1.14 — 2026-08-16

- Let the system-wide hotkeys be changed

## 0.1.13 — 2026-08-16

- Dock the annotation toolbar to any edge

## 0.1.12 — 2026-08-16

- Step out of the annotation layer without packing it away
- Right-click the canvas

## 0.1.11 — 2026-08-16

- Put Export on the bar, and send it to Downloads

## 0.1.10 — 2026-08-16

- Give the library a date tree and a search field

## 0.1.9 — 2026-08-16

- Lay one image over another
- Size step badges and callout text for what they are

## 0.1.8 — 2026-08-16

- Keep a callout's fill under the words while typing
- Add a callout: a box you drag out and then type into
- Put flattened export next to Save, where it can be found
- Keep recent captures alongside the one being edited
- Record the version going in, not the one on its way out

## 0.1.7 — 2026-08-15

- Start annotations big enough to read
- Say which build is running in the About panel

## 0.1.6 — 2026-08-15

- Add spotlight, freehand and an eyedropper to the editor

## 0.1.5 — 2026-08-15

- Add a text tool to screen annotation
- Make live annotations objects you can select and edit
- Keep the annotation toolbar reachable, and let it be moved
- Annotate whichever screen you are pointing at

## 0.1.4 — 2026-08-15

- Keep markup editable in saved captures

## 0.1.3 — 2026-08-15

- Move an annotation by dragging it, whatever tool is active
- Give the library a right-click menu
- Return the version to 0.1.1
- Have the bump script move Cargo.lock too
- Sync Cargo.lock to 0.1.2
- Record which identity signed the last release

## 0.1.1 — 2026-08-15

- Keep failed background update checks to the log
- Update Shotly in place, automatically
- Label the capture button with the mode it runs

## 0.1.0 — 2026-08-15

- Replace the stock Tauri logo with Shotly's own icon
- Build the release profile for speed rather than size
