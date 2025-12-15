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
use tauri_plugin_store::StoreExt;

/// Interval between automatic speaker discoveries (5 minutes)
const DISCOVERY_INTERVAL: Duration = Duration::from_secs(300);

pub use server::AppState;
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
            tracing::info!("Loaded config from store: {:?}", config);
            config
        }
        Err(e) => {
            tracing::warn!("Could not load config store, using defaults: {}", e);
            Config::default()
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("thaumic_cast_desktop=debug".parse().unwrap()),
        )
        .init();

    tracing::info!("Starting Thaumic Cast Desktop");

    tauri::Builder::default()
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

            // Create app state
            let state = AppState {
                config: config.clone(),
                streams: streams.clone(),
                gena,
                actual_ports,
                startup_errors,
            };

            // Store state in Tauri
            app.manage(state.clone());

            // Setup system tray
            tray::setup_tray(app)?;

            // Start the HTTP server in background
            let preferred_port = config.read().preferred_port;
            let app_handle = app.handle().clone();

            tauri::async_runtime::spawn(async move {
                if let Err(e) = server::start_server(state, preferred_port).await {
                    tracing::error!("Server error: {}", e);
                    // Notify the app about the error
                    let _ = app_handle.emit("server-error", e.to_string());
                }
            });

            tracing::info!("Server starting (port will be auto-allocated if not specified)");

            // Start speaker discovery task (runs immediately, then every DISCOVERY_INTERVAL)
            tauri::async_runtime::spawn(async {
                let mut interval = tokio::time::interval(DISCOVERY_INTERVAL);
                loop {
                    interval.tick().await;
                    tracing::debug!("Running speaker discovery...");
                    match sonos::discover_speakers(true).await {
                        Ok(speakers) => {
                            tracing::info!("Discovery complete: found {} speakers", speakers.len());
                        }
                        Err(e) => {
                            tracing::warn!("Speaker discovery failed: {}", e);
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::get_speakers,
            commands::refresh_speakers,
            commands::get_config,
            commands::set_port,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
