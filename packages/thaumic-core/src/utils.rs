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

// ─────────────────────────────────────────────────────────────────────────────
// IP Address Validation
// ─────────────────────────────────────────────────────────────────────────────

use std::net::{IpAddr, Ipv4Addr};

use crate::error::ErrorCode;

/// Error returned when an IP address is not valid for a Sonos speaker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IpValidationError {
    /// IPv6 addresses are not supported (Sonos uses IPv4).
    Ipv6NotSupported,
    /// Loopback address (127.x.x.x).
    Loopback,
    /// Unspecified address (0.0.0.0).
    Unspecified,
    /// Broadcast address (255.255.255.255).
    Broadcast,
    /// Multicast address (224.0.0.0/4).
    Multicast,
    /// Link-local address (169.254.x.x).
    LinkLocal,
}

impl ErrorCode for IpValidationError {
    /// Returns the error code string for API responses.
    ///
    /// Desktop UI expects `"invalid_ip"` for all validation errors.
    fn code(&self) -> &'static str {
        "invalid_ip"
    }
}

impl IpValidationError {
    /// Returns a human-readable description of the error.
    #[must_use]
    pub fn message(&self) -> &'static str {
        match self {
            Self::Ipv6NotSupported => "IPv6 addresses are not supported; Sonos speakers use IPv4",
            Self::Loopback => "Loopback addresses cannot be Sonos speakers",
            Self::Unspecified => "Unspecified address (0.0.0.0) is not valid",
            Self::Broadcast => "Broadcast addresses cannot be Sonos speakers",
            Self::Multicast => "Multicast addresses cannot be Sonos speakers",
            Self::LinkLocal => "Link-local addresses (169.254.x.x) cannot be Sonos speakers",
        }
    }
}

impl std::fmt::Display for IpValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message())
    }
}

impl std::error::Error for IpValidationError {}

/// Validates that an IP address is suitable for a Sonos speaker.
///
/// Rejects IPv6 (Sonos uses IPv4) and special addresses (loopback, multicast, etc.).
/// Returns the validated IPv4 address for canonical storage.
///
/// # Examples
///
/// ```
/// use std::net::IpAddr;
/// use thaumic_core::validate_speaker_ip;
///
/// // Valid speaker IP
/// let ip: IpAddr = "192.168.1.100".parse().unwrap();
/// assert!(validate_speaker_ip(&ip).is_ok());
///
/// // IPv6 rejected
/// let ip: IpAddr = "::1".parse().unwrap();
/// assert!(validate_speaker_ip(&ip).is_err());
///
/// // Loopback rejected
/// let ip: IpAddr = "127.0.0.1".parse().unwrap();
/// assert!(validate_speaker_ip(&ip).is_err());
/// ```
pub fn validate_speaker_ip(ip: &IpAddr) -> Result<Ipv4Addr, IpValidationError> {
    let ipv4 = match ip {
        IpAddr::V4(v4) => *v4,
        IpAddr::V6(_) => return Err(IpValidationError::Ipv6NotSupported),
    };

    if ipv4.is_loopback() {
        return Err(IpValidationError::Loopback);
    }
    if ipv4.is_unspecified() {
        return Err(IpValidationError::Unspecified);
    }
    if ipv4.is_broadcast() {
        return Err(IpValidationError::Broadcast);
    }
    if ipv4.is_multicast() {
        return Err(IpValidationError::Multicast);
    }
    if ipv4.is_link_local() {
        return Err(IpValidationError::LinkLocal);
    }

    Ok(ipv4)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_speaker_ip_valid_private() {
        let ip: IpAddr = "192.168.1.100".parse().unwrap();
        let result = validate_speaker_ip(&ip);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().to_string(), "192.168.1.100");
    }

    #[test]
    fn test_validate_speaker_ip_valid_public() {
        let ip: IpAddr = "8.8.8.8".parse().unwrap();
        assert!(validate_speaker_ip(&ip).is_ok());
    }

    #[test]
    fn test_validate_speaker_ip_ipv6_rejected() {
        let ip: IpAddr = "::1".parse().unwrap();
        assert_eq!(
            validate_speaker_ip(&ip),
            Err(IpValidationError::Ipv6NotSupported)
        );
    }

    #[test]
    fn test_validate_speaker_ip_ipv6_global_rejected() {
        let ip: IpAddr = "2001:db8::1".parse().unwrap();
        assert_eq!(
            validate_speaker_ip(&ip),
            Err(IpValidationError::Ipv6NotSupported)
        );
    }

    #[test]
    fn test_validate_speaker_ip_loopback() {
        let ip: IpAddr = "127.0.0.1".parse().unwrap();
        assert_eq!(validate_speaker_ip(&ip), Err(IpValidationError::Loopback));
    }

    #[test]
    fn test_validate_speaker_ip_loopback_range() {
        let ip: IpAddr = "127.255.255.255".parse().unwrap();
        assert_eq!(validate_speaker_ip(&ip), Err(IpValidationError::Loopback));
    }

    #[test]
    fn test_validate_speaker_ip_unspecified() {
        let ip: IpAddr = "0.0.0.0".parse().unwrap();
        assert_eq!(
            validate_speaker_ip(&ip),
            Err(IpValidationError::Unspecified)
        );
    }

    #[test]
    fn test_validate_speaker_ip_broadcast() {
        let ip: IpAddr = "255.255.255.255".parse().unwrap();
        assert_eq!(validate_speaker_ip(&ip), Err(IpValidationError::Broadcast));
    }

    #[test]
    fn test_validate_speaker_ip_multicast() {
        let ip: IpAddr = "224.0.0.1".parse().unwrap();
        assert_eq!(validate_speaker_ip(&ip), Err(IpValidationError::Multicast));
    }

    #[test]
    fn test_validate_speaker_ip_multicast_range() {
        let ip: IpAddr = "239.255.255.255".parse().unwrap();
        assert_eq!(validate_speaker_ip(&ip), Err(IpValidationError::Multicast));
    }

    #[test]
    fn test_validate_speaker_ip_link_local() {
        let ip: IpAddr = "169.254.1.1".parse().unwrap();
        assert_eq!(validate_speaker_ip(&ip), Err(IpValidationError::LinkLocal));
    }

    #[test]
    fn test_validate_speaker_ip_link_local_range() {
        let ip: IpAddr = "169.254.254.254".parse().unwrap();
        assert_eq!(validate_speaker_ip(&ip), Err(IpValidationError::LinkLocal));
    }

    #[test]
    fn test_ip_validation_error_code() {
        assert_eq!(IpValidationError::Ipv6NotSupported.code(), "invalid_ip");
        assert_eq!(IpValidationError::Loopback.code(), "invalid_ip");
        assert_eq!(IpValidationError::LinkLocal.code(), "invalid_ip");
    }

    #[test]
    fn test_ip_validation_error_message() {
        assert!(IpValidationError::Ipv6NotSupported
            .message()
            .contains("IPv6"));
        assert!(IpValidationError::Loopback.message().contains("Loopback"));
        assert!(IpValidationError::LinkLocal.message().contains("169.254"));
    }
}
