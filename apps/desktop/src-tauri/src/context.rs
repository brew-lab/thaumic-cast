//! Application context types for shared configuration.
//!
//! These structs bundle related configuration that is passed to multiple services,
//! reducing parameter sprawl and making dependencies clearer.

use std::sync::Arc;

use parking_lot::RwLock;
use tokio::sync::Notify;

use crate::utils::{IpDetector, UrlBuilder};

/// Network configuration shared across services.
///
/// Bundles server port and local IP information that multiple services need
/// for constructing callback URLs and stream endpoints.
#[derive(Clone)]
pub struct NetworkContext {
    /// Server port (initially 0, set when server starts).
    pub port: Arc<RwLock<u16>>,
    /// Notifier signaled when port is assigned.
    pub port_notify: Arc<Notify>,
    /// Detected local IP address for streaming.
    pub local_ip: Arc<RwLock<String>>,
    /// IP detector for checking network changes.
    ip_detector: Arc<dyn IpDetector>,
}

impl NetworkContext {
    /// Creates a new NetworkContext with the given initial values.
    ///
    /// # Arguments
    /// * `port` - Initial port (usually 0, set when server starts)
    /// * `local_ip` - Initial local IP address
    /// * `ip_detector` - IP detector for checking network changes
    pub fn new(port: u16, local_ip: String, ip_detector: Arc<dyn IpDetector>) -> Self {
        Self {
            port: Arc::new(RwLock::new(port)),
            port_notify: Arc::new(Notify::new()),
            local_ip: Arc::new(RwLock::new(local_ip)),
            ip_detector,
        }
    }

    /// Detects the current local IP address using the configured detector.
    ///
    /// This is used by services like TopologyMonitor to check for IP changes.
    pub fn detect_ip(&self) -> Result<String, crate::utils::NetworkError> {
        self.ip_detector.detect()
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
}
