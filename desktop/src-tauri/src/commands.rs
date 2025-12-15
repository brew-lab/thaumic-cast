use crate::generated::{ConfigResponse, Speaker, StatusResponse};
use crate::network::get_local_ip;
use crate::server::AppState;
use crate::sonos::{get_cached_speaker_count, get_last_discovery_timestamp};
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

#[tauri::command]
pub async fn get_status(state: State<'_, AppState>) -> Result<StatusResponse, String> {
    let stream_count = state.streams.count();

    // Get actual bound ports from server state (drop guard before await)
    let (server_running, port, gena_port) = {
        let actual_ports = state.actual_ports.read();
        match actual_ports.as_ref() {
            Some(ports) => (true, ports.http_port, ports.gena_port),
            None => (false, 0, None),
        }
    };

    // Get GENA subscription count
    let gena_subscriptions = {
        let gena_guard = state.gena.read().await;
        gena_guard
            .as_ref()
            .map(|g| g.active_subscriptions() as u64)
            .unwrap_or(0)
    };

    // Get startup errors
    let startup_errors = state.startup_errors.read().clone();

    Ok(StatusResponse {
        server_running,
        port,
        gena_port,
        local_ip: get_local_ip(),
        active_streams: stream_count as u64,
        discovered_speakers: get_cached_speaker_count(),
        gena_subscriptions,
        startup_errors: Some(startup_errors),
        last_discovery_at: get_last_discovery_timestamp(),
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
pub async fn set_port(port: u16, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    // Update in-memory config
    {
        let mut config = state.config.write();
        config.preferred_port = Some(port);
    }

    // Persist to store
    let store = app.store("config.json").map_err(|e| e.to_string())?;
    store.set("preferred_port", serde_json::json!(port));
    store.save().map_err(|e| e.to_string())?;

    log::info!(
        "Preferred port changed to {} and saved. Restart required.",
        port
    );
    Ok(())
}
