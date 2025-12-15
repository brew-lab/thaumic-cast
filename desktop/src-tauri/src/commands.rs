use crate::generated::{ConfigResponse, Speaker, StatusResponse};
use crate::server::AppState;
use tauri::State;

#[tauri::command]
pub async fn get_status(state: State<'_, AppState>) -> Result<StatusResponse, String> {
    let config = state.config.read();
    let stream_count = state.streams.count();

    Ok(StatusResponse {
        server_running: true,
        port: config.port,
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
    let config = state.config.read();
    Ok(ConfigResponse { port: config.port })
}

#[tauri::command]
pub async fn set_port(port: u16, state: State<'_, AppState>) -> Result<(), String> {
    // Note: Changing port requires server restart
    let mut config = state.config.write();
    config.port = port;
    tracing::info!("Port changed to {}. Restart required.", port);
    Ok(())
}
