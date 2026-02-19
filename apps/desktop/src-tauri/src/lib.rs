//! Thaumic Cast Desktop - Tauri desktop application.
//!
//! This crate provides the Tauri desktop wrapper around thaumic-core.
//! It handles platform-specific concerns like:
//! - Tauri event emission to the frontend
//! - System tray integration
//! - Process priority elevation
//! - Application lifecycle (restart via Tauri)

mod api;
mod error;
mod tauri_emitter;
mod ui;
mod utils;

use std::sync::Arc;

rust_i18n::i18n!("locales", fallback = "en");

use tauri::{Manager, RunEvent};
use tauri_plugin_log::{Target, TargetKind};

use crate::api::commands::{
    add_manual_speaker_ip, clear_all_connections, clear_all_streams, get_autostart_enabled,
    get_groups, get_manual_speaker_ips, get_network_health, get_platform, get_playback_sessions,
    get_server_port, get_speakers, get_stats, get_transport_states, probe_speaker_ip,
    refresh_topology, remove_manual_speaker_ip, restart_server, set_autostart_enabled,
    show_main_window, start_network_services, start_playback,
};
use crate::api::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Elevate process priority to reduce audio stuttering under CPU load.
    // Must be called early, before starting the HTTP server.
    utils::raise_process_priority();

    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                    Target::new(TargetKind::Webview),
                ])
                .max_file_size(1_000_000) // 1 MB (default 40 KB rotates away pipeline timelines)
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
            get_network_health,
            get_platform,
            start_playback,
            get_server_port,
            start_network_services,
            refresh_topology,
            restart_server,
            clear_all_streams,
            clear_all_connections,
            get_autostart_enabled,
            set_autostart_enabled,
            probe_speaker_ip,
            add_manual_speaker_ip,
            remove_manual_speaker_ip,
            get_manual_speaker_ips,
            show_main_window
        ])
        .setup(|app| {
            // Detect and set system locale for i18n
            if let Some(locale) = sys_locale::get_locale() {
                // Try exact match first, then base language (e.g., "en" from "en-US")
                let base_locale = locale.split('-').next().unwrap_or("en");
                rust_i18n::set_locale(base_locale);
                log::debug!("Locale set to: {} (detected: {})", base_locale, locale);
            }

            // Check if started with --minimized flag (auto-start mode).
            // Window starts hidden (visible: false in tauri.conf.json) and is shown
            // by the frontend via show_main_window command after initialization.
            // When minimized, window stays hidden (tray-only mode).
            let start_minimized = std::env::args().any(|arg| arg == "--minimized");
            if start_minimized {
                log::info!("Starting minimized to system tray (auto-start mode)");

                // On macOS, hide the dock icon when starting minimized
                #[cfg(target_os = "macos")]
                {
                    use tauri::ActivationPolicy;
                    let _ = app.set_activation_policy(ActivationPolicy::Accessory);
                }
            }

            let state = Arc::new(AppState::new(start_minimized));

            // Store app handle for restart functionality
            state.set_app_handle(app.handle().clone());

            // NOTE: Network services (HTTP server, discovery, GENA) are NOT started here.
            // They are started by the frontend calling `start_network_services` after:
            // - User acknowledges the firewall warning during onboarding, OR
            // - Onboarding was already completed (called immediately on app load)
            // This ensures the Windows Firewall prompt appears AFTER the warning is shown.

            app.manage((*state).clone());

            // Initialize system tray
            ui::setup_tray(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // Hide to tray instead of closing
                    api.prevent_close();
                    let _ = window.hide();

                    // On macOS, hide the dock icon when window is hidden
                    #[cfg(target_os = "macos")]
                    {
                        use tauri::ActivationPolicy;
                        let _ = window
                            .app_handle()
                            .set_activation_policy(ActivationPolicy::Accessory);
                    }
                }
                tauri::WindowEvent::ThemeChanged(theme) => {
                    // Update tray icon for new theme (Windows only, no-op on other platforms)
                    if let Some(tray_state) = window.app_handle().try_state::<ui::TrayState>() {
                        tray_state.update_for_theme(*theme);
                    }
                }
                _ => {}
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
