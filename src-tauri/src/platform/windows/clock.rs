//! What time it is here — on Windows.
//!
//! `localtime_r` is POSIX and does not exist in the MSVC runtime, which is why
//! this is a platform concern at all rather than a line in `commands.rs`.
//! `GetLocalTime` is the direct replacement and is simpler than the POSIX
//! version: it fills a `SYSTEMTIME` with the fields already broken out, with
//! no `tm_year`-is-since-1900 or `tm_mon`-is-zero-based corrections to
//! remember, and it cannot fail.
//!
//! Returns the epoch until implemented, which the caller's test rejects — see
//! `a_stamped_stem_reads_the_way_a_screenshot_name_does`, which pins the year
//! to a plausible range precisely so that a stub cannot pass for a clock.

/// The local date and time, as `(year, month, day, hour, minute, second)`.
pub fn local_now() -> (i32, u32, u32, u32, u32, u32) {
    (1970, 1, 1, 0, 0, 0)
}
