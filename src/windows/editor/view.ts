/**
 * Which pane fills the window.
 *
 * Deliberately independent of whether a capture is open: switching to the
 * library used to mean *closing* the capture, so glancing at earlier shots
 * threw away the annotations in progress. Keeping the two separate means the
 * editor is still there, mid-edit, when you switch back.
 *
 * `player` is the same bargain for recordings — it holds the movie you were
 * watching while you go and look at something else.
 */
export type View = "editor" | "library" | "player";
