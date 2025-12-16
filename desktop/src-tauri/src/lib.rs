mod commands;
mod generated;
mod network;
mod server;
mod sonos;
mod stream;
mod tray;

// Re-export generated types for use across the crate
pub use generated::*;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_store::StoreExt;

/// Interval between automatic speaker discoveries (5 minutes)
const DISCOVERY_INTERVAL: Duration = Duration::from_secs(300);

pub use server::AppState;
use sonos::SonosState;
use stream::StreamManager;

/// Default trusted origin for the Thaumic Cast Chrome extension
const DEFAULT_EXTENSION_ORIGIN: &str = "chrome-extension://ogckmcojbnambmcpionhaeokhcopikbj";

/// Configuration for the desktop app (persisted to config.json)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Preferred HTTP port (None = auto-allocate from range)
    #[serde(default)]
    pub preferred_port: Option<u16>,

    /// Trusted origins for CORS (extension origins that can make requests)
    #[serde(default = "default_trusted_origins")]
    pub trusted_origins: Vec<String>,
}

fn default_trusted_origins() -> Vec<String> {
    vec![
        DEFAULT_EXTENSION_ORIGIN.to_string(),
        "http://localhost".to_string(),
        "http://127.0.0.1".to_string(),
    ]
}

impl Default for Config {
    fn default() -> Self {
        Self {
            preferred_port: None,
            trusted_origins: default_trusted_origins(),
        }
    }
}

/// Load config from store, falling back to defaults if not found
fn load_config_from_store(app: &tauri::App) -> Config {
    match app.store("config.json") {
        Ok(store) => {
            let preferred_port = store
                .get("preferred_port")
                .and_then(|v| v.as_u64())
                .map(|v| v as u16);

            let trusted_origins = store
                .get("trusted_origins")
                .and_then(|v| {
                    v.as_array().map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect::<Vec<_>>()
                    })
                })
                .unwrap_or_else(default_trusted_origins);

            let config = Config {
                preferred_port,
                trusted_origins,
            };
            log::info!("Loaded config from store: {:?}", config);
            config
        }
        Err(e) => {
            log::warn!("Could not load config store, using defaults: {}", e);
            Config::default()
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                    Target::new(TargetKind::Webview),
                ])
                .max_file_size(5_000_000) // 5MB per file
                .rotation_strategy(RotationStrategy::KeepSome(3)) // Keep last 3 log files
                .level(log::LevelFilter::Info)
                .level_for("thaumic_cast_desktop_lib", log::LevelFilter::Debug)
                .build(),
        )
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args(["--minimized"])
                .build(),
        )
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Load config from persistent store
            let loaded_config = load_config_from_store(app);
            let config = Arc::new(RwLock::new(loaded_config));

            let streams = Arc::new(StreamManager::new());
            let gena = Arc::new(tokio::sync::RwLock::new(None));
            let actual_ports = Arc::new(RwLock::new(None));
            let startup_errors = Arc::new(RwLock::new(Vec::new()));
            let sonos_state = Arc::new(SonosState::new());

            // Set app handle on SonosState for event emission
            sonos_state.set_app_handle(app.handle().clone());

            // Set app handle on StreamManager for event emission
            streams.set_app_handle(app.handle().clone());

            // Create WebSocket broadcast manager
            let ws_broadcast = Arc::new(server::WsBroadcast::new());
            ws_broadcast.set_app_handle(app.handle().clone());

            // Create app state
            let state = AppState {
                config: config.clone(),
                streams: streams.clone(),
                gena,
                actual_ports,
                startup_errors,
                sonos_state: sonos_state.clone(),
                ws_broadcast,
            };

            // Store state in Tauri
            app.manage(state.clone());

            // Setup system tray
            tray::setup_tray(app)?;

            // Setup deep link handler
            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    log::info!("Deep link received: {}", url);
                    // thaumic-cast://launch - bring app window to foreground
                    if url.host_str() == Some("launch") {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
            });

            // Start the HTTP server in background
            let preferred_port = config.read().preferred_port;
            let app_handle = app.handle().clone();

            // Clone references for discovery task before state is moved to server
            let gena_for_discovery = state.gena.clone();
            let sonos_state_for_discovery = sonos_state.clone();

            tauri::async_runtime::spawn(async move {
                if let Err(e) = server::start_server(state, preferred_port, app_handle.clone()).await
                {
                    log::error!("Server error: {}", e);
                    // Notify the app about the error
                    let _ = app_handle.emit("server-error", e.to_string());
                }
            });

            log::info!("Server starting (port will be auto-allocated if not specified)");

            // Start speaker discovery task (runs immediately, then every DISCOVERY_INTERVAL)
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(DISCOVERY_INTERVAL);
                loop {
                    interval.tick().await;
                    log::debug!("Running speaker discovery...");

                    // Mark discovery as in progress
                    sonos_state_for_discovery.set_discovery_state(true, 0, None);

                    match sonos::discover_speakers(true).await {
                        Ok(speakers) => {
                            log::info!("Discovery complete: found {} speakers", speakers.len());

                            // Update device count and timestamp
                            let timestamp = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_secs())
                                .ok();
                            sonos_state_for_discovery.set_discovery_state(
                                false,
                                speakers.len() as u64,
                                timestamp,
                            );

                            // After discovery, get groups and auto-subscribe
                            if let Ok(groups) = sonos::get_zone_groups(None).await {
                                // Update groups in centralized state
                                sonos_state_for_discovery.set_groups(groups.clone());

                                let coordinator_ips: Vec<String> =
                                    groups.iter().map(|g| g.coordinator_ip.clone()).collect();

                                let gena_guard = gena_for_discovery.read().await;
                                if let Some(ref gena) = *gena_guard {
                                    gena.auto_subscribe_to_groups(&coordinator_ips).await;
                                    // Update subscription count
                                    sonos_state_for_discovery
                                        .set_gena_subscriptions(gena.active_subscriptions() as u64);
                                }
                            }
                        }
                        Err(e) => {
                            log::warn!("Speaker discovery failed: {}", e);
                            // Mark discovery as complete (failed)
                            sonos_state_for_discovery.set_discovery_state(false, 0, None);
                        }
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Intercept close to hide window instead of quitting app
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::get_speakers,
            commands::refresh_speakers,
            commands::get_sonos_state,
            commands::get_config,
            commands::set_port,
            commands::clear_activity,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
