//! General utilities shared across the application.

use std::time::{SystemTime, UNIX_EPOCH};

// ─────────────────────────────────────────────────────────────────────────────
// Time Utilities
// ─────────────────────────────────────────────────────────────────────────────

/// Returns the current Unix timestamp in milliseconds.
///
/// Returns 0 if the system clock is before the Unix epoch (shouldn't happen in practice).
#[must_use]
pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ─────────────────────────────────────────────────────────────────────────────
// Process Priority
// ─────────────────────────────────────────────────────────────────────────────

/// Elevates process priority to reduce audio stuttering during CPU load.
///
/// This helps ensure the HTTP streaming server can keep up with Sonos audio
/// requests even when other processes are consuming CPU resources.
///
/// # Platform behavior
///
/// - **Windows**: Sets `HIGH_PRIORITY_CLASS` (not REALTIME, which can cause
///   system instability). This gives the process priority over normal applications.
///
/// - **Linux**: Sets nice value to -10 (higher priority). Requires either:
///   - Root privileges, OR
///   - `CAP_SYS_NICE` capability (`setcap cap_sys_nice+ep <binary>`), OR
///   - Membership in the `pipewire` group (on some distros)
///
/// - **macOS**: Sets nice value to -10 (higher priority). Typically requires
///   root privileges or appropriate entitlements.
///
/// - **Other Unix** (BSD, etc.): Attempts nice value -10, may require root.
///
/// # Errors
///
/// Logs warnings if priority elevation fails but does not panic. The application
/// will continue at normal priority, which may result in audio stuttering under
/// heavy CPU load.
pub fn raise_process_priority() {
    #[cfg(target_os = "windows")]
    raise_priority_windows();

    #[cfg(unix)]
    raise_priority_unix();
}

#[cfg(target_os = "windows")]
fn raise_priority_windows() {
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, SetPriorityClass, HIGH_PRIORITY_CLASS,
    };

    // SAFETY: GetCurrentProcess returns a pseudo-handle that doesn't need closing.
    // SetPriorityClass is safe to call with a valid process handle.
    let result = unsafe {
        let process = GetCurrentProcess();
        SetPriorityClass(process, HIGH_PRIORITY_CLASS)
    };

    if result != 0 {
        log::info!("Process priority elevated to HIGH_PRIORITY_CLASS");
    } else {
        log::warn!(
            "Failed to elevate process priority. Audio may stutter under CPU load. \
             Error code: {}",
            std::io::Error::last_os_error()
        );
    }
}

#[cfg(unix)]
fn raise_priority_unix() {
    // Platform-specific errno pointer access
    #[cfg(target_os = "linux")]
    unsafe fn errno_ptr() -> *mut i32 {
        libc::__errno_location()
    }

    #[cfg(target_os = "macos")]
    unsafe fn errno_ptr() -> *mut i32 {
        libc::__error()
    }

    // BSD and other Unix: use errno location from libc (may vary by platform)
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    unsafe fn errno_ptr() -> *mut i32 {
        // Fall back to __errno_location which most BSDs provide
        libc::__errno_location()
    }

    // SAFETY: getpriority and setpriority are standard POSIX functions.
    // Using PRIO_PROCESS with pid 0 targets the current process.
    unsafe {
        // Clear errno before calling getpriority (it can legitimately return -1)
        *errno_ptr() = 0;

        let current_priority = libc::getpriority(libc::PRIO_PROCESS, 0);

        // Check if getpriority failed
        if current_priority == -1 && *errno_ptr() != 0 {
            log::warn!(
                "Failed to get current process priority: {}",
                std::io::Error::last_os_error()
            );
            return;
        }

        // Try to set nice value to -10 (higher priority)
        // This requires elevated privileges (root, CAP_SYS_NICE on Linux, etc.)
        let result = libc::setpriority(libc::PRIO_PROCESS, 0, -10);

        if result == 0 {
            log::info!(
                "Process priority elevated to nice -10 (was {})",
                current_priority
            );
        } else {
            log::warn!(
                "Failed to elevate process priority (nice -10). Audio may stutter under CPU load. \
                 Current nice: {}. Error: {}",
                current_priority,
                std::io::Error::last_os_error()
            );
        }
    }
}
