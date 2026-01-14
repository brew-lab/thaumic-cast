//! mDNS/Bonjour-based Sonos speaker discovery.
//!
//! Uses DNS-SD to browse for `_sonos._tcp.local.` services.
//! Particularly effective on macOS where mDNS is native, and on networks
//! where SSDP multicast is blocked but mDNS works.
//!
//! # Key Design Points
//!
//! - Uses resolved record data (IP from SRV/A answers) as primary, not string parsing
//! - Extracts UUID from service instance name as best-effort
//! - Calls `stop_browse()` after timeout to avoid accumulating daemon work
//! - Isolated in this module for forward compatibility (mdns-sd may deprecate `ServiceResolved`)

use mdns_sd::{ResolvedService, ScopedIp, ServiceDaemon, ServiceEvent};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::timeout;

use super::types::{DiscoveredSpeaker, DiscoveryError, DiscoveryMethod};

/// Sonos mDNS service type (note: trailing dot is required by mdns-sd).
const SONOS_SERVICE_TYPE: &str = "_sonos._tcp.local.";

/// Configuration for mDNS discovery.
#[derive(Debug, Clone)]
pub struct MdnsConfig {
    /// How long to browse for services.
    pub browse_timeout: Duration,
}

impl Default for MdnsConfig {
    fn default() -> Self {
        Self {
            browse_timeout: Duration::from_millis(2000),
        }
    }
}

/// Discovers Sonos speakers using mDNS/Bonjour.
///
/// Browses for `_sonos._tcp.local.` services and extracts IP addresses
/// and UUIDs from the resolved service records.
///
/// # Arguments
///
/// * `daemon` - Shared mDNS service daemon (reused across discovery calls)
/// * `config` - mDNS discovery configuration
///
/// # Returns
///
/// A list of discovered speakers with their IPs and UUIDs.
pub async fn discover_mdns(
    daemon: &Arc<ServiceDaemon>,
    config: &MdnsConfig,
) -> Result<Vec<DiscoveredSpeaker>, DiscoveryError> {
    log::debug!(
        "[mDNS] Starting discovery, browse timeout: {}ms",
        config.browse_timeout.as_millis()
    );

    // Start browsing for Sonos services
    let receiver = daemon
        .browse(SONOS_SERVICE_TYPE)
        .map_err(|e| DiscoveryError::MdnsDaemon(e.to_string()))?;

    let mut discovered: HashMap<String, DiscoveredSpeaker> = HashMap::new();

    // Collect resolved services within timeout
    let start = std::time::Instant::now();
    while start.elapsed() < config.browse_timeout {
        let remaining = config.browse_timeout.saturating_sub(start.elapsed());

        match timeout(remaining, async { receiver.recv_async().await }).await {
            Ok(Ok(event)) => {
                if let ServiceEvent::ServiceResolved(info) = event {
                    log::trace!("[mDNS] Service resolved: {:?}", info.fullname);

                    // Extract speaker info from resolved service
                    if let Some(speaker) = parse_mdns_service(&info) {
                        let key = speaker.uuid.clone();
                        log::debug!(
                            "[mDNS] Discovered speaker: ip={}, uuid={}",
                            speaker.ip,
                            speaker.uuid
                        );
                        discovered.insert(key, speaker);
                    }
                }
            }
            Ok(Err(e)) => {
                log::debug!("[mDNS] Receiver channel closed: {:?}", e);
                break;
            }
            Err(_) => {
                // Timeout - normal termination
                break;
            }
        }
    }

    // Stop browsing to avoid accumulating daemon work
    if let Err(e) = daemon.stop_browse(SONOS_SERVICE_TYPE) {
        log::warn!("[mDNS] Failed to stop browse: {:?}", e);
    }

    let speakers: Vec<_> = discovered.into_values().collect();
    log::debug!(
        "[mDNS] Discovery complete: {} speaker(s) found",
        speakers.len()
    );

    Ok(speakers)
}

/// Parses a resolved mDNS service into a DiscoveredSpeaker.
///
/// Uses resolved record data (IP from SRV/A answers) as primary source.
/// Extracts UUID from service instance name as best-effort.
fn parse_mdns_service(info: &ResolvedService) -> Option<DiscoveredSpeaker> {
    // Extract IPv4 address from resolved records (prefer IPv4 for Sonos compatibility)
    let ip = info.addresses.iter().find_map(|addr| match addr {
        ScopedIp::V4(v4) => Some(v4.addr().to_string()),
        ScopedIp::V6(_) | _ => None,
    })?;

    // Extract UUID from service instance name
    // Format is typically "RINCON_xxxxx._sonos._tcp.local." or similar
    let uuid =
        extract_uuid_from_name(&info.fullname).or_else(|| extract_uuid_from_name(&info.host))?;

    // Collect all candidate IPs (v4 and v6)
    let candidate_ips: Vec<String> = info
        .addresses
        .iter()
        .map(|addr| addr.to_ip_addr().to_string())
        .collect();

    let mut speaker = DiscoveredSpeaker::new(ip, uuid, DiscoveryMethod::Mdns);
    speaker.candidate_ips = candidate_ips;

    // Build UPnP location URL for device description fetch
    // Use port from mDNS if available, otherwise default to 1400
    let port = info.port;
    let description_port = if port > 0 && port != 1400 { port } else { 1400 };
    speaker.location = Some(format!(
        "http://{}:{}/xml/device_description.xml",
        speaker.ip, description_port
    ));

    Some(speaker)
}

/// Extracts RINCON UUID from mDNS service name or hostname.
///
/// Handles various formats:
/// - `RINCON_xxx._sonos._tcp.local.`
/// - `RINCON_xxx.local.`
/// - `Sonos-RINCON_xxx._sonos._tcp.local.`
fn extract_uuid_from_name(name: &str) -> Option<String> {
    // Look for RINCON_ pattern anywhere in the name
    if let Some(start) = name.find("RINCON_") {
        // Extract from RINCON_ to the next non-identifier character
        let rest = &name[start..];
        let end = rest
            .find(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .unwrap_or(rest.len());
        let uuid = &rest[..end];

        if !uuid.is_empty() && uuid.len() > 7 {
            // "RINCON_" is 7 chars
            return Some(uuid.to_string());
        }
    }
    None
}

/// Creates a new mDNS service daemon.
///
/// This should be called once and the daemon reused across discovery calls.
/// The daemon spawns a background thread for mDNS operations.
pub fn create_daemon() -> Result<ServiceDaemon, DiscoveryError> {
    ServiceDaemon::new().map_err(|e| DiscoveryError::MdnsDaemon(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_uuid_standard_format() {
        assert_eq!(
            extract_uuid_from_name("RINCON_ABC123456789._sonos._tcp.local."),
            Some("RINCON_ABC123456789".to_string())
        );
    }

    #[test]
    fn test_extract_uuid_hostname_format() {
        assert_eq!(
            extract_uuid_from_name("RINCON_ABC123456789.local."),
            Some("RINCON_ABC123456789".to_string())
        );
    }

    #[test]
    fn test_extract_uuid_with_prefix() {
        assert_eq!(
            extract_uuid_from_name("Sonos-RINCON_ABC123456789._sonos._tcp.local."),
            Some("RINCON_ABC123456789".to_string())
        );
    }

    #[test]
    fn test_extract_uuid_not_found() {
        assert_eq!(
            extract_uuid_from_name("some-other-device._tcp.local."),
            None
        );
    }

    #[test]
    fn test_extract_uuid_too_short() {
        // Just "RINCON_" with nothing after is invalid
        assert_eq!(extract_uuid_from_name("RINCON_.local."), None);
    }
}
