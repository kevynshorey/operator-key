//! Renderer initialization must run before GTK/WebKit or application threads start.
use std::ffi::{OsStr, OsString};

const COMPOSITING_ENV: &str = "WEBKIT_DISABLE_COMPOSITING_MODE";

fn default_override(existing: Option<&OsStr>) -> Option<OsString> {
    existing.is_none().then(|| OsString::from("1"))
}

/// Apply the Linux default before any application or GTK/WebKit threads exist.
/// Keep this as the first call in main.rs; do not move it into Tauri setup or IPC.
/// Environment mutation relies on this single-threaded startup invariant.
pub fn configure() {
    if let Some(value) = default_override(std::env::var_os(COMPOSITING_ENV).as_deref()) {
        // Called only from main, before starting Tauri/GTK and their worker threads.
        std::env::set_var(COMPOSITING_ENV, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_linux_launch_disables_accelerated_compositing() {
        assert_eq!(default_override(None), Some(OsString::from("1")));
    }

    #[test]
    fn explicit_accelerated_rendering_is_respected() {
        assert_eq!(default_override(Some(OsStr::new("0"))), None);
    }

    #[test]
    fn explicit_software_rendering_is_respected() {
        assert_eq!(default_override(Some(OsStr::new("1"))), None);
    }

    #[test]
    fn other_explicit_values_are_not_silently_overwritten() {
        assert_eq!(default_override(Some(OsStr::new(""))), None);
        assert_eq!(default_override(Some(OsStr::new("custom"))), None);
    }
}
