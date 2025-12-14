mod commands;
mod network;
mod server;
mod sonos;
mod stream;
mod tray;

use std::sync::Arc;
use parking_lot::RwLock;
use tauri::{Emitter, Manager};

pub use server::AppState;
use stream::StreamManager;

/// Configuration for the desktop app
#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
}

impl Default for Config {
    fn default() -> Self {
        Self { port: 3000 }
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
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let config = Arc::new(RwLock::new(Config::default()));
            let streams = Arc::new(StreamManager::new());
            let gena = Arc::new(tokio::sync::RwLock::new(None));

            // Create app state
            let state = AppState {
                config: config.clone(),
                streams: streams.clone(),
                gena,
            };

            // Store state in Tauri
            app.manage(state.clone());

            // Setup system tray
            tray::setup_tray(app)?;

            // Start the HTTP server in background
            let port = config.read().port;
            let app_handle = app.handle().clone();

            tauri::async_runtime::spawn(async move {
                if let Err(e) = server::start_server(state, port).await {
                    tracing::error!("Server error: {}", e);
                    // Notify the app about the error
                    let _ = app_handle.emit("server-error", e.to_string());
                }
            });

            tracing::info!("Server starting on port {}", port);

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
