//! Network configuration context for the streaming server.
//!
//! This module provides [`NetworkContext`] which bundles network configuration
//! used across services. It supports both explicit configuration (for server
//! deployment) and auto-detection (for desktop app).

use std::net::IpAddr;
#[cfg(test)]
use std::net::Ipv4Addr;
use std::sync::Arc;

use parking_lot::RwLock;
use tokio::sync::Notify;

/// Network configuration shared across services.
///
/// Bundles server address and local IP information that multiple services need
/// for constructing callback URLs and stream endpoints.
///
/// # Modes
///
/// - **Explicit**: Server deployment where bind address and advertise IP are
///   specified in configuration. Use [`NetworkContext::explicit`].
/// - **Auto-detect**: Desktop app where the local IP is detected automatically.
///   Use [`NetworkContext::auto_detect`].
#[derive(Clone)]
pub struct NetworkContext {
    /// Server port (initially 0 if auto-assigned, set when server starts).
    pub port: Arc<RwLock<u16>>,
    /// Notifier signaled when port is assigned.
    pub port_notify: Arc<Notify>,
    /// IP address that Sonos speakers can reach us at.
    pub local_ip: Arc<RwLock<String>>,
    /// IP detector for checking network changes (auto-detect mode only).
    ip_detector: Option<Arc<dyn IpDetector>>,
}

impl NetworkContext {
    /// Creates a `NetworkContext` with explicit configuration.
    ///
    /// Use this for server deployment where the bind address and advertise IP
    /// are known ahead of time from configuration.
    ///
    /// # Arguments
    ///
    /// * `bind_port` - Port to bind the server to (0 for auto-assign).
    /// * `advertise_ip` - IP address that Sonos speakers can reach us at.
    #[must_use]
    pub fn explicit(bind_port: u16, advertise_ip: IpAddr) -> Self {
        Self {
            port: Arc::new(RwLock::new(bind_port)),
            port_notify: Arc::new(Notify::new()),
            local_ip: Arc::new(RwLock::new(advertise_ip.to_string())),
            ip_detector: None,
        }
    }

    /// Creates a `NetworkContext` with auto-detection.
    ///
    /// Use this for desktop app where the local IP should be detected
    /// automatically and may change during runtime.
    ///
    /// # Arguments
    ///
    /// * `preferred_port` - Preferred port (0 for auto-assign).
    /// * `ip_detector` - Detector for finding local IP address.
    ///
    /// # Errors
    ///
    /// Returns an error if the initial IP detection fails.
    pub fn auto_detect(
        preferred_port: u16,
        ip_detector: Arc<dyn IpDetector>,
    ) -> Result<Self, NetworkError> {
        let local_ip = ip_detector.detect()?;
        Ok(Self {
            port: Arc::new(RwLock::new(preferred_port)),
            port_notify: Arc::new(Notify::new()),
            local_ip: Arc::new(RwLock::new(local_ip)),
            ip_detector: Some(ip_detector),
        })
    }

    /// Creates a `NetworkContext` for testing with a fixed IP.
    #[cfg(test)]
    pub fn for_test() -> Self {
        Self::explicit(0, IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)))
    }

    /// Detects the current local IP address using the configured detector.
    ///
    /// Only available if created with [`NetworkContext::auto_detect`].
    /// Returns an error if no detector is configured.
    pub fn detect_ip(&self) -> Result<String, NetworkError> {
        match &self.ip_detector {
            Some(detector) => detector.detect(),
            None => Err(NetworkError::NoDetector),
        }
    }

    /// Returns the current port value.
    #[must_use]
    pub fn get_port(&self) -> u16 {
        *self.port.read()
    }

    /// Returns the current local IP.
    #[must_use]
    pub fn get_local_ip(&self) -> String {
        self.local_ip.read().clone()
    }

    /// Sets the port and notifies waiters.
    pub fn set_port(&self, port: u16) {
        *self.port.write() = port;
        self.port_notify.notify_waiters();
    }

    /// Updates the local IP address.
    pub fn set_local_ip(&self, ip: String) {
        *self.local_ip.write() = ip;
    }

    /// Returns a `UrlBuilder` for the current network configuration.
    #[must_use]
    pub fn url_builder(&self) -> UrlBuilder {
        UrlBuilder::new(self.get_local_ip(), self.get_port())
    }

    /// Returns the GENA callback URL for receiving Sonos event notifications.
    #[must_use]
    pub fn gena_callback_url(&self) -> String {
        self.url_builder().gena_callback_url()
    }

    /// Returns the stream URL for a given stream ID.
    #[must_use]
    pub fn stream_url(&self, stream_id: &str) -> String {
        self.url_builder().stream_url(stream_id)
    }
}

/// Trait for detecting the local IP address.
///
/// Different environments may need different detection strategies.
/// This trait allows injecting the appropriate detector.
pub trait IpDetector: Send + Sync {
    /// Detects the local IP address.
    fn detect(&self) -> Result<String, NetworkError>;
}

/// Default IP detector using the system's network interfaces.
#[derive(Debug, Clone, Default)]
pub struct LocalIpDetector;

impl LocalIpDetector {
    /// Creates a new `LocalIpDetector`.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Creates a new `LocalIpDetector` wrapped in an Arc.
    #[must_use]
    pub fn arc() -> Arc<dyn IpDetector> {
        Arc::new(Self::new())
    }
}

impl IpDetector for LocalIpDetector {
    fn detect(&self) -> Result<String, NetworkError> {
        local_ip_address::local_ip()
            .map(|ip| ip.to_string())
            .map_err(|e| NetworkError::Detection(e.to_string()))
    }
}

/// Errors that can occur during network operations.
#[derive(Debug, thiserror::Error)]
pub enum NetworkError {
    /// Could not detect local IP address.
    #[error("Failed to detect local IP: {0}")]
    Detection(String),

    /// No IP detector configured (explicit mode).
    #[error("No IP detector configured (using explicit mode)")]
    NoDetector,

    /// Network interface error.
    #[error("Network interface error: {0}")]
    Interface(String),
}

/// Builder for constructing URLs for the streaming server.
pub struct UrlBuilder {
    ip: String,
    port: u16,
}

impl UrlBuilder {
    /// Creates a new `UrlBuilder` for the given server address.
    pub fn new(ip: impl Into<String>, port: u16) -> Self {
        Self {
            ip: ip.into(),
            port,
        }
    }

    /// Returns the base URL for the server (e.g., `http://192.168.1.100:8080`).
    #[must_use]
    pub fn base_url(&self) -> String {
        format!("http://{}:{}", self.ip, self.port)
    }

    /// Returns the stream URL for a given stream ID.
    #[must_use]
    pub fn stream_url(&self, stream_id: &str) -> String {
        format!("{}/stream/{}", self.base_url(), stream_id)
    }

    /// Returns the GENA callback URL for receiving Sonos notifications.
    #[must_use]
    pub fn gena_callback_url(&self) -> String {
        format!("{}/sonos/gena", self.base_url())
    }

    /// Returns the WebSocket URL for real-time communication.
    #[must_use]
    pub fn websocket_url(&self) -> String {
        format!("ws://{}:{}/ws", self.ip, self.port)
    }

    /// Returns the icon URL for Sonos metadata display.
    #[must_use]
    pub fn icon_url(&self) -> String {
        format!("{}/icon.png", self.base_url())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    struct MockIpDetector {
        ip: String,
    }

    impl IpDetector for MockIpDetector {
        fn detect(&self) -> Result<String, NetworkError> {
            Ok(self.ip.clone())
        }
    }

    #[test]
    fn explicit_context_uses_provided_ip() {
        let ctx = NetworkContext::explicit(8080, IpAddr::V4(Ipv4Addr::new(192, 168, 1, 100)));
        assert_eq!(ctx.get_local_ip(), "192.168.1.100");
        assert_eq!(ctx.get_port(), 8080);
    }

    #[test]
    fn auto_detect_context_uses_detector() {
        let detector = Arc::new(MockIpDetector {
            ip: "10.0.0.5".to_string(),
        });
        let ctx = NetworkContext::auto_detect(0, detector).unwrap();
        assert_eq!(ctx.get_local_ip(), "10.0.0.5");
    }

    #[test]
    fn explicit_context_detect_ip_returns_error() {
        let ctx = NetworkContext::explicit(8080, IpAddr::V4(Ipv4Addr::new(192, 168, 1, 100)));
        assert!(matches!(ctx.detect_ip(), Err(NetworkError::NoDetector)));
    }

    #[test]
    fn url_builder_generates_correct_urls() {
        let builder = UrlBuilder::new("192.168.1.100", 8080);
        assert_eq!(builder.base_url(), "http://192.168.1.100:8080");
        assert_eq!(
            builder.stream_url("abc123"),
            "http://192.168.1.100:8080/stream/abc123"
        );
        assert_eq!(
            builder.gena_callback_url(),
            "http://192.168.1.100:8080/sonos/gena"
        );
        assert_eq!(builder.websocket_url(), "ws://192.168.1.100:8080/ws");
    }
}
