/**
 * Pins what the automatic redaction covers, and — at least as important —
 * what it leaves alone.
 *
 * The failure that matters most is not a miss, it is over-reach: a pass that
 * blurs half of an ordinary screenshot gets switched off, and a tool that is
 * switched off catches nothing. So there are as many tests below for prose,
 * version numbers and timestamps staying clear as there are for secrets being
 * caught.
 */
import { expect, test } from "vitest";
import { describeFindings, looksSensitive, luhn } from "./redact";

test("an email address is caught however it is written", () => {
  expect(looksSensitive("Signed in as ty.omidi@gmail.com")).toBe("an email address");
  expect(looksSensitive("to: a+b@sub.example.co.uk")).toBe("an email address");
});

test("the well-known key prefixes are caught", () => {
  for (const line of [
    "sk-proj-abc123DEF456ghi789JKL",
    "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
    "AKIAIOSFODNN7EXAMPLE",
    "xoxb-2334-4432-aabbccddeeff",
    "pk_live_51H8xKzLkdIwHu7ix",
  ]) {
    expect(looksSensitive(line)).toBe("a key or token");
  }
});

test("a header that names a credential is caught even when the value is short", () => {
  expect(looksSensitive("Authorization: Bearer abcd1234")).toBe("a key or token");
  expect(looksSensitive("api_key = 9f8e7d6c")).toBe("a key or token");
});

test("a field that names itself a password is caught", () => {
  expect(looksSensitive("password: hunter2!")).toBe("a password");
  expect(looksSensitive("Secret = swordfish")).toBe("a password");
});

test("a card number is caught, and a long number that is not one is not", () => {
  // A standard test number, which is Luhn-valid.
  expect(looksSensitive("4242 4242 4242 4242")).toBe("a card number");
  expect(looksSensitive("4111-1111-1111-1111")).toBe("a card number");
  // One digit off: no longer passes Luhn, so nothing claims it is a card.
  expect(looksSensitive("4242 4242 4242 4243")).not.toBe("a card number");
});

test("Luhn does the work the length check cannot", () => {
  expect(luhn("4242424242424242")).toBe(true);
  expect(luhn("4242424242424243")).toBe(false);
  // Too short and too long are both not cards, whatever the checksum says.
  expect(luhn("42424")).toBe(false);
  expect(luhn("42424242424242424242")).toBe(false);
});

test("an IP address is caught and a version number is not", () => {
  expect(looksSensitive("Connected to 192.168.1.104")).toBe("an IP address");
  expect(looksSensitive("Shotly 0.10.22")).toBeNull();
  expect(looksSensitive("999.1.1.1 is not an address")).toBeNull();
});

test("ordinary text is left alone", () => {
  for (const line of [
    "File Edit View Window Help",
    "The quick brown fox jumps over the lazy dog",
    "Save to Documents/Shotly",
    "Last modified 2026-08-21 at 14:22:07",
    "Total 1,284 items · 4.2 GB",
    "https://github.com/skuirrels/Shotly/releases",
    "Build 24A335 (macOS 15.1)",
  ]) {
    expect(looksSensitive(line)).toBeNull();
  }
});

test("something too short to be anything is left alone", () => {
  expect(looksSensitive("ok")).toBeNull();
  expect(looksSensitive("   ")).toBeNull();
});

test("an opaque run needs letters, digits and length all at once", () => {
  // A session id: no spaces, mixed, long.
  expect(looksSensitive("s%3A9fT2kQ8vLm4XcR1nB7dY0pW5eH6jA3zU")).toBe("a key or token");
  // Long, but all letters — a word, not a token.
  expect(looksSensitive("antidisestablishmentarianismandthensome")).toBeNull();
  // Mixed, but short.
  expect(looksSensitive("abc123def")).toBeNull();
});

test("the summary names what was found rather than only counting it", () => {
  expect(describeFindings([])).toBe("Nothing here looks sensitive");
  expect(describeFindings(["an email address"])).toBe("Blurred an email address");
  expect(describeFindings(["a key or token", "a key or token"])).toBe(
    "Blurred 2× a key or token",
  );
  expect(describeFindings(["an email address", "a card number", "an IP address"])).toBe(
    "Blurred an email address, a card number and an IP address",
  );
});
