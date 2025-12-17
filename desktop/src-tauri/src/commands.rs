use crate::generated::{ConfigResponse, SonosStateSnapshot, Speaker, StatusResponse};
use crate::network::get_local_ip;
use crate::server::AppState;
use crate::sonos::gena::SonosEvent;
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

/// Run discovery: SSDP scan, bootstrap groups, subscribe to GENA
async fn run_discovery(state: &AppState) -> Vec<Speaker> {
    state.sonos_state.set_discovery_state(true, 0, None);

    let speakers = match crate::sonos::discover_speakers(true).await {
        Ok(s) => s,
        Err(e) => {
            log::warn!("Discovery failed: {}", e);
            state.sonos_state.complete_discovery(0, vec![], None);
            return vec![];
        }
    };

    let groups = crate::sonos::bootstrap_zone_groups(&speakers)
        .await
        .unwrap_or_default();

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .ok();

    state.sonos_state.complete_discovery(speakers.len() as u64, groups.clone(), timestamp);

    if !groups.is_empty() {
        let coordinator_ips: Vec<String> = groups.iter().map(|g| g.coordinator_ip.clone()).collect();
        let gena_guard = state.gena.read().await;
        if let Some(ref gena) = *gena_guard {
            gena.sync_subscriptions(&coordinator_ips).await;
            state.sonos_state.set_gena_subscriptions(gena.active_subscriptions() as u64);
        }
    }

    log::info!("Discovery complete: {} speakers, {} groups", speakers.len(), groups.len());
    speakers
}

/// Manual refresh: re-discover speakers and update zone groups
#[tauri::command]
pub async fn refresh_speakers(state: State<'_, AppState>) -> Result<Vec<Speaker>, String> {
    Ok(run_discovery(&state).await)
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

/// Clear all activity, then re-discover to restore GENA subscriptions
#[tauri::command]
pub async fn clear_activity(state: State<'_, AppState>) -> Result<(), String> {
    let speaker_ips = state.streams.get_all_speaker_ips();
    let stream_count = state.streams.count();
    let client_count = state.ws_broadcast.client_count().await;

    log::info!(
        "[clear_activity] Starting: {} streams, {} speaker IPs, {} WS clients",
        stream_count,
        speaker_ips.len(),
        client_count
    );

    // Broadcast SourceChanged to extensions (triggers full stop, ignores stopBehavior setting)
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    for ip in &speaker_ips {
        log::info!("[clear_activity] Broadcasting SourceChanged for speaker {}", ip);
        state
            .ws_broadcast
            .broadcast(&SonosEvent::SourceChanged {
                current_uri: String::new(),
                expected_uri: None,
                speaker_ip: ip.clone(),
                timestamp,
            })
            .await;
    }

    // Stop Sonos playback
    for ip in &speaker_ips {
        log::info!("[clear_activity] Sending Stop SOAP to {}", ip);
        let _ = crate::sonos::stop(ip).await;
    }

    // Clear streams and GENA
    state.streams.clear_all();
    {
        let gena_guard = state.gena.read().await;
        if let Some(ref gena) = *gena_guard {
            gena.clear_all_subscriptions().await;
        }
    }

    log::info!("[clear_activity] Cleared streams and GENA, re-discovering...");

    // Re-discover to restore GENA subscriptions
    run_discovery(&state).await;

    Ok(())
}
