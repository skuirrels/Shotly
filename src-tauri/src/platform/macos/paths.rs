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

/// Make a file readable by its owner and nobody else.
///
/// Mode `0600`. Used for the stored refresh token, which is the one file
/// Shotly writes that would matter to anyone else who could read it.
pub fn restrict_to_owner(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("could not lock down {path:?}: {e}"))
}
