//! Tauri command handlers.
//!
//! These commands delegate to the service layer - no business logic here.

use crate::api::AppState;
use crate::error::CommandError;
use crate::events::NetworkHealth;
use crate::sonos::discovery::{probe_speaker_by_ip, Speaker};
use crate::state::ManualSpeakerConfig;
use crate::types::ZoneGroup;
use serde::Serialize;
use tauri::Manager;

/// Application statistics for the dashboard.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStats {
    /// Number of active WebSocket connections.
    pub connection_count: usize,
    /// Number of active GENA subscriptions.
    pub subscription_count: usize,
    /// Number of active audio streams.
    pub stream_count: usize,
    /// Detected local IP address.
    pub local_ip: String,
    /// Current server port.
    pub port: u16,
}

/// Discovers Sonos speakers on the network.
#[tauri::command]
pub async fn get_speakers(state: tauri::State<'_, AppState>) -> Result<Vec<Speaker>, CommandError> {
    state
        .services
        .sonos
        .discover_speakers()
        .await
        .map_err(Into::into)
}

/// Returns cached zone groups from the discovery service.
#[tauri::command]
pub async fn get_groups(state: tauri::State<'_, AppState>) -> Result<Vec<ZoneGroup>, CommandError> {
    Ok(state
        .services
        .discovery_service
        .sonos_state()
        .groups
        .read()
        .clone())
}

/// Returns the current application statistics.
#[tauri::command]
pub async fn get_stats(state: tauri::State<'_, AppState>) -> Result<AppStats, CommandError> {
    Ok(AppStats {
        connection_count: state.services.ws_manager.connection_count(),
        subscription_count: state
            .services
            .discovery_service
            .gena_manager()
            .subscription_count(),
        stream_count: state.services.stream_coordinator.stream_count(),
        local_ip: state.services.network.get_local_ip(),
        port: state.services.network.get_port(),
    })
}

/// Returns the current server port.
#[tauri::command]
pub async fn get_server_port(state: tauri::State<'_, AppState>) -> Result<u16, CommandError> {
    Ok(state.services.network.get_port())
}

/// Starts network services (HTTP server, discovery, GENA subscriptions).
///
/// This is idempotent - calling multiple times has no effect after the first call.
/// Should be called after the user acknowledges the firewall warning during onboarding,
/// or immediately on app startup if onboarding was already completed.
#[tauri::command]
pub fn start_network_services(state: tauri::State<'_, AppState>) {
    state.start_services();
}

/// Starts playback on a speaker.
#[tauri::command]
pub async fn start_playback(
    ip: String,
    stream_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), CommandError> {
    state
        .services
        .stream_coordinator
        .start_playback(&ip, &stream_id, None)
        .await
        .map_err(Into::into)
}

/// Triggers a manual topology refresh.
#[tauri::command]
pub fn refresh_topology(state: tauri::State<'_, AppState>) {
    state.services.discovery_service.trigger_refresh();
}

/// Returns the current transport states for all speakers.
///
/// Returns a map of speaker IP to transport state (Playing, Stopped, etc.).
#[tauri::command]
pub fn get_transport_states(
    state: tauri::State<'_, AppState>,
) -> std::collections::HashMap<String, String> {
    state
        .services
        .discovery_service
        .sonos_state()
        .transport_states
        .iter()
        .map(|entry| (entry.key().clone(), entry.value().to_string()))
        .collect()
}

/// Returns all active playback sessions.
///
/// A playback session indicates a speaker that is currently casting one of our streams.
#[tauri::command]
pub fn get_playback_sessions(
    state: tauri::State<'_, AppState>,
) -> Vec<crate::services::stream_coordinator::PlaybackSession> {
    state.services.stream_coordinator.get_all_sessions()
}

/// Clears all active streams and stops all playback.
///
/// Returns the number of streams that were cleared.
#[tauri::command]
pub async fn clear_all_streams(state: tauri::State<'_, AppState>) -> Result<usize, CommandError> {
    Ok(state.clear_all_streams().await)
}

/// Force-closes all WebSocket connections.
#[tauri::command]
pub fn clear_all_connections(state: tauri::State<'_, AppState>) -> usize {
    state.services.ws_manager.close_all()
}

/// Restarts the server with graceful cleanup.
///
/// This will:
/// 1. Stop all playback on all speakers
/// 2. Clear all active streams
/// 3. Unsubscribe from all GENA events
/// 4. Restart the application
#[tauri::command]
pub async fn restart_server(state: tauri::State<'_, AppState>) -> Result<(), CommandError> {
    // Clone state to avoid holding the reference across await
    let state = (*state).clone();

    // Spawn the restart in a separate task since it won't return.
    // NOTE: tokio::spawn is fine here because we're in an async fn (already on the runtime).
    // From sync functions, use tauri::async_runtime::spawn instead.
    tokio::spawn(async move {
        state.restart().await;
    });

    Ok(())
}

/// Returns whether autostart is enabled.
#[tauri::command]
pub fn get_autostart_enabled(app: tauri::AppHandle) -> Result<bool, CommandError> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| CommandError {
        code: "autostart_error",
        message: e.to_string(),
    })
}

/// Sets whether autostart is enabled.
#[tauri::command]
pub fn set_autostart_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), CommandError> {
    use tauri_plugin_autostart::ManagerExt;
    let autolaunch = app.autolaunch();
    let result = if enabled {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    };
    result.map_err(|e| CommandError {
        code: "autostart_error",
        message: e.to_string(),
    })
}

/// Network health status response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkHealthResponse {
    /// Current health status.
    pub health: NetworkHealth,
    /// Reason for the current status (if degraded).
    pub reason: Option<String>,
}

/// Returns the current network health status.
///
/// This indicates whether speakers are reachable after discovery.
/// A "degraded" status typically indicates VPN or firewall issues.
#[tauri::command]
pub fn get_network_health(state: tauri::State<'_, AppState>) -> NetworkHealthResponse {
    let health_state = state
        .services
        .discovery_service
        .topology_monitor()
        .get_network_health();

    log::debug!(
        "[Command] get_network_health -> {:?} (reason: {:?})",
        health_state.health,
        health_state.reason
    );

    NetworkHealthResponse {
        health: health_state.health,
        reason: health_state.reason,
    }
}

/// Returns the current platform (windows, macos, linux).
#[tauri::command]
pub fn get_platform() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "unknown"
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual Speaker IP Commands
// ─────────────────────────────────────────────────────────────────────────────

/// Helper to get app data directory from AppHandle.
fn get_app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, CommandError> {
    app.path().app_data_dir().map_err(|e| CommandError {
        code: "path_error",
        message: e.to_string(),
    })
}

/// Probes an IP address to verify it's a Sonos speaker.
///
/// Validates the IP format and rejects special addresses before probing.
/// Accepts bare IPs or URL-like formats (e.g., `http://192.168.1.100/`).
/// Returns speaker info if valid.
#[tauri::command]
pub async fn probe_speaker_ip(
    ip: String,
    state: tauri::State<'_, AppState>,
) -> Result<Speaker, CommandError> {
    use std::net::{IpAddr, Ipv6Addr};

    // Extract IP from URL-like input (e.g., "http://192.168.1.100:1400/")
    let cleaned_ip = extract_ip_from_input(&ip);

    // Parse and validate IP address format
    let parsed_ip: IpAddr = cleaned_ip.parse().map_err(|_| CommandError {
        code: "invalid_ip",
        message: "Invalid IP address format".to_string(),
    })?;

    // Reject special addresses that can't be valid Sonos speakers
    let is_invalid = match parsed_ip {
        IpAddr::V4(ipv4) => {
            ipv4.is_loopback()                          // 127.x.x.x
                || ipv4.is_unspecified()                // 0.0.0.0
                || ipv4.is_broadcast()                  // 255.255.255.255
                || ipv4.is_multicast()                  // 224.0.0.0/4
                || ipv4.is_link_local() // 169.254.x.x
        }
        IpAddr::V6(ipv6) => {
            ipv6.is_loopback()                          // ::1
                || ipv6.is_unspecified()                // ::
                || ipv6.is_multicast()                  // ff00::/8
                || ipv6 == Ipv6Addr::UNSPECIFIED
        }
    };

    if is_invalid {
        return Err(CommandError {
            code: "invalid_ip",
            message: "This IP address cannot be a Sonos speaker".to_string(),
        });
    }

    probe_speaker_by_ip(state.services.http_client(), &cleaned_ip)
        .await
        .map_err(Into::into)
}

/// Extracts an IP address from user input.
///
/// Handles common formats users might enter:
/// - Bare IP: `192.168.1.100`
/// - With protocol: `http://192.168.1.100`
/// - With port: `192.168.1.100:1400`
/// - Full URL: `http://192.168.1.100:1400/xml/device_description.xml`
///
/// Returns the extracted IP or the original input if no pattern matches.
fn extract_ip_from_input(input: &str) -> String {
    let mut s = input.trim();

    // Strip protocol prefix
    if let Some(rest) = s.strip_prefix("http://") {
        s = rest;
    } else if let Some(rest) = s.strip_prefix("https://") {
        s = rest;
    }

    // Take everything before the first '/' (path)
    if let Some(idx) = s.find('/') {
        s = &s[..idx];
    }

    // Handle IPv6 bracketed notation: [::1]:8080
    if s.starts_with('[') {
        if let Some(end_bracket) = s.find(']') {
            // Return just the IP without brackets
            return s[1..end_bracket].to_string();
        }
    }

    // For IPv4 with port: only strip if it looks like host:port (single colon, digits after)
    // IPv6 addresses have multiple colons, so we check for exactly one colon
    let colon_count = s.chars().filter(|&c| c == ':').count();
    if colon_count == 1 {
        if let Some(idx) = s.find(':') {
            let after_colon = &s[idx + 1..];
            if !after_colon.is_empty() && after_colon.chars().all(|c| c.is_ascii_digit()) {
                s = &s[..idx];
            }
        }
    }

    s.to_string()
}

/// Adds a manually configured speaker IP address.
///
/// The IP should be pre-validated with `probe_speaker_ip` first.
/// Uses atomic file operations to prevent race conditions.
/// Triggers a topology refresh after adding to ensure groups are updated.
#[tauri::command]
pub fn add_manual_speaker_ip(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    ip: String,
) -> Result<(), CommandError> {
    let app_data_dir = get_app_data_dir(&app)?;

    ManualSpeakerConfig::add_ip_atomic(&app_data_dir, ip).map_err(|e| CommandError {
        code: "save_error",
        message: e.to_string(),
    })?;

    // Trigger topology refresh so groups update with the new speaker
    state.services.discovery_service.trigger_refresh();

    Ok(())
}

/// Removes a manually configured speaker IP address.
///
/// Uses atomic file operations to prevent race conditions.
/// Triggers a topology refresh after removing to ensure groups are updated.
#[tauri::command]
pub fn remove_manual_speaker_ip(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    ip: String,
) -> Result<(), CommandError> {
    let app_data_dir = get_app_data_dir(&app)?;

    ManualSpeakerConfig::remove_ip_atomic(&app_data_dir, &ip).map_err(|e| CommandError {
        code: "save_error",
        message: e.to_string(),
    })?;

    // Trigger topology refresh so groups update without the removed speaker
    state.services.discovery_service.trigger_refresh();

    Ok(())
}

/// Returns the list of manually configured speaker IP addresses.
#[tauri::command]
pub fn get_manual_speaker_ips(app: tauri::AppHandle) -> Result<Vec<String>, CommandError> {
    let app_data_dir = get_app_data_dir(&app)?;

    let config = ManualSpeakerConfig::load(&app_data_dir);
    Ok(config.speaker_ips)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_ip_bare_ipv4() {
        assert_eq!(extract_ip_from_input("192.168.1.100"), "192.168.1.100");
    }

    #[test]
    fn extract_ip_with_whitespace() {
        assert_eq!(extract_ip_from_input("  192.168.1.100  "), "192.168.1.100");
    }

    #[test]
    fn extract_ip_with_http_prefix() {
        assert_eq!(
            extract_ip_from_input("http://192.168.1.100"),
            "192.168.1.100"
        );
    }

    #[test]
    fn extract_ip_with_https_prefix() {
        assert_eq!(
            extract_ip_from_input("https://192.168.1.100"),
            "192.168.1.100"
        );
    }

    #[test]
    fn extract_ip_with_trailing_slash() {
        assert_eq!(
            extract_ip_from_input("http://192.168.1.100/"),
            "192.168.1.100"
        );
    }

    #[test]
    fn extract_ip_with_port() {
        assert_eq!(extract_ip_from_input("192.168.1.100:1400"), "192.168.1.100");
    }

    #[test]
    fn extract_ip_full_url() {
        assert_eq!(
            extract_ip_from_input("http://192.168.1.100:1400/xml/device_description.xml"),
            "192.168.1.100"
        );
    }

    #[test]
    fn extract_ip_ipv6_bare() {
        assert_eq!(extract_ip_from_input("::1"), "::1");
        assert_eq!(extract_ip_from_input("fe80::1"), "fe80::1");
    }

    #[test]
    fn extract_ip_ipv6_bracketed() {
        assert_eq!(extract_ip_from_input("[::1]"), "::1");
        assert_eq!(extract_ip_from_input("[::1]:8080"), "::1");
        assert_eq!(extract_ip_from_input("http://[::1]:8080/"), "::1");
    }
}
