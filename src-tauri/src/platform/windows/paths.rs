//! Where an application is allowed to keep its own files — on Windows.

/// `%APPDATA%\<id>` — the roaming application-data folder, which is the
/// counterpart to `~/Library/Application Support`.
///
/// Roaming rather than local on purpose: what is kept here is a sign-in and a
/// handful of preferences, which are exactly the things a domain user expects
/// to follow them between machines.
pub fn config_dir(id: &str) -> std::path::PathBuf {
    std::env::var("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join(id)
}

/// Make a file readable by its owner and nobody else.
///
/// No mode bits here: the equivalent is an ACL naming the current user and
/// nothing else, set with `SetNamedSecurityInfo` after removing inheritance —
/// otherwise the file keeps whatever the parent directory grants.
///
/// Returning `Ok` until then is the deliberate choice, and it is worth being
/// clear about what it costs: the stored refresh token would sit under the
/// default ACL for the user's own AppData, which other administrators on the
/// machine can read. That is a smaller exposure than it sounds — a
/// `drive.file` token reaches only the files Shotly itself created — but it
/// is a real one, and it must be closed before Windows ships rather than
/// after. Refusing instead would make signing in fail outright, which trades
/// a narrow exposure for a broken feature.
pub fn restrict_to_owner(_path: &std::path::Path) -> Result<(), String> {
    Ok(())
}
