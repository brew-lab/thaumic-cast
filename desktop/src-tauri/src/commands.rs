use crate::generated::{ConfigResponse, Speaker, StatusResponse};
use crate::server::AppState;
use tauri::State;

#[tauri::command]
pub async fn get_status(state: State<'_, AppState>) -> Result<StatusResponse, String> {
    let stream_count = state.streams.count();

    // Get actual bound port from server state
    let actual_ports = state.actual_ports.read();
    let (server_running, port) = match actual_ports.as_ref() {
        Some(ports) => (true, ports.http_port),
        None => (false, 0),
    };

    Ok(StatusResponse {
        server_running,
        port,
        active_streams: stream_count as u64,
        discovered_speakers: 0, // Will be updated when speakers are cached
    })
}

#[tauri::command]
pub async fn get_speakers(_state: State<'_, AppState>) -> Result<Vec<Speaker>, String> {
    crate::sonos::discover_speakers(false)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn refresh_speakers(_state: State<'_, AppState>) -> Result<Vec<Speaker>, String> {
    crate::sonos::discover_speakers(true)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_config(state: State<'_, AppState>) -> Result<ConfigResponse, String> {
    // Return actual bound port, or preferred port, or 0 if not started
    let actual_ports = state.actual_ports.read();
    let port = match actual_ports.as_ref() {
        Some(ports) => ports.http_port,
        None => state.config.read().preferred_port.unwrap_or(0),
    };
    Ok(ConfigResponse { port })
}

#[tauri::command]
pub async fn set_port(port: u16, state: State<'_, AppState>) -> Result<(), String> {
    // Note: Changing port requires server restart
    let mut config = state.config.write();
    config.preferred_port = Some(port);
    tracing::info!("Preferred port changed to {}. Restart required.", port);
    Ok(())
}
