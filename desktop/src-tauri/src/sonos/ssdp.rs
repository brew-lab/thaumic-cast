use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::time::Duration;
use thiserror::Error;

const SSDP_MULTICAST_IP: Ipv4Addr = Ipv4Addr::new(239, 255, 255, 250);
const SSDP_PORT: u16 = 1900;
const SONOS_SEARCH_TARGET: &str = "urn:schemas-upnp-org:device:ZonePlayer:1";

#[derive(Debug, Error)]
pub enum SsdpError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
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

/// Build the M-SEARCH message for SSDP discovery
fn build_msearch() -> String {
    format!(
        "M-SEARCH * HTTP/1.1\r\n\
         HOST: {}:{}\r\n\
         MAN: \"ssdp:discover\"\r\n\
         MX: 1\r\n\
         ST: {}\r\n\
         \r\n",
        SSDP_MULTICAST_IP, SSDP_PORT, SONOS_SEARCH_TARGET
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
    let uuid = usn
        .split("::")
        .next()?
        .strip_prefix("uuid:")?
        .to_string();

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
pub fn discover(timeout_ms: u64) -> Result<Vec<DiscoveredSpeaker>, SsdpError> {
    let mut discovered: HashMap<String, DiscoveredSpeaker> = HashMap::new();

    // Create UDP socket
    let socket = UdpSocket::bind("0.0.0.0:0")?;
    // Short read timeout so we can check the deadline frequently
    socket.set_read_timeout(Some(Duration::from_millis(200)))?;

    let multicast_addr = SocketAddrV4::new(SSDP_MULTICAST_IP, SSDP_PORT);
    let msearch = build_msearch();

    // Send M-SEARCH twice for reliability
    socket.send_to(msearch.as_bytes(), multicast_addr)?;

    // Wait a bit and send again
    std::thread::sleep(Duration::from_millis(500));
    socket.send_to(msearch.as_bytes(), multicast_addr)?;

    // Receive responses until timeout
    let mut buf = [0u8; 2048];
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);

    while std::time::Instant::now() < deadline {
        match socket.recv_from(&mut buf) {
            Ok((len, _addr)) => {
                if let Ok(response) = std::str::from_utf8(&buf[..len]) {
                    if let Some(speaker) = parse_ssdp_response(response) {
                        if !discovered.contains_key(&speaker.uuid) {
                            tracing::debug!(
                                "Discovered speaker: {} at {}",
                                speaker.uuid,
                                speaker.ip
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
                // Read timeout - continue waiting until overall deadline
                continue;
            }
            Err(e) => {
                tracing::warn!("SSDP receive error: {}", e);
                break;
            }
        }
    }

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
