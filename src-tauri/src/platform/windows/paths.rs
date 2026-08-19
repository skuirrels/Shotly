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
