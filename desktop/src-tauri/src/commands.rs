use crate::generated::{ConfigResponse, SonosStateSnapshot, Speaker, StatusResponse};
use crate::network::get_local_ip;
use crate::server::AppState;
use crate::sonos::gena::{SonosEvent, TransportState};
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

    // Get connected WebSocket clients count
    let connected_clients = state.ws_broadcast.client_count().await as u64;

    // Get startup errors
    let startup_errors = state.startup_errors.read().clone();

    // Get discovery info from SonosState (single source of truth)
    let sonos_snapshot = state.sonos_state.snapshot();

    Ok(StatusResponse {
        server_running,
        port,
        gena_port,
        local_ip: get_local_ip(),
        active_streams: stream_count as u64,
        discovered_devices: sonos_snapshot.discovered_devices,
        gena_subscriptions,
        connected_clients,
        startup_errors: Some(startup_errors),
        last_discovery_at: sonos_snapshot.last_discovery_at,
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

/// Get the complete Sonos state snapshot (groups, statuses, discovery info)
#[tauri::command]
pub async fn get_sonos_state(state: State<'_, AppState>) -> Result<SonosStateSnapshot, String> {
    Ok(state.sonos_state.snapshot())
}

/// Clear all activity (streams and GENA subscriptions)
/// Properly stops Sonos speakers before clearing state
#[tauri::command]
pub async fn clear_activity(state: State<'_, AppState>) -> Result<(), String> {
    // 1. Collect unique speaker IPs from active streams
    let speaker_ips = state.streams.get_all_speaker_ips();

    // 2. Broadcast transportState: STOPPED to all WebSocket clients
    //    This notifies extensions to stop casting (uses existing event handling)
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    for ip in &speaker_ips {
        state
            .ws_broadcast
            .broadcast(&SonosEvent::TransportState {
                state: TransportState::Stopped,
                speaker_ip: ip.clone(),
                timestamp,
            })
            .await;
    }

    // 3. Stop Sonos playback on each speaker
    for ip in &speaker_ips {
        if let Err(e) = crate::sonos::stop(ip).await {
            log::warn!("Failed to stop speaker {}: {}", ip, e);
            // Continue with other speakers
        }
    }

    // 4. Clear all streams
    state.streams.clear_all();

    // 5. Clear all GENA subscriptions
    {
        let gena_guard = state.gena.read().await;
        if let Some(ref gena) = *gena_guard {
            gena.clear_all_subscriptions().await;
            // Update subscription count in sonos state
            state.sonos_state.set_gena_subscriptions(0);
        }
    }

    log::info!(
        "Cleared all activity (stopped {} speakers)",
        speaker_ips.len()
    );
    Ok(())
}
