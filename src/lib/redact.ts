/**
 * Spotting the things in a screenshot that should not have been in it.
 *
 * A screenshot taken to report a bug is nearly always taken in a hurry, and
 * what ends up in the corner of it is an email address, a bearer token, or the
 * card number on a settings page. Covering those by hand means noticing them
 * first, which is the part people are bad at — so this reads the lines the
 * recogniser already found and says which of them are worth hiding.
 *
 * # What it deliberately is not
 *
 * It is not a guarantee, and nothing in the interface should imply one. These
 * are patterns, and patterns miss things: a secret with no shape to it, text
 * the recogniser could not read, a name that only matters in context. It is a
 * first pass that catches the obvious, and the user still has the blur tool.
 *
 * The other half of that judgement is which way to be wrong. A false positive
 * costs one undo; a false negative ships a key. So where a rule is a close
 * call it errs towards covering — but not so far that scanning a normal
 * screenshot blurs half of it, because a tool that over-reaches gets turned
 * off and then catches nothing at all.
 */

/** What was found, phrased for a message the user will read once. */
export type Sensitive =
  | "an email address"
  | "a card number"
  | "a key or token"
  | "an IP address"
  | "a password";

/** `name@example.com`, allowing for the recogniser's spacing. */
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/**
 * A run of digits long enough to be a card, however it is grouped.
 *
 * Checked against Luhn afterwards, which is what keeps this from covering
 * every order number and timestamp in the picture.
 */
const DIGITS = /\d(?:[ -]?\d){12,18}/;

/** Prefixes that are only ever the start of a credential. */
const KEY_PREFIX =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|pk_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|ya29\.[A-Za-z0-9_-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/;

/** `Authorization: Bearer …`, and the same idea written a few other ways. */
const BEARER = /\b(?:bearer|authorization|api[_ -]?key|access[_ -]?token)\b[\s:=]+\S{8,}/i;

/** A field that names itself. */
const PASSWORD = /\b(?:password|passphrase|secret)\b[\s:=]+\S{4,}/i;

/** Four dotted octets, each in range — so version numbers are left alone. */
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/;

/**
 * A long opaque run of key-ish characters.
 *
 * The loosest rule here, and the one most likely to be wrong, so it asks for
 * three things at once: length, and both letters and digits, and no spaces.
 * Prose does not look like this; a hash, a token and a session id all do.
 */
const OPAQUE = /\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{28,}\b/;

/** Words that mean the long number beside them is a date or a version. */
const NOT_A_CARD = /\b(?:version|build|v\d|revision|copyright|©)\b/i;

/**
 * The Luhn check every card number satisfies and almost nothing else does.
 *
 * One in ten random digit runs passes by chance, which is why this is the
 * second half of the test rather than the whole of it.
 */
export function luhn(digits: string): boolean {
  const clean = digits.replace(/\D/g, "");
  if (clean.length < 13 || clean.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let i = clean.length - 1; i >= 0; i--) {
    let d = clean.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * What, if anything, in this line is worth covering.
 *
 * One answer per line rather than a list, because a line is the unit that gets
 * blurred: the recogniser gives a box per line, and covering half of one would
 * need per-word geometry that Vision does not hand back with the text.
 */
export function looksSensitive(text: string): Sensitive | null {
  const line = text.trim();
  if (line.length < 4) return null;

  if (EMAIL.test(line)) return "an email address";
  if (PASSWORD.test(line)) return "a password";
  if (KEY_PREFIX.test(line) || BEARER.test(line)) return "a key or token";

  const digits = DIGITS.exec(line);
  if (digits && !NOT_A_CARD.test(line) && luhn(digits[0])) return "a card number";

  // Last, and after the card check: a card number written without spaces would
  // otherwise be reported as a token, which is true but less useful.
  if (OPAQUE.test(line)) return "a key or token";
  if (IPV4.test(line)) return "an IP address";

  return null;
}

/**
 * A one-line summary of a pass, for the toast afterwards.
 *
 * Names what was found rather than only counting it. "Covered 3 things" invites
 * a hunt for what they were; "an email address and two keys" tells you whether
 * to trust it before you look.
 */
export function describeFindings(found: Sensitive[]): string {
  if (found.length === 0) return "Nothing here looks sensitive";

  const counts = new Map<Sensitive, number>();
  for (const kind of found) counts.set(kind, (counts.get(kind) ?? 0) + 1);

  const parts = [...counts].map(([kind, n]) => (n === 1 ? kind : `${n}× ${kind}`));
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Blurred ${list}`;
}
