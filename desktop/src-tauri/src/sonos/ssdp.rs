use socket2::{Domain, Protocol, SockAddr, Socket, Type};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddrV4, UdpSocket};
use std::time::{Duration, Instant};
use thiserror::Error;

const SSDP_MULTICAST_IP: Ipv4Addr = Ipv4Addr::new(239, 255, 255, 250);
const SSDP_PORT: u16 = 1900;
const SONOS_SEARCH_TARGET: &str = "urn:schemas-upnp-org:device:ZonePlayer:1";

// Discovery parameters
const MX_VALUE: u8 = 3; // Devices respond within 0-MX seconds
const RETRY_COUNT: usize = 3;
const RETRY_INTERVAL_MS: u64 = 800;
const DEFAULT_TIMEOUT_MS: u64 = 5000;

#[derive(Debug, Error)]
pub enum SsdpError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("No valid network interfaces found")]
    NoInterfaces,
}

/// Internal speaker info from SSDP discovery
#[derive(Debug, Clone)]
pub struct DiscoveredSpeaker {
    pub uuid: String,
    pub ip: String,
    /// UPnP device description URL - kept for potential future use
    #[allow(dead_code)]
    pub location: String,
}

/// Get all valid local IPv4 addresses for discovery
/// Filters out loopback and virtual interfaces (docker, veth, etc.)
fn get_valid_interfaces() -> Vec<(String, Ipv4Addr)> {
    let mut result = Vec::new();

    match local_ip_address::list_afinet_netifas() {
        Ok(interfaces) => {
            for (name, addr) in interfaces {
                if let IpAddr::V4(v4) = addr {
                    // Skip loopback
                    if v4.is_loopback() {
                        continue;
                    }

                    // Skip virtual interfaces
                    if name.starts_with("docker")
                        || name.starts_with("veth")
                        || name.starts_with("br-")
                        || name.starts_with("virbr")
                    {
                        continue;
                    }

                    result.push((name, v4));
                }
            }
        }
        Err(e) => {
            log::warn!("Failed to list network interfaces: {}", e);
        }
    }

    result
}

/// Create a UDP socket bound to a specific interface
fn create_socket_for_interface(interface_ip: Ipv4Addr) -> std::io::Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;

    // Allow address reuse
    socket.set_reuse_address(true)?;

    #[cfg(unix)]
    socket.set_reuse_port(true)?;

    // Bind to interface with random port
    let bind_addr = SocketAddrV4::new(interface_ip, 0);
    socket.bind(&SockAddr::from(bind_addr))?;

    // Set read timeout for polling
    socket.set_read_timeout(Some(Duration::from_millis(100)))?;
    socket.set_write_timeout(Some(Duration::from_millis(1000)))?;

    Ok(socket.into())
}

/// Build the M-SEARCH message for SSDP discovery
fn build_msearch() -> String {
    format!(
        "M-SEARCH * HTTP/1.1\r\n\
         HOST: {}:{}\r\n\
         MAN: \"ssdp:discover\"\r\n\
         MX: {}\r\n\
         ST: {}\r\n\
         \r\n",
        SSDP_MULTICAST_IP, SSDP_PORT, MX_VALUE, SONOS_SEARCH_TARGET
    )
}

/// Parse an SSDP response to extract speaker info
fn parse_ssdp_response(response: &str) -> Option<DiscoveredSpeaker> {
    let mut headers: HashMap<String, String> = HashMap::new();

    for line in response.lines() {
        if let Some(colon_idx) = line.find(':') {
            let key = line[..colon_idx].to_lowercase().trim().to_string();
            let value = line[colon_idx + 1..].trim().to_string();
            headers.insert(key, value);
        }
    }

    let location = headers.get("location")?;
    let usn = headers.get("usn")?;

    // Extract UUID from USN (format: uuid:RINCON_xxxx::urn:schemas-upnp-org:device:ZonePlayer:1)
    let uuid = usn.split("::").next()?.strip_prefix("uuid:")?.to_string();

    // Validate it's a Sonos device (RINCON prefix)
    if !uuid.starts_with("RINCON_") {
        return None;
    }

    // Extract IP from location URL
    let ip = location
        .strip_prefix("http://")?
        .split(':')
        .next()?
        .to_string();

    Some(DiscoveredSpeaker {
        uuid,
        ip,
        location: location.clone(),
    })
}

/// Discover Sonos speakers on the local network using SSDP
/// Creates a socket per network interface for reliable discovery
pub fn discover(timeout_ms: u64) -> Result<Vec<DiscoveredSpeaker>, SsdpError> {
    let mut discovered: HashMap<String, DiscoveredSpeaker> = HashMap::new();
    let interfaces = get_valid_interfaces();

    if interfaces.is_empty() {
        log::warn!("[SSDP] No valid network interfaces found");
        return Err(SsdpError::NoInterfaces);
    }

    let interface_names: Vec<_> = interfaces.iter().map(|(name, _)| name.as_str()).collect();
    log::info!(
        "[SSDP] Discovering on {} interface(s): {}",
        interfaces.len(),
        interface_names.join(", ")
    );

    let msearch = build_msearch();
    let multicast_addr = SocketAddrV4::new(SSDP_MULTICAST_IP, SSDP_PORT);

    // Create sockets for each interface
    let mut sockets: Vec<(String, UdpSocket)> = Vec::new();

    for (name, ip) in &interfaces {
        match create_socket_for_interface(*ip) {
            Ok(socket) => {
                log::debug!("[SSDP] Created socket bound to {} ({})", name, ip);
                sockets.push((name.clone(), socket));
            }
            Err(e) => {
                log::warn!(
                    "[SSDP] Failed to create socket for {} ({}): {}",
                    name,
                    ip,
                    e
                );
            }
        }
    }

    if sockets.is_empty() {
        return Err(SsdpError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            "No sockets could be created",
        )));
    }

    // Send M-SEARCH multiple times with spacing
    for i in 0..RETRY_COUNT {
        for (name, socket) in &sockets {
            if let Err(e) = socket.send_to(msearch.as_bytes(), multicast_addr) {
                log::warn!("[SSDP] Failed to send M-SEARCH on {}: {}", name, e);
            }
        }
        if i < RETRY_COUNT - 1 {
            std::thread::sleep(Duration::from_millis(RETRY_INTERVAL_MS));
        }
    }

    // Receive responses until timeout
    let mut buf = [0u8; 2048];
    let timeout = timeout_ms.max(DEFAULT_TIMEOUT_MS);
    let deadline = Instant::now() + Duration::from_millis(timeout);

    while Instant::now() < deadline {
        for (name, socket) in &sockets {
            match socket.recv_from(&mut buf) {
                Ok((len, addr)) => {
                    if let Ok(response) = std::str::from_utf8(&buf[..len]) {
                        if let Some(speaker) = parse_ssdp_response(response) {
                            if !discovered.contains_key(&speaker.uuid) {
                                log::info!(
                                    "[SSDP] Discovered: {} at {} (via {} from {})",
                                    speaker.uuid,
                                    speaker.ip,
                                    name,
                                    addr
                                );
                                discovered.insert(speaker.uuid.clone(), speaker);
                            }
                        }
                    }
                }
                Err(ref e)
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::TimedOut =>
                {
                    // Read timeout - continue polling other sockets
                    continue;
                }
                Err(e) => {
                    log::trace!("[SSDP] Socket recv error on {}: {}", name, e);
                }
            }
        }
        // Small sleep to avoid busy-waiting
        std::thread::sleep(Duration::from_millis(10));
    }

    log::info!(
        "[SSDP] Discovery complete: found {} speaker(s)",
        discovered.len()
    );
    Ok(discovered.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_ssdp_response() {
        let response = "HTTP/1.1 200 OK\r\n\
            CACHE-CONTROL: max-age=1800\r\n\
            LOCATION: http://192.168.1.100:1400/xml/device_description.xml\r\n\
            USN: uuid:RINCON_ABC123::urn:schemas-upnp-org:device:ZonePlayer:1\r\n\
            ST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n\
            \r\n";

        let speaker = parse_ssdp_response(response).unwrap();
        assert_eq!(speaker.uuid, "RINCON_ABC123");
        assert_eq!(speaker.ip, "192.168.1.100");
    }

    #[test]
    fn test_parse_non_sonos_response() {
        let response = "HTTP/1.1 200 OK\r\n\
            LOCATION: http://192.168.1.100:1400/xml/device_description.xml\r\n\
            USN: uuid:OTHER_DEVICE::something\r\n\
            \r\n";

        let speaker = parse_ssdp_response(response);
        assert!(speaker.is_none());
    }
}
