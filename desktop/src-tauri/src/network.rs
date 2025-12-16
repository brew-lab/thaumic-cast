use local_ip_address::local_ip;
use std::net::SocketAddr;
use tokio::net::TcpListener;

/// HTTP server port range (high-numbered to avoid dev port conflicts)
/// Keep in sync with packages/shared/src/api.ts DESKTOP_PORT_RANGE
pub const HTTP_PORT_RANGE: std::ops::RangeInclusive<u16> = 45100..=45110;

/// GENA listener port range (high-numbered, separate from HTTP)
pub const GENA_PORT_RANGE: std::ops::RangeInclusive<u16> = 45111..=45120;

/// Get the local IP address of this machine
pub fn get_local_ip() -> Option<String> {
    local_ip().ok().map(|ip| ip.to_string())
}

/// Find an available port from a given range, optionally trying a preferred port first.
/// Returns the bound port and listener on success.
pub async fn find_available_port(
    range: std::ops::RangeInclusive<u16>,
    preferred: Option<u16>,
    bind_addr: [u8; 4],
) -> Result<(u16, TcpListener), String> {
    // If a preferred port is specified, try it first
    if let Some(port) = preferred {
        if let Ok(listener) = TcpListener::bind(SocketAddr::from((bind_addr, port))).await {
            return Ok((port, listener));
        }
        log::warn!("Preferred port {} unavailable, trying fallback range", port);
    }

    // Try ports in the range
    for port in range.clone() {
        match TcpListener::bind(SocketAddr::from((bind_addr, port))).await {
            Ok(listener) => {
                return Ok((port, listener));
            }
            Err(e) => {
                log::debug!("Port {} unavailable: {}", port, e);
            }
        }
    }

    Err(format!("No available ports in range {:?}", range))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_local_ip() {
        // This test may fail in some environments (e.g., no network)
        // but it should work in most cases
        let ip = get_local_ip();
        if let Some(ip) = ip {
            assert!(!ip.is_empty());
            // Basic check that it looks like an IP
            assert!(ip.contains('.') || ip.contains(':'));
        }
    }
}
