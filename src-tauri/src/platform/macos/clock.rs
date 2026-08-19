//! What time it is here.
//!
//! `SystemTime` knows how many seconds have passed since 1970 and nothing at
//! all about the timezone the person is sitting in, so naming a capture
//! "Shotly 2026-08-14 at 18.33.21" needs one call the standard library does
//! not have. This is that call, and it is the whole of the module.

/// The local date and time, as `(year, month, day, hour, minute, second)`.
///
/// Month and day are 1-based, the way a person writes them.
pub fn local_now() -> (i32, u32, u32, u32, u32, u32) {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as libc::time_t;

    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: `localtime_r` fills a caller-owned `tm` and touches nothing else;
    // both pointers are to live stack values. The `_r` form is the one that can
    // be called from any thread.
    unsafe {
        libc::localtime_r(&secs, &mut tm);
    }

    (
        tm.tm_year + 1900,
        tm.tm_mon as u32 + 1,
        tm.tm_mday as u32,
        tm.tm_hour as u32,
        tm.tm_min as u32,
        tm.tm_sec as u32,
    )
}
