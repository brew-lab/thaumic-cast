//! Multi-method Sonos speaker discovery.
//!
//! Combines SSDP (multicast + broadcast) and mDNS discovery methods
//! for improved reliability across different network configurations.
//!
//! # Architecture
//!
//! ```text
//! DiscoveryCoordinator
//! ├── SSDP Multicast (239.255.255.250:1900)
//! ├── SSDP Broadcast (directed per-interface + 255.255.255.255)
//! └── mDNS (_sonos._tcp.local.)
//! ```
//!
//! # Discovery Pipeline
//!
//! 1. Run all enabled methods in parallel
//! 2. Collect raw discoveries (with method tracking)
//! 3. Normalize UUIDs and merge duplicates
//! 4. Fetch device descriptions (unified, with caching)

pub mod mdns;
pub mod ssdp;
pub mod types;

pub use types::{
    normalize_uuid, DeviceInfo, DiscoveredSpeaker, DiscoveryError, DiscoveryErrorKind,
    DiscoveryMethod, Speaker,
};

use mdns_sd::ServiceDaemon;
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use reqwest::Client;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use self::mdns::MdnsConfig;
use self::ssdp::SsdpConfig;

/// Configuration for the discovery coordinator.
#[derive(Debug, Clone)]
pub struct DiscoveryConfig {
    /// Enable SSDP multicast discovery.
    pub ssdp_multicast_enabled: bool,
    /// Enable SSDP broadcast discovery.
    pub ssdp_broadcast_enabled: bool,
    /// Enable mDNS discovery.
    pub mdns_enabled: bool,
    /// SSDP configuration.
    pub ssdp: SsdpConfig,
    /// mDNS configuration.
    pub mdns: MdnsConfig,
    /// Timeout for fetching device descriptions.
    pub description_fetch_timeout: Duration,
    /// Maximum concurrent device description fetches.
    pub max_concurrent_fetches: usize,
}

impl Default for DiscoveryConfig {
    fn default() -> Self {
        Self {
            ssdp_multicast_enabled: true,
            ssdp_broadcast_enabled: true,
            mdns_enabled: true,
            ssdp: SsdpConfig::default(),
            mdns: MdnsConfig::default(),
            description_fetch_timeout: Duration::from_secs(2),
            max_concurrent_fetches: 8,
        }
    }
}

/// Coordinates multiple discovery methods for reliable speaker detection.
///
/// Runs SSDP (multicast + broadcast) and mDNS in parallel, merges results,
/// and fetches device descriptions with caching.
pub struct DiscoveryCoordinator {
    config: DiscoveryConfig,
    http_client: Client,
    /// Lazily initialized mDNS daemon (reused across discovery calls)
    mdns_daemon: OnceLock<Arc<ServiceDaemon>>,
}

impl DiscoveryCoordinator {
    /// Creates a new coordinator with the given configuration.
    pub fn new(config: DiscoveryConfig) -> Self {
        let http_client = Client::builder()
            .timeout(config.description_fetch_timeout)
            .build()
            .unwrap_or_else(|e| {
                log::warn!(
                    "[Discovery] Failed to build HTTP client with custom timeout: {}. Using default.",
                    e
                );
                Client::default()
            });

        Self {
            config,
            http_client,
            mdns_daemon: OnceLock::new(),
        }
    }

    /// Creates a new coordinator with default configuration.
    #[allow(dead_code)]
    pub fn with_defaults() -> Self {
        Self::new(DiscoveryConfig::default())
    }

    /// Gets or creates the mDNS daemon.
    fn get_mdns_daemon(&self) -> Result<&Arc<ServiceDaemon>, DiscoveryError> {
        // OnceLock doesn't have get_or_try_init in stable, so we handle errors differently
        if let Some(daemon) = self.mdns_daemon.get() {
            return Ok(daemon);
        }

        // Try to create the daemon
        let daemon = mdns::create_daemon()?;

        // Try to set it (may fail if another thread set it first, which is fine)
        let _ = self.mdns_daemon.set(Arc::new(daemon));

        // Return whatever is in the cell now
        self.mdns_daemon.get().ok_or_else(|| {
            DiscoveryError::MdnsDaemon("failed to initialize mDNS daemon".to_string())
        })
    }

    /// Discovers speakers using all enabled methods in parallel.
    ///
    /// # Returns
    ///
    /// A list of discovered speakers with resolved metadata.
    pub async fn discover_speakers(&self) -> Result<Vec<Speaker>, DiscoveryError> {
        let mut method_errors: Vec<(DiscoveryMethod, DiscoveryErrorKind)> = Vec::new();

        log::info!(
            "[Discovery] Starting parallel discovery (multicast={}, broadcast={}, mdns={})",
            self.config.ssdp_multicast_enabled,
            self.config.ssdp_broadcast_enabled,
            self.config.mdns_enabled
        );

        // Launch enabled discovery methods in parallel
        let (multicast_result, broadcast_result, mdns_result) = tokio::join!(
            async {
                if self.config.ssdp_multicast_enabled {
                    log::debug!("[Discovery] SSDP multicast starting...");
                    let result = ssdp::discover_multicast(&self.config.ssdp).await;
                    log::debug!("[Discovery] SSDP multicast finished");
                    Some(result)
                } else {
                    None
                }
            },
            async {
                if self.config.ssdp_broadcast_enabled {
                    log::debug!("[Discovery] SSDP broadcast starting...");
                    let result = ssdp::discover_broadcast(&self.config.ssdp).await;
                    log::debug!("[Discovery] SSDP broadcast finished");
                    Some(result)
                } else {
                    None
                }
            },
            async {
                if self.config.mdns_enabled {
                    log::debug!("[Discovery] mDNS starting...");
                    match self.get_mdns_daemon() {
                        Ok(daemon) => {
                            let result = mdns::discover_mdns(daemon, &self.config.mdns).await;
                            log::debug!("[Discovery] mDNS finished");
                            Some(result)
                        }
                        Err(e) => Some(Err(e)),
                    }
                } else {
                    None
                }
            }
        );

        log::info!("[Discovery] All methods completed, processing results");

        // Collect results and track errors
        let mut all_discovered: Vec<DiscoveredSpeaker> = Vec::new();

        if let Some(result) = multicast_result {
            match result {
                Ok(speakers) => {
                    log::info!(
                        "[Discovery] SSDP multicast found {} speaker(s)",
                        speakers.len()
                    );
                    all_discovered.extend(speakers);
                }
                Err(e) => {
                    log::warn!("[Discovery] SSDP multicast failed: {}", e);
                    method_errors.push((
                        DiscoveryMethod::SsdpMulticast,
                        error_to_kind(&e, self.config.ssdp.discovery_timeout.as_millis() as u64),
                    ));
                }
            }
        }

        if let Some(result) = broadcast_result {
            match result {
                Ok(speakers) => {
                    log::info!(
                        "[Discovery] SSDP broadcast found {} speaker(s)",
                        speakers.len()
                    );
                    all_discovered.extend(speakers);
                }
                Err(e) => {
                    log::warn!("[Discovery] SSDP broadcast failed: {}", e);
                    method_errors.push((
                        DiscoveryMethod::SsdpBroadcast,
                        error_to_kind(&e, self.config.ssdp.discovery_timeout.as_millis() as u64),
                    ));
                }
            }
        }

        if let Some(result) = mdns_result {
            match result {
                Ok(speakers) => {
                    log::info!("[Discovery] mDNS found {} speaker(s)", speakers.len());
                    all_discovered.extend(speakers);
                }
                Err(e) => {
                    log::warn!("[Discovery] mDNS failed: {}", e);
                    method_errors.push((
                        DiscoveryMethod::Mdns,
                        error_to_kind(&e, self.config.mdns.browse_timeout.as_millis() as u64),
                    ));
                }
            }
        }

        // If all methods failed, return error
        if all_discovered.is_empty() && !method_errors.is_empty() {
            return Err(DiscoveryError::AllMethodsFailed(method_errors));
        }

        // Normalize UUIDs and merge duplicates
        let merged = self.merge_discovered(all_discovered);

        log::info!("[Discovery] {} unique speaker(s) after merge", merged.len());

        // Fetch device descriptions
        log::info!(
            "[Discovery] Fetching device descriptions for {} speaker(s)...",
            merged.len()
        );
        let speakers = self.fetch_device_descriptions(merged).await;
        log::info!(
            "[Discovery] Device description fetch complete, returning {} speaker(s)",
            speakers.len()
        );

        Ok(speakers)
    }

    /// Merges discovered speakers by normalized UUID.
    ///
    /// - Unions methods from multiple discoveries
    /// - Prefers SSDP LOCATION when present
    /// - Keeps all candidate IPs
    fn merge_discovered(&self, discovered: Vec<DiscoveredSpeaker>) -> Vec<DiscoveredSpeaker> {
        let mut by_uuid: HashMap<String, DiscoveredSpeaker> = HashMap::new();

        for speaker in discovered {
            let canonical_uuid = normalize_uuid(&speaker.uuid);

            if let Some(existing) = by_uuid.get_mut(&canonical_uuid) {
                existing.merge(speaker);
            } else {
                let mut normalized = speaker;
                normalized.uuid = canonical_uuid.clone();
                by_uuid.insert(canonical_uuid, normalized);
            }
        }

        let mut speakers: Vec<_> = by_uuid.into_values().collect();
        speakers.sort_by(|a, b| a.uuid.cmp(&b.uuid));
        speakers
    }

    /// Fetches device descriptions for all discovered speakers.
    ///
    /// Uses caching per (ip, port) to avoid duplicate requests.
    async fn fetch_device_descriptions(&self, discovered: Vec<DiscoveredSpeaker>) -> Vec<Speaker> {
        use futures::stream::{self, StreamExt};

        // Cache for device descriptions by URL
        let cache: Arc<tokio::sync::Mutex<HashMap<String, Option<DeviceInfo>>>> =
            Arc::new(tokio::sync::Mutex::new(HashMap::new()));

        let speakers: Vec<Speaker> = stream::iter(discovered)
            .map(|speaker| {
                let client = &self.http_client;
                let cache = Arc::clone(&cache);
                async move {
                    let info = self
                        .fetch_device_info_cached(client, &speaker, &cache)
                        .await;

                    Speaker {
                        ip: speaker.preferred_ip().to_string(),
                        uuid: info
                            .as_ref()
                            .map(|i| normalize_uuid(&i.uuid))
                            .unwrap_or_else(|| speaker.uuid.clone()),
                        name: info
                            .as_ref()
                            .map(|i| i.friendly_name.clone())
                            .unwrap_or_else(|| format!("Sonos ({})", speaker.ip)),
                        model_name: info.and_then(|i| i.model_name),
                    }
                }
            })
            .buffer_unordered(self.config.max_concurrent_fetches)
            .collect()
            .await;

        speakers
    }

    /// Fetches device info with caching.
    async fn fetch_device_info_cached(
        &self,
        client: &Client,
        speaker: &DiscoveredSpeaker,
        cache: &Arc<tokio::sync::Mutex<HashMap<String, Option<DeviceInfo>>>>,
    ) -> Option<DeviceInfo> {
        // Try SSDP LOCATION first (authoritative)
        if let Some(ref location) = speaker.location {
            {
                let cache_guard = cache.lock().await;
                if let Some(cached) = cache_guard.get(location) {
                    return cached.clone();
                }
            }

            let info = fetch_device_description(client, location).await;
            {
                let mut cache_guard = cache.lock().await;
                cache_guard.insert(location.clone(), info.clone());
            }
            if info.is_some() {
                return info;
            }
        }

        // Fallback: try port 1400
        let url_1400 = format!(
            "http://{}:1400/xml/device_description.xml",
            speaker.preferred_ip()
        );
        {
            let cache_guard = cache.lock().await;
            if let Some(cached) = cache_guard.get(&url_1400) {
                return cached.clone();
            }
        }

        let info = fetch_device_description(client, &url_1400).await;
        {
            let mut cache_guard = cache.lock().await;
            cache_guard.insert(url_1400.clone(), info.clone());
        }
        if info.is_some() {
            return info;
        }

        // Fallback: try port 1410
        let url_1410 = format!(
            "http://{}:1410/xml/device_description.xml",
            speaker.preferred_ip()
        );
        {
            let cache_guard = cache.lock().await;
            if let Some(cached) = cache_guard.get(&url_1410) {
                return cached.clone();
            }
        }

        let info = fetch_device_description(client, &url_1410).await;
        {
            let mut cache_guard = cache.lock().await;
            cache_guard.insert(url_1410, info.clone());
        }
        info
    }
}

/// Fetches and parses device description XML.
///
/// Extracts UDN (canonical UUID), friendlyName, modelName, and modelNumber.
async fn fetch_device_description(client: &Client, url: &str) -> Option<DeviceInfo> {
    let response = client.get(url).send().await.ok()?;
    let body = response.text().await.ok()?;

    parse_device_description(&body)
}

/// Parses device description XML.
fn parse_device_description(xml: &str) -> Option<DeviceInfo> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();

    let mut uuid = None;
    let mut friendly_name = None;
    let mut model_name = None;
    let mut model_number = None;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let local_name = e.local_name();
                let name = local_name.as_ref();

                match name {
                    b"UDN" => {
                        uuid = reader.read_text(e.name()).ok().map(|t| t.to_string());
                    }
                    b"friendlyName" => {
                        friendly_name = reader.read_text(e.name()).ok().map(|t| t.to_string());
                    }
                    b"modelName" => {
                        model_name = reader.read_text(e.name()).ok().map(|t| t.to_string());
                    }
                    b"modelNumber" => {
                        model_number = reader.read_text(e.name()).ok().map(|t| t.to_string());
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                log::trace!("Error parsing device description: {:?}", e);
                break;
            }
            _ => {}
        }
        buf.clear();
    }

    // UDN and friendlyName are required
    match (uuid, friendly_name) {
        (Some(uuid), Some(friendly_name)) => Some(DeviceInfo {
            uuid,
            friendly_name,
            model_name,
            model_number,
        }),
        _ => None,
    }
}

/// Converts a DiscoveryError to a DiscoveryErrorKind.
fn error_to_kind(error: &DiscoveryError, timeout_ms: u64) -> DiscoveryErrorKind {
    match error {
        DiscoveryError::SocketBind(e) => {
            let msg = e.to_string();
            if msg.contains("ermission") {
                DiscoveryErrorKind::Permission(msg)
            } else {
                DiscoveryErrorKind::SocketBind(msg)
            }
        }
        DiscoveryError::SendSearch(e) => DiscoveryErrorKind::SocketBind(e.to_string()),
        DiscoveryError::NoInterfaces => {
            DiscoveryErrorKind::SocketBind("no usable network interfaces".to_string())
        }
        DiscoveryError::MdnsDaemon(msg) => DiscoveryErrorKind::DaemonError(msg.clone()),
        DiscoveryError::AllMethodsFailed(_) => DiscoveryErrorKind::Timeout {
            configured_ms: timeout_ms,
        },
        // These are only used for manual IP probing
        DiscoveryError::IpUnreachable(_) | DiscoveryError::NotSonosDevice(_) => {
            DiscoveryErrorKind::Timeout {
                configured_ms: timeout_ms,
            }
        }
    }
}

/// Probes a single IP address to verify it's a Sonos speaker.
///
/// Tries port 1400 first (standard Sonos UPnP port used by most devices), then
/// port 1410 as fallback. Port 1410 is used by Sonos Connect and some older Boost
/// devices for HTTP control instead of the standard 1400. See Sonos API docs.
///
/// Returns speaker metadata if successful.
///
/// # Arguments
/// * `client` - HTTP client for making requests
/// * `ip` - IP address to probe (e.g., "192.168.1.100")
///
/// # Errors
/// * `IpUnreachable` - Cannot connect to the IP address on either port
/// * `NotSonosDevice` - IP responds but is not a valid Sonos device description
pub async fn probe_speaker_by_ip(client: &Client, ip: &str) -> Result<Speaker, DiscoveryError> {
    /// Result of probing a URL, distinguishing connection failure from parse failure.
    enum ProbeResult {
        Success(DeviceInfo),
        /// Responded but not a valid Sonos device (wrong content, parse failure, non-2xx status)
        NotSonos,
        /// Could not connect (connection refused, timeout, DNS failure)
        Unreachable,
    }

    /// Probes a URL for device description, tracking failure reason.
    async fn probe_url(client: &Client, url: &str) -> ProbeResult {
        let response = match client.get(url).send().await {
            Ok(r) => r,
            Err(_) => return ProbeResult::Unreachable,
        };

        // Check for successful HTTP status before attempting to parse
        if !response.status().is_success() {
            return ProbeResult::NotSonos;
        }

        let body = match response.text().await {
            Ok(b) => b,
            Err(_) => return ProbeResult::NotSonos,
        };

        match parse_device_description(&body) {
            Some(info) => ProbeResult::Success(info),
            None => ProbeResult::NotSonos,
        }
    }

    // Track if any port was reachable (even if not Sonos)
    let mut any_reachable = false;

    // Try port 1400 first (standard Sonos control port)
    let url_1400 = format!("http://{}:1400/xml/device_description.xml", ip);
    match probe_url(client, &url_1400).await {
        ProbeResult::Success(info) => {
            return Ok(Speaker {
                ip: ip.to_string(),
                uuid: normalize_uuid(&info.uuid),
                name: info.friendly_name,
                model_name: info.model_name,
            });
        }
        ProbeResult::NotSonos => {
            any_reachable = true;
            // Try fallback port
        }
        ProbeResult::Unreachable => {
            // Try fallback port
        }
    }

    // Try port 1410 as fallback (some Sonos devices)
    let url_1410 = format!("http://{}:1410/xml/device_description.xml", ip);
    match probe_url(client, &url_1410).await {
        ProbeResult::Success(info) => Ok(Speaker {
            ip: ip.to_string(),
            uuid: normalize_uuid(&info.uuid),
            name: info.friendly_name,
            model_name: info.model_name,
        }),
        ProbeResult::NotSonos => Err(DiscoveryError::NotSonosDevice(ip.to_string())),
        ProbeResult::Unreachable => {
            // If either port was reachable, the device exists but isn't Sonos
            if any_reachable {
                Err(DiscoveryError::NotSonosDevice(ip.to_string()))
            } else {
                Err(DiscoveryError::IpUnreachable(ip.to_string()))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_device_description() {
        let xml = r#"<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType>
    <friendlyName>Living Room</friendlyName>
    <modelName>Sonos Arc</modelName>
    <modelNumber>S19</modelNumber>
    <UDN>uuid:RINCON_ABC123456789</UDN>
  </device>
</root>"#;

        let info = parse_device_description(xml);
        assert!(info.is_some());
        let info = info.unwrap();
        assert_eq!(info.uuid, "uuid:RINCON_ABC123456789");
        assert_eq!(info.friendly_name, "Living Room");
        assert_eq!(info.model_name, Some("Sonos Arc".to_string()));
        assert_eq!(info.model_number, Some("S19".to_string()));
    }

    #[test]
    fn test_parse_device_description_minimal() {
        let xml = r#"<?xml version="1.0"?>
<root>
  <device>
    <friendlyName>Kitchen</friendlyName>
    <UDN>uuid:RINCON_XYZ789</UDN>
  </device>
</root>"#;

        let info = parse_device_description(xml);
        assert!(info.is_some());
        let info = info.unwrap();
        assert_eq!(info.uuid, "uuid:RINCON_XYZ789");
        assert_eq!(info.friendly_name, "Kitchen");
        assert!(info.model_name.is_none());
    }

    #[test]
    fn test_parse_device_description_missing_required() {
        let xml = r#"<?xml version="1.0"?>
<root>
  <device>
    <modelName>Sonos One</modelName>
  </device>
</root>"#;

        let info = parse_device_description(xml);
        assert!(info.is_none());
    }
}
