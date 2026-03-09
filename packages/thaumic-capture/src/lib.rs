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
/// Checks Windows build number >= 20348 via registry query.
/// Always returns `false` on non-Windows platforms.
pub fn wasapi_available() -> bool {
    #[cfg(windows)]
    {
        check_windows_build() >= 20348
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(windows)]
fn check_windows_build() -> u32 {
    let output = std::process::Command::new("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion",
            "/v",
            "CurrentBuildNumber",
        ])
        .output();

    match output {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout);
            text.lines()
                .find(|l| l.contains("CurrentBuildNumber"))
                .and_then(|l| l.split_whitespace().last())
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(0)
        }
        Err(_) => 0,
    }
}
