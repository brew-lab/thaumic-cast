//! Platform-specific audio capture for Thaumic Cast.
//!
//! Provides WASAPI process-specific loopback capture on Windows and
//! browser PID discovery utilities. On non-Windows platforms, the crate
//! compiles as a stub with `wasapi_available()` returning `false`.

#[cfg(windows)]
mod pid;
#[cfg(windows)]
mod wasapi;

#[cfg(windows)]
pub use pid::{find_browser_pid_by_name, find_browser_pids, BrowserProcess};
#[cfg(windows)]
pub use wasapi::WasapiSource;

/// Runtime check for WASAPI process loopback availability.
///
/// Checks that the Windows build number is at least 20348. The build is read
/// in-process with `RtlGetVersion`, which manifests cannot make lie, rather than
/// by starting a program: a console program started from the desktop app
/// flashes a window, and this is asked on every `/health` request.
/// Always returns `false` on non-Windows platforms.
pub fn wasapi_available() -> bool {
    #[cfg(windows)]
    {
        windows_version::OsVersion::current().build >= 20348
    }
    #[cfg(not(windows))]
    {
        false
    }
}
