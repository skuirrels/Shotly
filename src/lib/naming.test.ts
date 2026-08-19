/**
 * Pins the capture name shape shared with `stamped_stem` in
 * `src-tauri/src/commands.rs` — the two must not drift, and the Rust side has
 * the matching test (`a_stamped_stem_reads_the_way_a_screenshot_name_does`).
 */
import { expect, test } from "vitest";
import { captureStem } from "./naming";

test("a stem reads the way a macOS screenshot name does", () => {
  expect(captureStem(new Date(2026, 7, 14, 18, 33, 21))).toBe("Shotly 2026-08-14 at 18.33.21");
});

test("single digits are padded so names sort chronologically", () => {
  expect(captureStem(new Date(2026, 0, 2, 3, 4, 5))).toBe("Shotly 2026-01-02 at 03.04.05");
});
