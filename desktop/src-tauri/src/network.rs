use local_ip_address::local_ip;

/// Get the local IP address of this machine
pub fn get_local_ip() -> Option<String> {
    local_ip().ok().map(|ip| ip.to_string())
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
