//! mDNS service advertisement for network discovery.
//!
//! This is best-effort - failure is logged but doesn't prevent the service from running.
//! Browser extensions cannot use DNS-SD, so this primarily benefits native clients.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};

use mdns_sd::{ServiceDaemon, ServiceInfo};

/// Service type for Thaumic Cast discovery.
const SERVICE_TYPE: &str = "_thaumic._tcp.local.";

/// Advertises the Thaumic Cast service via mDNS/DNS-SD.
///
/// When created, registers the service with the local mDNS responder.
/// The service is automatically unregistered when dropped.
pub struct MdnsAdvertiser {
    daemon: ServiceDaemon,
    service_fullname: String,
    /// Tracks whether shutdown has been called to prevent double unregister.
    shutdown_called: AtomicBool,
}

impl MdnsAdvertiser {
    /// Creates and registers an mDNS service advertisement.
    ///
    /// # Arguments
    /// * `advertise_ip` - The IP address to advertise (should be LAN-reachable)
    /// * `port` - The HTTP server port
    ///
    /// # Errors
    /// Returns an error if the mDNS daemon cannot be created or the service
    /// cannot be registered (e.g., mDNS not available on the system).
    pub fn new(advertise_ip: IpAddr, port: u16) -> Result<Self, mdns_sd::Error> {
        let daemon = ServiceDaemon::new()?;

        // Use machine hostname for unique instance name
        let hostname = hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown".to_string());
        let instance_name = format!("Thaumic Cast {}", hostname);

        // Sanitize hostname for DNS (lowercase, no spaces)
        let dns_hostname = hostname
            .to_lowercase()
            .replace(' ', "-")
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect::<String>();

        // TXT records for service metadata
        let mut txt = HashMap::new();
        txt.insert("http_path".to_string(), "/health".to_string());
        txt.insert("ws_path".to_string(), "/ws".to_string());
        txt.insert("version".to_string(), env!("CARGO_PKG_VERSION").to_string());

        let service = ServiceInfo::new(
            SERVICE_TYPE,
            &instance_name,
            &format!("{}.local.", dns_hostname),
            advertise_ip,
            port,
            Some(txt),
        )?;

        let fullname = service.get_fullname().to_string();
        daemon.register(service)?;

        log::info!(
            "[mDNS] Advertising '{}' at {}:{}",
            instance_name,
            advertise_ip,
            port
        );

        Ok(Self {
            daemon,
            service_fullname: fullname,
            shutdown_called: AtomicBool::new(false),
        })
    }

    /// Unregisters the service from mDNS.
    ///
    /// Called automatically on drop, but can be called manually for explicit cleanup.
    /// Safe to call multiple times - subsequent calls are no-ops.
    pub fn shutdown(&self) {
        // Only unregister once
        if self.shutdown_called.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Err(e) = self.daemon.unregister(&self.service_fullname) {
            log::warn!("[mDNS] Failed to unregister service: {}", e);
        }
    }
}

impl Drop for MdnsAdvertiser {
    fn drop(&mut self) {
        self.shutdown();
    }
}
