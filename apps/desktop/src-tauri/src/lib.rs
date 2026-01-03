mod api;
mod bootstrap;
mod config;
mod context;
mod error;
mod events;
mod protocol_constants;
mod services;
mod sonos;
mod state;
mod stream;
mod types;
mod ui;
mod utils;

use std::sync::Arc;

rust_i18n::i18n!("locales", fallback = "en");

use tauri::{Manager, RunEvent};
use tauri_plugin_log::{Target, TargetKind};

use crate::api::commands::{
    clear_all_connections, clear_all_streams, get_autostart_enabled, get_groups,
    get_playback_sessions, get_server_port, get_speakers, get_stats, get_transport_states,
    refresh_topology, restart_server, set_autostart_enabled, start_playback,
};
use crate::api::{start_server, AppState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                    Target::new(TargetKind::Webview),
                ])
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .invoke_handler(tauri::generate_handler![
            get_speakers,
            get_groups,
            get_stats,
            get_transport_states,
            get_playback_sessions,
            start_playback,
            get_server_port,
            refresh_topology,
            restart_server,
            clear_all_streams,
            clear_all_connections,
            get_autostart_enabled,
            set_autostart_enabled
        ])
        .setup(|app| {
            // Detect and set system locale for i18n
            if let Some(locale) = sys_locale::get_locale() {
                // Try exact match first, then base language (e.g., "en" from "en-US")
                let base_locale = locale.split('-').next().unwrap_or("en");
                rust_i18n::set_locale(base_locale);
                log::debug!("Locale set to: {} (detected: {})", base_locale, locale);
            }

            let state = Arc::new(AppState::new());

            // Store app handle for restart functionality
            state.set_app_handle(app.handle().clone());

            // Start background tasks
            state.start_background_tasks();

            app.manage((*state).clone());

            // Initialize system tray
            ui::setup_tray(app)?;

            // Enable autostart by default on first run
            {
                use tauri_plugin_autostart::ManagerExt;
                let autostart = app.autolaunch();
                if !autostart.is_enabled().unwrap_or(false) {
                    let _ = autostart.enable();
                    log::info!("Autostart enabled by default");
                }
            }

            // NOTE: Spawning async tasks in Tauri
            // ─────────────────────────────────────────────────────────────────
            // - From SYNC functions: Use `tauri::async_runtime::spawn`
            //   (uses a stored runtime handle, works from any context)
            // - From ASYNC functions: Use `tokio::spawn`
            //   (requires already being on the Tokio runtime)
            //
            // Using `tokio::spawn` from a sync context will panic with:
            // "there is no reactor running, must be called from the context of a Tokio 1.x runtime"
            let state_clone = app.state::<AppState>().inner().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = start_server(state_clone).await {
                    log::error!("Server error: {}", e);
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Hide to tray instead of closing
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { .. } = event {
            log::info!("Application exit requested, cleaning up...");
            if let Some(state) = app_handle.try_state::<AppState>() {
                tauri::async_runtime::block_on(async move {
                    state.shutdown().await;
                    log::info!("Cleanup complete");
                });
            }
        }
    });
}
