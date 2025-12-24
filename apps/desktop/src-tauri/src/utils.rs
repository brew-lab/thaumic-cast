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
}
