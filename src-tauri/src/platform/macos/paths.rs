//! Where an application is allowed to keep its own files.

/// `~/Library/Application Support/<id>`, the conventional home for state a
/// user never edits by hand.
///
/// Falls back to the temporary directory rather than failing: losing a stored
/// sign-in is recoverable, and refusing to start is not.
pub fn config_dir(id: &str) -> std::path::PathBuf {
    std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("Library/Application Support")
        .join(id)
}
