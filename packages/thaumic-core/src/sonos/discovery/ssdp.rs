//! SSDP-based Sonos speaker discovery.
//!
//! Supports both multicast (239.255.255.250) and broadcast discovery methods
//! for networks with different multicast configurations.
//!
//! # Discovery Methods
//!
//! - **Multicast**: Standard SSDP M-SEARCH to 239.255.255.250:1900
//! - **Broadcast**: Directed broadcast per interface + limited broadcast fallback
//!
//! Both methods use the same socket for send AND receive since devices reply
//! unicast back to the sending socket/port.

use local_ip_address::list_afinet_netifas;
use socket2::{Domain, Protocol, Socket, Type};
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::UdpSocket;
use tokio::sync::Mutex;
use tokio::time::timeout;

use super::types::{is_virtual_interface, DiscoveredSpeaker, DiscoveryError, DiscoveryMethod};

// ─────────────────────────────────────────────────────────────────────────────
// ASCII Case-Insensitive Helpers
// ─────────────────────────────────────────────────────────────────────────────
//
// These avoid allocations from to_lowercase() during SSDP response parsing.
// HTTP headers are ASCII, so byte-level comparison is safe and efficient.

/// Checks if `haystack` contains `needle` (ASCII case-insensitive, no allocation).
///
/// Complexity: O(n*m) where n=haystack.len(), m=needle.len().
/// Acceptable for small needles in HTTP response parsing.
#[inline]
fn contains_ignore_ascii_case(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    if needle.len() > haystack.len() {
        return false;
    }
    haystack
        .as_bytes()
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

/// Checks if `s` starts with `prefix` (ASCII case-insensitive, no allocation).
#[inline]
fn starts_with_ignore_ascii_case(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len() && s.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

/// Finds the byte index of `needle` in `haystack` (ASCII case-insensitive, no allocation).
/// Returns the index of the first match, or None if not found.
#[inline]
fn find_ignore_ascii_case(haystack: &str, needle: &str) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    if needle.len() > haystack.len() {
        return None;
    }
    haystack
        .as_bytes()
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

// ─────────────────────────────────────────────────────────────────────────────

/// Standard SSDP multicast address and port (protocol specification).
const MULTICAST_ADDR: &str = "239.255.255.250:1900";

/// Limited broadcast address for fallback.
const LIMITED_BROADCAST_ADDR: &str = "255.255.255.255:1900";

/// SSDP search target for Sonos ZonePlayer devices.
const SONOS_SEARCH_TARGET: &str = "urn:schemas-upnp-org:device:ZonePlayer:1";

/// Build the M-SEARCH message.
///
/// Note: HOST header always uses the multicast address per SSDP spec,
/// even when sending via broadcast.
fn build_msearch_message(mx: u64) -> String {
    format!(
        "M-SEARCH * HTTP/1.1\r\n\
         HOST: 239.255.255.250:1900\r\n\
         MAN: \"ssdp:discover\"\r\n\
         MX: {}\r\n\
         ST: {}\r\n\r\n",
        mx, SONOS_SEARCH_TARGET
    )
}

/// Network interface information for discovery.
#[derive(Debug, Clone)]
pub struct InterfaceInfo {
    /// Interface name (e.g., "en0", "eth0").
    pub name: String,
    /// IPv4 address bound to this interface.
    pub ip: Ipv4Addr,
    /// Broadcast address for this interface (if available).
    pub broadcast: Option<Ipv4Addr>,
}

/// Gets all usable network interfaces for discovery.
///
/// Filters out virtual/container interfaces and loopback.
pub fn get_interfaces() -> Vec<InterfaceInfo> {
    list_afinet_netifas()
        .unwrap_or_else(|e| {
            log::warn!("Failed to list network interfaces: {}", e);
            Vec::new()
        })
        .into_iter()
        .filter_map(|(name, addr)| {
            if is_virtual_interface(&name) {
                log::debug!("Skipping virtual interface: {}", name);
                return None;
            }
            match addr {
                IpAddr::V4(ipv4) if !ipv4.is_loopback() => {
                    log::debug!("Using interface {} ({})", name, ipv4);
                    // Compute broadcast address (assume /24 if we can't determine)
                    // This is a simplification - ideally we'd get the actual netmask
                    let octets = ipv4.octets();
                    let broadcast = Ipv4Addr::new(octets[0], octets[1], octets[2], 255);
                    Some(InterfaceInfo {
                        name,
                        ip: ipv4,
                        broadcast: Some(broadcast),
                    })
                }
                _ => None,
            }
        })
        .collect()
}

/// Creates a UDP socket bound to a specific interface.
///
/// Sets up socket options for SSDP discovery:
/// - SO_REUSEADDR for rapid restarts
/// - SO_REUSEPORT on Unix
/// - Multicast TTL of 4 per UPnP spec
/// - SO_BROADCAST for broadcast mode
fn create_socket(iface_ip: Ipv4Addr, enable_broadcast: bool) -> Result<UdpSocket, DiscoveryError> {
    let bind_addr = SocketAddr::new(IpAddr::V4(iface_ip), 0);

    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))
        .map_err(DiscoveryError::SocketBind)?;

    // SO_REUSEADDR - allows bind on rapid restarts
    if let Err(e) = socket.set_reuse_address(true) {
        log::warn!("Failed to set SO_REUSEADDR on {}: {}", iface_ip, e);
    }

    // SO_REUSEPORT - allows multiple sockets on same port (Unix only)
    #[cfg(unix)]
    if let Err(e) = socket.set_reuse_port(true) {
        log::warn!("Failed to set SO_REUSEPORT on {}: {}", iface_ip, e);
    }

    // UPnP 1.0 spec recommends TTL of 4 for SSDP multicast
    if let Err(e) = socket.set_multicast_ttl_v4(4) {
        log::warn!("Failed to set multicast TTL on {}: {}", iface_ip, e);
    }

    // Enable broadcast if requested
    if enable_broadcast {
        if let Err(e) = socket.set_broadcast(true) {
            log::warn!("Failed to set SO_BROADCAST on {}: {}", iface_ip, e);
        }
    }

    // Set non-blocking before converting to tokio socket
    socket
        .set_nonblocking(true)
        .map_err(DiscoveryError::SocketBind)?;

    // Bind the socket
    socket
        .bind(&bind_addr.into())
        .map_err(DiscoveryError::SocketBind)?;

    // Convert to tokio UdpSocket
    let std_socket: std::net::UdpSocket = socket.into();
    UdpSocket::from_std(std_socket).map_err(DiscoveryError::SocketBind)
}

/// Parses an SSDP response and extracts speaker info.
///
/// Returns None if the response doesn't appear to be from a Sonos device.
/// Uses ASCII case-insensitive comparison to avoid allocations during discovery burst.
fn parse_ssdp_response(
    response: &str,
    src_ip: &str,
    method: DiscoveryMethod,
) -> Option<DiscoveredSpeaker> {
    // Case-insensitive check for Sonos device markers (no allocation)
    if !contains_ignore_ascii_case(response, "sonos")
        && !contains_ignore_ascii_case(response, "rincon")
    {
        return None;
    }

    // Extract LOCATION header (find colon index to preserve URL colons)
    let location = response
        .lines()
        .find(|l| starts_with_ignore_ascii_case(l, "location:"))
        .and_then(|l| l.find(':').map(|idx| l[idx + 1..].trim().to_string()));

    // Extract UUID from USN (e.g. uuid:RINCON_...::...)
    // Use case-insensitive search for "uuid:" prefix (no allocation)
    let uuid = response
        .lines()
        .find(|l| starts_with_ignore_ascii_case(l, "usn:"))
        .and_then(|l| find_ignore_ascii_case(l, "uuid:").map(|idx| &l[idx + 5..]))
        .and_then(|s| s.split("::").next())
        .unwrap_or("")
        .to_string();

    // Only accept responses with RINCON UUIDs.
    // Case-sensitive check is intentional: Sonos UUIDs are always uppercase RINCON_.
    if !uuid.starts_with("RINCON_") {
        return None;
    }

    match location {
        Some(loc) => Some(DiscoveredSpeaker::with_location(
            src_ip.to_string(),
            uuid,
            loc,
            method,
        )),
        None => Some(DiscoveredSpeaker::new(src_ip.to_string(), uuid, method)),
    }
}

/// Configuration for SSDP discovery.
#[derive(Debug, Clone)]
pub struct SsdpConfig {
    /// Number of M-SEARCH packets to send.
    pub send_count: u64,
    /// Delay between M-SEARCH retries.
    pub retry_delay: Duration,
    /// Total discovery timeout.
    pub discovery_timeout: Duration,
    /// MX value (max response delay in seconds).
    pub mx_value: u64,
}

impl Default for SsdpConfig {
    fn default() -> Self {
        Self {
            send_count: 3,
            retry_delay: Duration::from_millis(800),
            discovery_timeout: Duration::from_secs(5),
            mx_value: 1,
        }
    }
}

/// Discovers Sonos speakers using SSDP multicast.
///
/// Sends M-SEARCH queries to 239.255.255.250:1900 on all non-virtual interfaces.
pub async fn discover_multicast(
    config: &SsdpConfig,
) -> Result<Vec<DiscoveredSpeaker>, DiscoveryError> {
    discover_ssdp(config, DiscoveryMethod::SsdpMulticast, false).await
}

/// Discovers Sonos speakers using SSDP broadcast.
///
/// Uses two layers:
/// 1. Directed broadcast per interface (e.g., 192.168.1.255)
/// 2. Limited broadcast fallback (255.255.255.255)
pub async fn discover_broadcast(
    config: &SsdpConfig,
) -> Result<Vec<DiscoveredSpeaker>, DiscoveryError> {
    discover_ssdp(config, DiscoveryMethod::SsdpBroadcast, true).await
}

/// Internal SSDP discovery implementation.
///
/// Uses the same socket for send AND receive since devices reply unicast
/// back to the sending socket/port.
async fn discover_ssdp(
    config: &SsdpConfig,
    method: DiscoveryMethod,
    use_broadcast: bool,
) -> Result<Vec<DiscoveredSpeaker>, DiscoveryError> {
    let interfaces = get_interfaces();

    if interfaces.is_empty() {
        return Err(DiscoveryError::NoInterfaces);
    }

    let msg = build_msearch_message(config.mx_value);

    // Create sockets for each interface
    let mut sockets: Vec<(InterfaceInfo, UdpSocket)> = Vec::new();
    for iface in &interfaces {
        match create_socket(iface.ip, use_broadcast) {
            Ok(socket) => {
                sockets.push((iface.clone(), socket));
            }
            Err(e) => {
                log::warn!(
                    "Failed to create socket for {} ({}): {}",
                    iface.name,
                    iface.ip,
                    e
                );
            }
        }
    }

    if sockets.is_empty() {
        return Err(DiscoveryError::NoInterfaces);
    }

    let interface_names: Vec<_> = sockets
        .iter()
        .map(|(i, _)| format!("{} ({})", i.name, i.ip))
        .collect();
    log::debug!(
        "[{}] Starting discovery on {} interface(s): {:?} ({} sends with {}ms spacing)",
        method,
        sockets.len(),
        interface_names,
        config.send_count,
        config.retry_delay.as_millis()
    );

    // Wrap sockets in Arc for sharing between send and receive tasks
    let sockets: Vec<(InterfaceInfo, Arc<UdpSocket>)> = sockets
        .into_iter()
        .map(|(iface, sock)| (iface, Arc::new(sock)))
        .collect();

    // Collect responses from all sockets concurrently
    let discovered: Arc<Mutex<Vec<DiscoveredSpeaker>>> = Arc::new(Mutex::new(Vec::new()));

    // Determine target addresses based on mode
    let get_target_addrs = |iface: &InterfaceInfo| -> Vec<String> {
        if use_broadcast {
            let mut addrs = Vec::new();
            // Directed broadcast for this interface
            if let Some(broadcast) = iface.broadcast {
                addrs.push(format!("{}:1900", broadcast));
            }
            // Limited broadcast as fallback
            addrs.push(LIMITED_BROADCAST_ADDR.to_string());
            addrs
        } else {
            vec![MULTICAST_ADDR.to_string()]
        }
    };

    // Spawn send tasks (send M-SEARCH multiple times with delays)
    let send_futures: Vec<_> = sockets
        .iter()
        .map(|(iface, socket)| {
            let socket = Arc::clone(socket);
            let iface = iface.clone();
            let msg = msg.as_bytes().to_vec();
            let send_count = config.send_count;
            let retry_delay = config.retry_delay;
            let target_addrs = get_target_addrs(&iface);

            async move {
                for i in 0..send_count {
                    if i > 0 {
                        tokio::time::sleep(retry_delay).await;
                    }
                    for target in &target_addrs {
                        if let Err(e) = socket.send_to(&msg, target).await {
                            log::warn!(
                                "[{}] Failed to send M-SEARCH on {} to {} (attempt {}): {}",
                                method,
                                iface.name,
                                target,
                                i + 1,
                                e
                            );
                        } else {
                            log::trace!(
                                "[{}] Sent M-SEARCH from {} to {}",
                                method,
                                iface.ip,
                                target
                            );
                        }
                    }
                }
            }
        })
        .collect();

    // Spawn receive tasks (collect responses during entire discovery window)
    let recv_futures: Vec<_> = sockets
        .iter()
        .map(|(iface, socket)| {
            let socket = Arc::clone(socket);
            let iface_name = iface.name.clone();
            let iface_ip = iface.ip;
            let discovered = Arc::clone(&discovered);
            let discovery_timeout = config.discovery_timeout;

            async move {
                let mut buf = [0u8; 2048];
                let start = std::time::Instant::now();

                log::trace!(
                    "[{}] Recv loop starting on {} ({})",
                    method,
                    iface_name,
                    iface_ip
                );

                while start.elapsed() < discovery_timeout {
                    let remaining = discovery_timeout.saturating_sub(start.elapsed());
                    match timeout(remaining, socket.recv_from(&mut buf)).await {
                        Ok(Ok((amt, src))) => {
                            let response = String::from_utf8_lossy(&buf[..amt]);
                            if let Some(speaker) =
                                parse_ssdp_response(&response, &src.ip().to_string(), method)
                            {
                                log::debug!(
                                    "[{}] Discovered speaker: ip={}, uuid={}, via {}",
                                    method,
                                    speaker.ip,
                                    speaker.uuid,
                                    iface_name
                                );
                                discovered.lock().await.push(speaker);
                            }
                        }
                        Ok(Err(e)) => {
                            log::warn!(
                                "[{}] Socket recv error on {} ({}): {}",
                                method,
                                iface_name,
                                iface_ip,
                                e
                            );
                        }
                        Err(_) => break, // Timeout
                    }
                }

                log::trace!(
                    "[{}] Recv loop finished on {} ({}) after {}ms",
                    method,
                    iface_name,
                    iface_ip,
                    start.elapsed().as_millis()
                );
            }
        })
        .collect();

    // Run sends and receives concurrently
    log::trace!(
        "[{}] Waiting for {} send futures and {} recv futures",
        method,
        send_futures.len(),
        recv_futures.len()
    );
    let (_, _) = tokio::join!(
        futures::future::join_all(send_futures),
        futures::future::join_all(recv_futures)
    );
    log::trace!("[{}] All send and recv futures completed", method);

    // Extract discovered speakers
    let mut discovered = std::mem::take(&mut *discovered.lock().await);

    // Deduplicate by UUID using HashSet for O(1) lookup
    let mut seen = HashSet::new();
    discovered.retain(|s| seen.insert(s.uuid.clone()));

    // Sort by UUID for consistent ordering
    discovered.sort_by(|a, b| a.uuid.cmp(&b.uuid));

    log::debug!(
        "[{}] Discovery complete: {} unique speaker(s) found",
        method,
        discovered.len()
    );

    Ok(discovered)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_msearch_message() {
        let msg = build_msearch_message(1);
        assert!(msg.contains("M-SEARCH * HTTP/1.1"));
        assert!(msg.contains("HOST: 239.255.255.250:1900"));
        assert!(msg.contains("MX: 1"));
        assert!(msg.contains("ST: urn:schemas-upnp-org:device:ZonePlayer:1"));
    }

    #[test]
    fn test_parse_ssdp_response_valid() {
        let response = r#"HTTP/1.1 200 OK
CACHE-CONTROL: max-age=1800
LOCATION: http://192.168.1.10:1400/xml/device_description.xml
SERVER: Linux UPnP/1.0 Sonos/63.2-88230
USN: uuid:RINCON_ABC12345678901400::urn:schemas-upnp-org:device:ZonePlayer:1
X-RINCON-BOOTSEQ: 123
X-RINCON-HOUSEHOLD: Sonos_abc123

"#;
        let speaker = parse_ssdp_response(response, "192.168.1.10", DiscoveryMethod::SsdpMulticast);
        assert!(speaker.is_some());
        let speaker = speaker.unwrap();
        assert_eq!(speaker.ip, "192.168.1.10");
        assert_eq!(speaker.uuid, "RINCON_ABC12345678901400");
        assert!(speaker.location.is_some());
    }

    #[test]
    fn test_parse_ssdp_response_non_sonos() {
        let response = r#"HTTP/1.1 200 OK
LOCATION: http://192.168.1.20:80/description.xml
USN: uuid:some-other-device

"#;
        let speaker = parse_ssdp_response(response, "192.168.1.20", DiscoveryMethod::SsdpMulticast);
        assert!(speaker.is_none());
    }

    #[test]
    fn test_parse_ssdp_response_case_insensitive() {
        // Headers with mixed case (some devices send lowercase headers)
        let response = r#"HTTP/1.1 200 OK
cache-control: max-age=1800
location: http://192.168.1.10:1400/xml/device_description.xml
server: Linux UPnP/1.0 SONOS/63.2-88230
usn: UUID:RINCON_ABC12345678901400::urn:schemas-upnp-org:device:ZonePlayer:1

"#;
        let speaker = parse_ssdp_response(response, "192.168.1.10", DiscoveryMethod::SsdpMulticast);
        assert!(speaker.is_some());
        let speaker = speaker.unwrap();
        assert_eq!(speaker.uuid, "RINCON_ABC12345678901400");
        assert!(speaker.location.is_some());
    }

    #[test]
    fn test_contains_ignore_ascii_case() {
        assert!(contains_ignore_ascii_case("Hello World", "world"));
        assert!(contains_ignore_ascii_case("Hello World", "HELLO"));
        assert!(contains_ignore_ascii_case("SONOS Speaker", "sonos"));
        assert!(!contains_ignore_ascii_case("Hello", "xyz"));
        assert!(contains_ignore_ascii_case("test", "")); // Empty needle
        assert!(!contains_ignore_ascii_case("ab", "abc")); // Needle longer than haystack
    }

    #[test]
    fn test_starts_with_ignore_ascii_case() {
        assert!(starts_with_ignore_ascii_case(
            "Location: http://...",
            "location:"
        ));
        assert!(starts_with_ignore_ascii_case(
            "LOCATION: http://...",
            "location:"
        ));
        assert!(starts_with_ignore_ascii_case("USN: uuid:...", "usn:"));
        assert!(!starts_with_ignore_ascii_case("X-Custom: value", "usn:"));
    }

    #[test]
    fn test_find_ignore_ascii_case() {
        assert_eq!(find_ignore_ascii_case("USN: uuid:RINCON", "uuid:"), Some(5));
        assert_eq!(find_ignore_ascii_case("USN: UUID:RINCON", "uuid:"), Some(5));
        assert_eq!(find_ignore_ascii_case("no match here", "uuid:"), None);
        assert_eq!(find_ignore_ascii_case("test", ""), Some(0)); // Empty needle
    }
}
