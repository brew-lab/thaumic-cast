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
