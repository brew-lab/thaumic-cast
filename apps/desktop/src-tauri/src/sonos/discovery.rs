use async_trait::async_trait;
use futures::future::join_all;
use local_ip_address::list_afinet_netifas;
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use reqwest::Client;
use serde::Serialize;
use socket2::{Domain, Protocol, Socket, Type};
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::net::UdpSocket;
use tokio::sync::Mutex;
use tokio::time::timeout;

use crate::error::DiscoveryResult;
use crate::sonos::client::SonosClientImpl;
use crate::sonos::traits::SonosDiscovery;

use crate::config::{
    DISCOVERY_TIMEOUT, HTTP_FETCH_TIMEOUT_SECS, SSDP_RETRY_DELAY, SSDP_SEND_COUNT,
};

/// Standard SSDP multicast address and port (protocol specification).
const MULTICAST_ADDR: &str = "239.255.255.250:1900";

/// Virtual interface prefixes to filter out during discovery.
const VIRTUAL_INTERFACE_PREFIXES: &[&str] = &[
    "lo", "docker", "veth", "br-", "virbr", "vmnet", "vbox", "tun", "tap",
];

/// Errors that can occur during SSDP discovery.
#[derive(Debug, Error)]
pub enum DiscoveryError {
    /// Failed to bind UDP socket for discovery.
    #[allow(dead_code)]
    #[error("failed to bind UDP socket: {0}")]
    SocketBind(#[source] std::io::Error),

    /// Failed to send SSDP multicast search.
    #[allow(dead_code)]
    #[error("failed to send SSDP search: {0}")]
    SendSearch(#[source] std::io::Error),

    /// No usable network interfaces found.
    #[error("no usable network interfaces found")]
    NoInterfaces,
}

/// Checks if an interface name belongs to a virtual/container interface.
fn is_virtual_interface(name: &str) -> bool {
    let name_lower = name.to_lowercase();
    VIRTUAL_INTERFACE_PREFIXES
        .iter()
        .any(|prefix| name_lower.starts_with(prefix))
}

#[derive(Debug, Serialize, Clone)]
pub struct Speaker {
    pub ip: String,
    pub name: String,
    pub uuid: String,
}

/// Fetches the real name of a speaker from its UPnP description XML.
async fn fetch_speaker_name(client: &Client, location: &str) -> Option<String> {
    let body = client.get(location).send().await.ok()?.text().await.ok()?;

    let mut reader = Reader::from_str(&body);
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            // Use local_name() to handle potential namespace prefixes (e.g., ns:friendlyName)
            Ok(Event::Start(ref e)) if e.local_name().as_ref() == b"friendlyName" => {
                return reader.read_text(e.name()).ok().map(|t| t.to_string());
            }
            Ok(Event::Eof) => break,
            _ => {}
        }
        buf.clear();
    }
    None
}

/// Intermediate struct for speaker data before name resolution.
#[derive(Debug)]
struct DiscoveredSpeaker {
    ip: String,
    uuid: String,
    location: String,
}

/// Discovers Sonos speakers on the local network using SSDP and fetches their real names.
///
/// Sends SSDP queries on all non-virtual network interfaces to support multi-homed systems.
///
/// # Errors
///
/// Returns an error if no usable network interfaces are found.
pub async fn discover_speakers() -> DiscoveryResult<Vec<Speaker>> {
    // Get all IPv4 interfaces, filtering out virtual ones
    let interfaces: Vec<Ipv4Addr> = list_afinet_netifas()
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
                    Some(ipv4)
                }
                _ => None,
            }
        })
        .collect();

    if interfaces.is_empty() {
        return Err(DiscoveryError::NoInterfaces);
    }

    let msg = "M-SEARCH * HTTP/1.1\r\n\
               HOST: 239.255.255.250:1900\r\n\
               MAN: \"ssdp:discover\"\r\n\
               MX: 1\r\n\
               ST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n";

    // Create sockets for each interface with proper socket options
    let mut sockets: Vec<(Ipv4Addr, UdpSocket)> = Vec::new();
    for iface_ip in &interfaces {
        let bind_addr: SocketAddr = SocketAddr::new(IpAddr::V4(*iface_ip), 0);

        // Use socket2 to set socket options before binding
        let socket = match Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("Failed to create socket for {}: {}", iface_ip, e);
                continue;
            }
        };

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

        // Set non-blocking before converting to tokio socket
        if let Err(e) = socket.set_nonblocking(true) {
            log::warn!("Failed to set non-blocking on {}: {}", iface_ip, e);
            continue;
        }

        // Bind the socket
        if let Err(e) = socket.bind(&bind_addr.into()) {
            log::warn!("Failed to bind socket on {}: {}", iface_ip, e);
            continue;
        }

        // Convert to tokio UdpSocket
        let std_socket: std::net::UdpSocket = socket.into();
        match UdpSocket::from_std(std_socket) {
            Ok(tokio_socket) => {
                sockets.push((*iface_ip, tokio_socket));
            }
            Err(e) => {
                log::warn!("Failed to convert socket to tokio on {}: {}", iface_ip, e);
            }
        }
    }

    if sockets.is_empty() {
        return Err(DiscoveryError::NoInterfaces);
    }

    log::debug!(
        "Starting SSDP discovery on {} interface(s) ({} sends with {}ms spacing)",
        sockets.len(),
        SSDP_SEND_COUNT,
        SSDP_RETRY_DELAY.as_millis()
    );

    // Wrap sockets in Arc for sharing between send and receive tasks
    let sockets: Vec<(Ipv4Addr, Arc<UdpSocket>)> = sockets
        .into_iter()
        .map(|(ip, sock)| (ip, Arc::new(sock)))
        .collect();

    // Phase 1: Collect responses from all sockets concurrently
    let discovered: Arc<Mutex<Vec<DiscoveredSpeaker>>> = Arc::new(Mutex::new(Vec::new()));

    // Spawn send tasks (send M-SEARCH multiple times with delays)
    let send_futures: Vec<_> = sockets
        .iter()
        .map(|(iface_ip, socket)| {
            let socket = Arc::clone(socket);
            let iface_ip = *iface_ip;
            let msg = msg.as_bytes().to_vec();
            async move {
                for i in 0..SSDP_SEND_COUNT {
                    if i > 0 {
                        tokio::time::sleep(SSDP_RETRY_DELAY).await;
                    }
                    if let Err(e) = socket.send_to(&msg, MULTICAST_ADDR).await {
                        log::warn!(
                            "Failed to send SSDP search on {} (attempt {}): {}",
                            iface_ip,
                            i + 1,
                            e
                        );
                    }
                }
            }
        })
        .collect();

    // Spawn receive tasks (collect responses during entire discovery window)
    let recv_futures: Vec<_> = sockets
        .iter()
        .map(|(iface_ip, socket)| {
            let socket = Arc::clone(socket);
            let iface_ip = *iface_ip;
            let discovered = Arc::clone(&discovered);
            async move {
                let mut buf = [0u8; 2048];
                let start = std::time::Instant::now();

                while start.elapsed() < DISCOVERY_TIMEOUT {
                    let remaining = DISCOVERY_TIMEOUT.saturating_sub(start.elapsed());
                    match timeout(remaining, socket.recv_from(&mut buf)).await {
                        Ok(Ok((amt, src))) => {
                            let response = String::from_utf8_lossy(&buf[..amt]);
                            let response_lower = response.to_lowercase();

                            // Case-insensitive check for Sonos device markers
                            if response_lower.contains("sonos") || response_lower.contains("rincon")
                            {
                                // Extract LOCATION header (find colon index to preserve URL colons)
                                let location = response
                                    .lines()
                                    .find(|l| l.to_lowercase().starts_with("location:"))
                                    .and_then(|l| {
                                        l.find(':').map(|idx| l[idx + 1..].trim().to_string())
                                    });

                                // Extract UUID from USN (e.g. uuid:RINCON_...::...)
                                // Use case-insensitive search for "uuid:" prefix
                                let uuid = response
                                    .lines()
                                    .find(|l| l.to_lowercase().starts_with("usn:"))
                                    .and_then(|l| {
                                        let lower = l.to_lowercase();
                                        lower.find("uuid:").map(|idx| &l[idx + 5..])
                                    })
                                    .and_then(|s| s.split("::").next())
                                    .unwrap_or("")
                                    .to_string();

                                if let Some(loc) = location {
                                    if uuid.starts_with("RINCON_") {
                                        let speaker_ip = src.ip().to_string();
                                        log::debug!(
                                            "Discovered speaker: ip={}, uuid={}, via interface {}",
                                            speaker_ip,
                                            uuid,
                                            iface_ip
                                        );
                                        discovered.lock().await.push(DiscoveredSpeaker {
                                            ip: speaker_ip,
                                            uuid,
                                            location: loc,
                                        });
                                    }
                                }
                            }
                        }
                        Ok(Err(e)) => {
                            log::warn!("Socket recv error on {}: {}", iface_ip, e);
                            continue;
                        }
                        Err(_) => break, // Timeout
                    }
                }
            }
        })
        .collect();

    // Run sends and receives concurrently
    let (_, _) = tokio::join!(join_all(send_futures), join_all(recv_futures));

    // Extract discovered speakers (defensive - avoids panic if Arc has lingering refs)
    let mut discovered = std::mem::take(&mut *discovered.lock().await);

    // Deduplicate by UUID using HashSet for O(1) lookup
    let mut seen = HashSet::new();
    discovered.retain(|s| seen.insert(s.uuid.clone()));

    // Sort by UUID for consistent ordering
    discovered.sort_by(|a, b| a.uuid.cmp(&b.uuid));

    log::debug!(
        "Discovery complete: {} unique speaker(s) found",
        discovered.len()
    );

    // Phase 2: Fetch names concurrently
    let client = Client::builder()
        .timeout(Duration::from_secs(HTTP_FETCH_TIMEOUT_SECS))
        .build()
        .unwrap_or_default();

    let name_futures: Vec<_> = discovered
        .iter()
        .map(|s| {
            let client = &client;
            let location = s.location.clone();
            let ip = s.ip.clone();
            async move {
                fetch_speaker_name(client, &location)
                    .await
                    .unwrap_or_else(|| format!("Sonos ({})", ip))
            }
        })
        .collect();

    let names = join_all(name_futures).await;

    // Build final speaker list (order preserved from sorted discovered list)
    let speakers: Vec<Speaker> = discovered
        .into_iter()
        .zip(names)
        .map(|(s, name)| Speaker {
            ip: s.ip,
            name,
            uuid: s.uuid,
        })
        .collect();

    Ok(speakers)
}

// ─────────────────────────────────────────────────────────────────────────────
// Trait Implementation
// ─────────────────────────────────────────────────────────────────────────────

#[async_trait]
impl SonosDiscovery for SonosClientImpl {
    async fn discover_speakers(&self) -> DiscoveryResult<Vec<Speaker>> {
        discover_speakers().await
    }
}
