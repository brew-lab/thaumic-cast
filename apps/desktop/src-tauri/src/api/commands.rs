//! Tauri command handlers.
//!
//! These commands delegate to the service layer - no business logic here.

use crate::api::AppState;
use crate::error::CommandError;
use crate::events::NetworkHealth;
use crate::sonos::discovery::Speaker;
use crate::types::ZoneGroup;
use serde::Serialize;

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

    NetworkHealthResponse {
        health: health_state.health,
        reason: health_state.reason,
    }
}
