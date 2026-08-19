//! The Windows implementations, one module per concern.
//!
//! Compiled for every target that is not macOS, so this is also what keeps the
//! portability check in `.github/workflows/ci.yml` meaningful: a concern with
//! no module here is a concern that has not been thought about yet.

pub mod chrome;
pub mod clock;
pub mod editor;
pub mod paths;
pub mod pointer;
pub mod recorder;
pub mod shell;
pub mod text;
