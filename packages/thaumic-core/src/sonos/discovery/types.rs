//! Shared types for Sonos speaker discovery.
//!
//! This module contains types used across all discovery methods (SSDP, mDNS)
//! and the coordinator that merges their results.

use serde::Serialize;
use std::collections::HashSet;
use thiserror::Error;

/// Discovery method identifier for tracking which methods found each speaker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DiscoveryMethod {
    /// SSDP multicast to 239.255.255.250:1900
    SsdpMulticast,
    /// SSDP broadcast (directed per-interface + limited 255.255.255.255)
    SsdpBroadcast,
    /// mDNS/Bonjour via _sonos._tcp.local.
    Mdns,
}

impl std::fmt::Display for DiscoveryMethod {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SsdpMulticast => write!(f, "SSDP multicast"),
            Self::SsdpBroadcast => write!(f, "SSDP broadcast"),
            Self::Mdns => write!(f, "mDNS"),
        }
    }
}

/// Distinguishes why a discovery method failed.
#[derive(Debug, Clone)]
pub enum DiscoveryErrorKind {
    /// Method timed out without finding devices.
    Timeout {
        /// The configured timeout in milliseconds.
        configured_ms: u64,
    },
    /// Failed to bind UDP socket.
    SocketBind(String),
    /// Failed to join multicast group.
    #[allow(dead_code)]
    SocketJoin(String),
    /// Permission denied (e.g., firewall).
    Permission(String),
    /// mDNS daemon error.
    DaemonError(String),
}

impl std::fmt::Display for DiscoveryErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Timeout { configured_ms } => {
                write!(f, "timed out after {}ms", configured_ms)
            }
            Self::SocketBind(msg) => write!(f, "socket bind failed: {}", msg),
            Self::SocketJoin(msg) => write!(f, "multicast join failed: {}", msg),
            Self::Permission(msg) => write!(f, "permission denied: {}", msg),
            Self::DaemonError(msg) => write!(f, "mDNS daemon error: {}", msg),
        }
    }
}

/// Errors that can occur during discovery.
#[derive(Debug, Error)]
pub enum DiscoveryError {
    /// Failed to bind UDP socket for discovery.
    #[error("failed to bind UDP socket: {0}")]
    SocketBind(#[source] std::io::Error),

    /// Failed to send SSDP multicast search.
    #[allow(dead_code)]
    #[error("failed to send SSDP search: {0}")]
    SendSearch(#[source] std::io::Error),

    /// No usable network interfaces found.
    #[error("no usable network interfaces found")]
    NoInterfaces,

    /// mDNS daemon error.
    #[error("mDNS daemon error: {0}")]
    MdnsDaemon(String),

    /// All discovery methods failed.
    #[error("all discovery methods failed")]
    AllMethodsFailed(Vec<(DiscoveryMethod, DiscoveryErrorKind)>),

    /// IP address is unreachable or not responding.
    #[error("IP unreachable: {0}")]
    IpUnreachable(String),

    /// IP responds but is not a valid Sonos device.
    #[error("not a Sonos device: {0}")]
    NotSonosDevice(String),
}

/// Convenient Result alias for speaker discovery operations.
pub type DiscoveryResult<T> = Result<T, DiscoveryError>;

/// A discovered Sonos speaker with resolved metadata.
#[derive(Debug, Serialize, Clone)]
pub struct Speaker {
    /// IP address of the speaker.
    pub ip: String,
    /// Friendly name from device description.
    pub name: String,
    /// Canonical UUID (normalized RINCON_xxx).
    pub uuid: String,
    /// Model name (e.g., "Sonos Arc", "Sonos Boost").
    #[serde(rename = "modelName", skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
}

/// Known Sonos infrastructure device models that don't participate in zone groups.
/// These are network bridges/extenders, not playable speakers.
const INFRASTRUCTURE_MODELS: &[&str] = &["boost", "bridge"];

impl Speaker {
    /// Returns true if this is a non-playable infrastructure device (Boost, Bridge).
    pub fn is_infrastructure_device(&self) -> bool {
        self.model_name
            .as_ref()
            .map(|m| {
                let model_lower = m.to_lowercase();
                INFRASTRUCTURE_MODELS
                    .iter()
                    .any(|&infra| model_lower.contains(infra))
            })
            .unwrap_or(false)
    }
}

/// Intermediate struct for speaker data before metadata resolution.
///
/// This is used during the discovery phase before we fetch device descriptions.
#[derive(Debug, Clone)]
pub struct DiscoveredSpeaker {
    /// IP address of the speaker.
    pub ip: String,
    /// Raw UUID as discovered (may need normalization).
    pub uuid: String,
    /// SSDP LOCATION URL if available (authoritative for device description).
    pub location: Option<String>,
    /// All candidate IPs discovered (v4 and v6).
    pub candidate_ips: Vec<String>,
    /// Which discovery methods found this speaker.
    pub methods: HashSet<DiscoveryMethod>,
}

impl DiscoveredSpeaker {
    /// Creates a new discovered speaker from a single discovery.
    pub fn new(ip: String, uuid: String, method: DiscoveryMethod) -> Self {
        let mut methods = HashSet::new();
        methods.insert(method);
        Self {
            candidate_ips: vec![ip.clone()],
            ip,
            uuid,
            location: None,
            methods,
        }
    }

    /// Creates a new discovered speaker with a LOCATION URL.
    pub fn with_location(
        ip: String,
        uuid: String,
        location: String,
        method: DiscoveryMethod,
    ) -> Self {
        let mut speaker = Self::new(ip, uuid, method);
        speaker.location = Some(location);
        speaker
    }

    /// Merges another discovered speaker into this one.
    ///
    /// - Unions the methods set
    /// - Prefers SSDP LOCATION if present
    /// - Keeps all candidate IPs
    pub fn merge(&mut self, other: DiscoveredSpeaker) {
        // Union methods
        self.methods.extend(other.methods);

        // Prefer SSDP LOCATION (more authoritative)
        if self.location.is_none() && other.location.is_some() {
            self.location = other.location;
        }

        // Add candidate IPs (avoid duplicates)
        for ip in other.candidate_ips {
            if !self.candidate_ips.contains(&ip) {
                self.candidate_ips.push(ip);
            }
        }
    }

    /// Returns the best IP to use for device description fetch.
    ///
    /// Prefers IPv4 over IPv6 for Sonos compatibility.
    pub fn preferred_ip(&self) -> &str {
        // Prefer IPv4 (no colons)
        self.candidate_ips
            .iter()
            .find(|ip| !ip.contains(':'))
            .unwrap_or(&self.ip)
    }
}

/// Normalizes a Sonos UUID to canonical form for deduplication.
///
/// Handles various real-world UUID shapes:
/// - `uuid:` prefix (from UPnP UDN)
/// - `::urn:schemas-upnp-org:device:ZonePlayer:1` suffix (from USN)
/// - `:<digits>` suffixes (group/topology IDs like `RINCON_...01400:58`)
/// - `_MS`, `_MR`, `_LR` suffixes (root device + subdevices)
///
/// # Examples
///
/// ```ignore
/// use crate::sonos::discovery::types::normalize_uuid;
///
/// assert_eq!(
///     normalize_uuid("uuid:RINCON_ABC123::urn:schemas-upnp-org:device:ZonePlayer:1"),
///     "RINCON_ABC123"
/// );
/// assert_eq!(normalize_uuid("RINCON_ABC123_MS"), "RINCON_ABC123");
/// assert_eq!(normalize_uuid("RINCON_ABC12301400:58"), "RINCON_ABC12301400");
/// ```
pub fn normalize_uuid(raw: &str) -> String {
    let mut uuid = raw.to_string();

    // Strip "uuid:" prefix (from UPnP UDN)
    if let Some(stripped) = uuid.strip_prefix("uuid:") {
        uuid = stripped.to_string();
    }

    // Strip "::urn:schemas-upnp-org:..." suffix (from USN)
    if let Some(idx) = uuid.find("::") {
        uuid.truncate(idx);
    }

    // Strip ":<digits>" suffix (group/topology IDs) - only for RINCON_ UUIDs
    // Guard with RINCON_ check to avoid accidentally truncating IPv6-like strings
    if uuid.contains("RINCON_") {
        if let Some(idx) = uuid.rfind(':') {
            let suffix = &uuid[idx + 1..];
            if !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()) {
                uuid.truncate(idx);
            }
        }
    }

    // Strip device suffixes in loop (_MS, _MR, _LR can appear in combination)
    const SUFFIXES: &[&str] = &["_MS", "_MR", "_LR"];
    loop {
        let before = uuid.len();
        for suffix in SUFFIXES {
            if let Some(stripped) = uuid.strip_suffix(suffix) {
                uuid = stripped.to_string();
            }
        }
        if uuid.len() == before {
            break;
        }
    }

    uuid
}

/// Device information fetched from device description XML.
#[derive(Debug, Clone)]
pub struct DeviceInfo {
    /// Canonical UUID from UDN field.
    pub uuid: String,
    /// Friendly name for display.
    pub friendly_name: String,
    /// Model name (e.g., "Sonos Arc").
    #[allow(dead_code)]
    pub model_name: Option<String>,
    /// Model number.
    #[allow(dead_code)]
    pub model_number: Option<String>,
}

/// Virtual interface prefixes to filter out during discovery.
pub const VIRTUAL_INTERFACE_PREFIXES: &[&str] = &[
    "lo", "docker", "veth", "br-", "virbr", "vmnet", "vbox", "tun", "tap",
];

/// Checks if an interface name belongs to a virtual/container interface.
pub fn is_virtual_interface(name: &str) -> bool {
    let name_lower = name.to_lowercase();
    VIRTUAL_INTERFACE_PREFIXES
        .iter()
        .any(|prefix| name_lower.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_uuid_strips_uuid_prefix() {
        assert_eq!(normalize_uuid("uuid:RINCON_ABC123"), "RINCON_ABC123");
    }

    #[test]
    fn test_normalize_uuid_strips_urn_suffix() {
        assert_eq!(
            normalize_uuid("RINCON_ABC123::urn:schemas-upnp-org:device:ZonePlayer:1"),
            "RINCON_ABC123"
        );
    }

    #[test]
    fn test_normalize_uuid_strips_both_prefix_and_suffix() {
        assert_eq!(
            normalize_uuid("uuid:RINCON_ABC123::urn:schemas-upnp-org:device:ZonePlayer:1"),
            "RINCON_ABC123"
        );
    }

    #[test]
    fn test_normalize_uuid_strips_topology_suffix() {
        assert_eq!(
            normalize_uuid("RINCON_ABC12301400:58"),
            "RINCON_ABC12301400"
        );
    }

    #[test]
    fn test_normalize_uuid_strips_device_suffixes() {
        assert_eq!(normalize_uuid("RINCON_ABC123_MS"), "RINCON_ABC123");
        assert_eq!(normalize_uuid("RINCON_ABC123_MR"), "RINCON_ABC123");
        assert_eq!(normalize_uuid("RINCON_ABC123_LR"), "RINCON_ABC123");
    }

    #[test]
    fn test_normalize_uuid_strips_multiple_suffixes() {
        // In case they somehow appear in combination
        assert_eq!(normalize_uuid("RINCON_ABC123_MS_LR"), "RINCON_ABC123");
    }

    #[test]
    fn test_normalize_uuid_preserves_non_rincon() {
        // Should not strip :<digits> from non-RINCON strings
        assert_eq!(normalize_uuid("some:123"), "some:123");
    }

    #[test]
    fn test_is_virtual_interface() {
        assert!(is_virtual_interface("lo"));
        assert!(is_virtual_interface("docker0"));
        assert!(is_virtual_interface("veth1234"));
        assert!(is_virtual_interface("br-abc"));
        assert!(!is_virtual_interface("eth0"));
        assert!(!is_virtual_interface("en0"));
        assert!(!is_virtual_interface("wlan0"));
    }

    #[test]
    fn test_discovered_speaker_merge() {
        let mut speaker1 = DiscoveredSpeaker::new(
            "192.168.1.10".to_string(),
            "RINCON_ABC123".to_string(),
            DiscoveryMethod::Mdns,
        );

        let speaker2 = DiscoveredSpeaker::with_location(
            "192.168.1.10".to_string(),
            "RINCON_ABC123".to_string(),
            "http://192.168.1.10:1400/xml/device_description.xml".to_string(),
            DiscoveryMethod::SsdpMulticast,
        );

        speaker1.merge(speaker2);

        assert!(speaker1.methods.contains(&DiscoveryMethod::Mdns));
        assert!(speaker1.methods.contains(&DiscoveryMethod::SsdpMulticast));
        assert!(speaker1.location.is_some());
    }
}
