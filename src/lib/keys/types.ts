import type { ReactNode } from "react";

export type CommandGroup =
  | "Tools"
  | "Edit"
  | "Style"
  | "Arrange"
  | "View"
  | "Capture"
  | "Export";

export interface Command {
  id: string;
  title: string;
  group: CommandGroup;
  /** Authored form, e.g. "Mod+Shift+Z". Undefined means palette-only. */
  shortcut?: string;
  /** Extra shortcut that does the same thing (⌫ and ⌦ both delete). */
  altShortcut?: string;
  icon?: ReactNode;
  /** Fuzzy-search aliases for the command palette. */
  keywords?: string;
  /** Hidden from the palette and cheat sheet, but still bound. */
  hidden?: boolean;
  /** Fires even while a text field has focus. Reserve for ⌘-based commands. */
  allowWhileTyping?: boolean;
  /** When false the command is greyed out and its shortcut is inert. */
  enabled?: () => boolean;
  run: () => void;
}
