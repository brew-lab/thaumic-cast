//! Tauri command handlers.
//!
//! These commands delegate to the service layer - no business logic here.

use serde::Serialize;
use tauri::{Manager, WebviewWindow};
use thaumic_core::{
    probe_speaker_by_ip, validate_speaker_ip, ErrorCode, ManualSpeakerConfig, NetworkHealth,
    PlaybackSession, Speaker, ZoneGroup,
};

use crate::api::AppState;
use crate::error::CommandError;

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
    /// Maximum concurrent streams allowed.
    pub max_streams: usize,
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
        max_streams: state.config.read().streaming.max_concurrent_streams,
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
    let artwork_url = state.artwork_metadata_url();
    state
        .services
        .stream_coordinator
        .start_playback(&ip, &stream_id, None, &artwork_url)
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
pub fn get_playback_sessions(state: tauri::State<'_, AppState>) -> Vec<PlaybackSession> {
    state.services.stream_coordinator.get_all_sessions()
}

// ─────────────────────────────────────────────────────────────────────────────
// Blast radius of the server-wide clears
// ─────────────────────────────────────────────────────────────────────────────

/// How far a server-wide clear reaches.
///
/// One server serves every extension that connects to it, on this machine and
/// on others, so "stop everything" is never a local action: it ends other
/// people's casts too, on machines whose owners are not looking at this tray.
/// This is the count that makes that visible before it happens.
///
/// `clients` is an estimate, not a roll call. `WsConnectionManager` exposes a
/// total socket count only, not the peers behind it, so the number of distinct
/// extensions is derived from the shape of those sockets: an extension holds
/// one control socket for as long as it is connected and opens one further
/// socket per active cast (see `api/ws.rs`), so sockets minus active streams is
/// the number of control sockets, which is the number of connected extensions.
/// It drifts by one per socket that is mid-reconnect, which is fine for
/// deciding whether to warn, and it does not mistake the ordinary single
/// casting client for a crowd. An exact count - and the split between this
/// machine's own clients and the rest - would need `WsConnectionManager` to
/// expose the peer addresses it already canonicalises, next to the
/// `is_loopback_ip` that already classifies them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClearAllImpact {
    /// Live WebSocket connections the clear would drop.
    pub connections: usize,
    /// Active streams the clear would end.
    pub streams: usize,
    /// Estimated number of distinct extensions behind those connections.
    pub clients: usize,
}

impl ClearAllImpact {
    /// Derives the impact from the live connection and stream counts.
    #[must_use]
    pub fn measure(connections: usize, streams: usize) -> Self {
        Self {
            connections,
            streams,
            clients: connections.saturating_sub(streams),
        }
    }

    /// Reads the impact off the running services.
    #[must_use]
    pub fn of(state: &AppState) -> Self {
        Self::measure(
            state.services.ws_manager.connection_count(),
            state.services.stream_coordinator.stream_count(),
        )
    }

    /// Returns `true` when the clear reaches past a single client.
    ///
    /// One client - the ordinary case of this machine casting its own tab -
    /// stays below this, so nothing is logged and nothing is surfaced: the
    /// click stays a single silent click.
    #[must_use]
    pub fn affects_others(&self) -> bool {
        self.clients > 1
    }

    /// One-line summary of the impact, for logs and tray feedback.
    #[must_use]
    pub fn summary(&self) -> String {
        format!(
            "~{} client(s), {} connection(s), {} active stream(s)",
            self.clients, self.connections, self.streams
        )
    }
}

/// Logs a warning when a server-wide clear would reach other clients.
///
/// Contention for a speaker is expected and allowed, but silently ending
/// someone else's cast from a control that looks local is not: this is what
/// puts the blast radius in the log before the action runs.
///
/// Returns the impact so the caller can surface the same numbers to the user.
pub fn warn_if_server_wide(action: &str, state: &AppState) -> ClearAllImpact {
    let impact = ClearAllImpact::of(state);
    if impact.affects_others() {
        log::warn!(
            "[{}] Server-wide: this ends the casts of every connected client, \
             including clients on other machines ({})",
            action,
            impact.summary()
        );
    }
    impact
}

/// Clears all active streams and stops all playback.
///
/// Server-wide: every connected extension loses its cast, not just this
/// machine. Logs a warning naming the blast radius when more than one client
/// is affected.
///
/// Returns the number of streams that were cleared.
#[tauri::command]
pub async fn clear_all_streams(state: tauri::State<'_, AppState>) -> Result<usize, CommandError> {
    warn_if_server_wide("clear_all_streams", state.inner());
    Ok(state.clear_all_streams().await)
}

/// Force-closes all WebSocket connections.
///
/// Server-wide: every connected extension is disconnected. Logs a warning
/// naming the blast radius when more than one client is affected.
#[tauri::command]
pub fn clear_all_connections(state: tauri::State<'_, AppState>) -> usize {
    warn_if_server_wide("clear_all_connections", state.inner());
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

/// Capture capability information for the frontend.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureCapabilities {
    /// Whether WASAPI process loopback capture is available.
    pub wasapi_available: bool,
}

/// Returns capture capabilities for this platform.
#[tauri::command]
pub fn get_capture_capabilities() -> CaptureCapabilities {
    CaptureCapabilities {
        wasapi_available: thaumic_capture::wasapi_available(),
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
    use std::net::IpAddr;

    // Extract IP from URL-like input (e.g., "http://192.168.1.100:1400/")
    let cleaned_ip = extract_ip_from_input(&ip);

    // Parse IP address format
    let parsed_ip: IpAddr = cleaned_ip.parse().map_err(|_| CommandError {
        code: "invalid_ip",
        message: "Invalid IP address format".to_string(),
    })?;

    // Validate using shared validation (rejects IPv6, loopback, multicast, etc.)
    let ipv4 = validate_speaker_ip(&parsed_ip).map_err(|e| CommandError {
        code: e.code(),
        message: e.message().to_string(),
    })?;

    // Use canonical IP string for probing
    probe_speaker_by_ip(state.services.http_client(), &ipv4.to_string())
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

// ─────────────────────────────────────────────────────────────────────────────
// Window Visibility Commands
// ─────────────────────────────────────────────────────────────────────────────

/// Shows the main window after frontend initialization.
///
/// This command is called by the frontend after theme and i18n are initialized.
/// It only shows the window if the app was NOT started with --minimized flag.
/// When started minimized, the window remains hidden (tray-only mode) until
/// the user explicitly clicks the tray icon.
///
/// This approach prevents the flash of unstyled content that would occur if
/// the window was visible before the theme CSS loads.
#[tauri::command]
pub fn show_main_window(window: WebviewWindow, state: tauri::State<'_, AppState>) {
    if state.is_started_minimized() {
        log::debug!("Started minimized, keeping window hidden");
        return;
    }

    if let Err(e) = window.show() {
        log::warn!("Failed to show main window: {}", e);
    }
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

    #[test]
    fn no_connections_affects_nobody() {
        let impact = ClearAllImpact::measure(0, 0);
        assert_eq!(impact.clients, 0);
        assert!(!impact.affects_others());
    }

    #[test]
    fn a_single_idle_client_is_not_a_crowd() {
        // One extension connected, not casting: control socket only.
        let impact = ClearAllImpact::measure(1, 0);
        assert_eq!(impact.clients, 1);
        assert!(!impact.affects_others());
    }

    #[test]
    fn a_single_casting_client_is_not_a_crowd() {
        // One extension casting one tab: control socket + one stream socket.
        let impact = ClearAllImpact::measure(2, 1);
        assert_eq!(impact.clients, 1);
        assert!(!impact.affects_others());
    }

    #[test]
    fn a_single_client_casting_two_tabs_is_not_a_crowd() {
        let impact = ClearAllImpact::measure(3, 2);
        assert_eq!(impact.clients, 1);
        assert!(!impact.affects_others());
    }

    #[test]
    fn two_casting_clients_affect_each_other() {
        // Two extensions, each casting one tab.
        let impact = ClearAllImpact::measure(4, 2);
        assert_eq!(impact.clients, 2);
        assert!(impact.affects_others());
    }

    #[test]
    fn an_idle_client_alongside_a_casting_one_affects_others() {
        let impact = ClearAllImpact::measure(3, 1);
        assert_eq!(impact.clients, 2);
        assert!(impact.affects_others());
    }

    #[test]
    fn more_streams_than_sockets_does_not_underflow() {
        // A stream whose socket already dropped: estimate floors at zero
        // rather than wrapping into a bogus crowd.
        let impact = ClearAllImpact::measure(1, 3);
        assert_eq!(impact.clients, 0);
        assert!(!impact.affects_others());
    }

    #[test]
    fn summary_names_all_three_counts() {
        let summary = ClearAllImpact::measure(4, 2).summary();
        assert!(summary.contains("2 client"), "{}", summary);
        assert!(summary.contains("4 connection"), "{}", summary);
        assert!(summary.contains("2 active stream"), "{}", summary);
    }
}
