/**
 * Which pane fills the window.
 *
 * Deliberately independent of whether a capture is open: switching to the
 * library used to mean *closing* the capture, so glancing at earlier shots
 * threw away the annotations in progress. Keeping the two separate means the
 * editor is still there, mid-edit, when you switch back.
 */
export type View = "editor" | "library";
