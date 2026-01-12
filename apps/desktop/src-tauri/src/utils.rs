//! General utilities shared across the application.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use local_ip_address::local_ip;
use thiserror::Error;

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
// Network Utilities
// ─────────────────────────────────────────────────────────────────────────────

/// Errors that can occur during network operations.
#[derive(Debug, Error)]
pub enum NetworkError {
    /// Failed to determine the local IP address.
    #[error("failed to detect local IP address: {0}")]
    LocalIpDetection(String),
}

/// Detects the local IP address of this machine.
///
/// Returns the primary local IP address that can be used for network communication.
/// This is typically the IP on the LAN that other devices (like Sonos speakers) can reach.
pub fn detect_local_ip() -> Result<String, NetworkError> {
    local_ip()
        .map(|ip| ip.to_string())
        .map_err(|e| NetworkError::LocalIpDetection(e.to_string()))
}

/// Trait for detecting the local IP address.
///
/// This abstraction allows for dependency injection and easier testing.
/// Implementations can use different strategies for IP detection (system calls,
/// manual configuration, mocks for testing, etc.).
pub trait IpDetector: Send + Sync {
    /// Detects the local IP address.
    ///
    /// Returns the detected IP as a string, or an error if detection fails.
    fn detect(&self) -> Result<String, NetworkError>;
}

/// Default implementation that uses the system's local IP detection.
///
/// This wraps the `local_ip_address` crate to detect the primary local IP address.
#[derive(Debug, Clone, Default)]
pub struct LocalIpDetector;

impl LocalIpDetector {
    /// Creates a new LocalIpDetector.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Creates a new LocalIpDetector wrapped in an Arc.
    #[must_use]
    pub fn arc() -> Arc<dyn IpDetector> {
        Arc::new(Self::new())
    }
}

impl IpDetector for LocalIpDetector {
    fn detect(&self) -> Result<String, NetworkError> {
        detect_local_ip()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// URL Building
// ─────────────────────────────────────────────────────────────────────────────

/// Builds URLs for the local HTTP server.
///
/// Centralizes URL construction to ensure consistent formatting across the codebase.
/// If the base URL format changes, only this struct needs updating.
#[derive(Debug, Clone)]
pub struct UrlBuilder {
    ip: String,
    port: u16,
}

impl UrlBuilder {
    /// Creates a new UrlBuilder for the given server address.
    pub fn new(ip: impl Into<String>, port: u16) -> Self {
        Self {
            ip: ip.into(),
            port,
        }
    }

    /// Returns the base URL for the server (e.g., `http://192.168.1.100:8080`).
    pub fn base_url(&self) -> String {
        format!("http://{}:{}", self.ip, self.port)
    }

    /// Builds a live audio stream URL for the given stream ID.
    ///
    /// Returns URL in format: `http://{ip}:{port}/stream/{stream_id}/live`
    pub fn stream_url(&self, stream_id: &str) -> String {
        format!("{}/stream/{}/live", self.base_url(), stream_id)
    }

    /// Builds the GENA callback URL for receiving Sonos event notifications.
    ///
    /// Returns URL in format: `http://{ip}:{port}/api/sonos/notify`
    pub fn gena_callback_url(&self) -> String {
        format!("{}/api/sonos/notify", self.base_url())
    }

    /// Builds the URL for the static app icon (for Sonos album art).
    ///
    /// Returns URL in format: `http://{ip}:{port}/icon.png`
    pub fn icon_url(&self) -> String {
        format!("{}/icon.png", self.base_url())
    }
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
        // If this fails to compile on a specific platform, add a cfg for it
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
