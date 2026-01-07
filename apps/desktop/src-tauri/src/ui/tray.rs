//! System tray integration.
//!
//! Provides the system tray icon with context menu for quick access to
//! common actions: viewing status, toggling autostart, and controlling streams.

use std::future::Future;

use rust_i18n::t;
use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewWindow,
};
use tauri_plugin_autostart::ManagerExt;
use thiserror::Error;

use crate::api::AppState;

// ─────────────────────────────────────────────────────────────────────────────
// Menu Item Identifiers
// ─────────────────────────────────────────────────────────────────────────────

/// System tray menu item identifiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MenuItem {
    /// App name header (disabled).
    AppName,
    /// Dynamic status line (disabled).
    Status,
    /// Opens the dashboard window.
    Dashboard,
    /// Toggles launch at startup.
    LaunchAtStartup,
    /// Stops all active streams.
    StopAllStreams,
    /// Restarts the server.
    RestartServer,
    /// Quits the application.
    Quit,
}

impl MenuItem {
    const fn id(self) -> &'static str {
        match self {
            Self::AppName => "app_name",
            Self::Status => "status",
            Self::Dashboard => "dashboard",
            Self::LaunchAtStartup => "launch_at_startup",
            Self::StopAllStreams => "stop_all_streams",
            Self::RestartServer => "restart_server",
            Self::Quit => "quit",
        }
    }

    fn from_id(id: &str) -> Option<Self> {
        match id {
            "app_name" => Some(Self::AppName),
            "status" => Some(Self::Status),
            "dashboard" => Some(Self::Dashboard),
            "launch_at_startup" => Some(Self::LaunchAtStartup),
            "stop_all_streams" => Some(Self::StopAllStreams),
            "restart_server" => Some(Self::RestartServer),
            "quit" => Some(Self::Quit),
            _ => None,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Handling
// ─────────────────────────────────────────────────────────────────────────────

/// Errors during tray initialization.
#[derive(Debug, Error)]
pub enum TrayError {
    #[error("failed to build tray: {0}")]
    Build(String),

    #[error("application icon not available")]
    MissingIcon,
}

/// Extension trait for converting menu errors to `TrayError`.
trait MenuResultExt<T> {
    fn tray_err(self) -> Result<T, TrayError>;
}

impl<T, E: std::fmt::Display> MenuResultExt<T> for Result<T, E> {
    fn tray_err(self) -> Result<T, TrayError> {
        self.map_err(|e| TrayError::Build(e.to_string()))
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Gets the current status text based on app state.
fn get_status_text(app: &tauri::App) -> String {
    let Some(state) = app.try_state::<AppState>() else {
        return t!("tray.status_idle").to_string();
    };

    match state.services.stream_coordinator.stream_count() {
        0 => t!("tray.status_idle").to_string(),
        1 => t!("tray.status_streaming_one").to_string(),
        n => t!("tray.status_streaming_many", count = n).to_string(),
    }
}

/// Checks if autostart is currently enabled.
fn is_autostart_enabled(app: &tauri::App) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Spawns an async task with access to `AppState`.
fn spawn_with_state<F, Fut>(app: &AppHandle, f: F)
where
    F: FnOnce(AppState) -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send,
{
    let Some(state) = app.try_state::<AppState>() else {
        log::warn!("AppState not available");
        return;
    };

    let state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        f(state).await;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tray Setup
// ─────────────────────────────────────────────────────────────────────────────

/// Initializes the system tray with menu and event handlers.
pub fn setup_tray(app: &tauri::App) -> Result<(), TrayError> {
    let icon = app.default_window_icon().ok_or(TrayError::MissingIcon)?;

    // Get app version from config
    let version = app.config().version.clone().unwrap_or_default();
    let app_name_label = format!("{} v{}", t!("tray.app_name"), version);

    // Build menu items
    let app_name = MenuItemBuilder::with_id(MenuItem::AppName.id(), &app_name_label)
        .enabled(false)
        .build(app)
        .tray_err()?;

    let status = MenuItemBuilder::with_id(MenuItem::Status.id(), get_status_text(app))
        .enabled(false)
        .build(app)
        .tray_err()?;

    let dashboard = MenuItemBuilder::with_id(MenuItem::Dashboard.id(), t!("tray.dashboard"))
        .build(app)
        .tray_err()?;

    let launch_at_startup =
        CheckMenuItemBuilder::with_id(MenuItem::LaunchAtStartup.id(), t!("tray.launch_at_startup"))
            .checked(is_autostart_enabled(app))
            .build(app)
            .tray_err()?;

    let stop_all_streams =
        MenuItemBuilder::with_id(MenuItem::StopAllStreams.id(), t!("tray.stop_all_streams"))
            .build(app)
            .tray_err()?;

    let restart_server =
        MenuItemBuilder::with_id(MenuItem::RestartServer.id(), t!("tray.restart_server"))
            .build(app)
            .tray_err()?;

    let quit = MenuItemBuilder::with_id(MenuItem::Quit.id(), t!("tray.quit"))
        .build(app)
        .tray_err()?;

    let separator = || PredefinedMenuItem::separator(app).tray_err();

    let menu = MenuBuilder::new(app)
        .item(&app_name)
        .item(&status)
        .item(&separator()?)
        .item(&dashboard)
        .item(&separator()?)
        .item(&launch_at_startup)
        .item(&separator()?)
        .item(&stop_all_streams)
        .item(&restart_server)
        .item(&separator()?)
        .item(&quit)
        .build()
        .tray_err()?;

    TrayIconBuilder::new()
        .icon(icon.clone())
        .menu(&menu)
        .tooltip(t!("tray.tooltip"))
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(on_tray_click)
        .build(app)
        .tray_err()?;

    log::debug!("System tray initialized");
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Handlers
// ─────────────────────────────────────────────────────────────────────────────

/// Handles context menu item selection.
fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match MenuItem::from_id(event.id.as_ref()) {
        Some(MenuItem::AppName | MenuItem::Status) => {
            // Disabled items, no action
        }
        Some(MenuItem::Dashboard) => {
            show_main_window(app);
        }
        Some(MenuItem::LaunchAtStartup) => {
            toggle_autostart(app);
        }
        Some(MenuItem::StopAllStreams) => {
            stop_all_streams(app);
        }
        Some(MenuItem::RestartServer) => {
            restart_server(app);
        }
        Some(MenuItem::Quit) => {
            log::info!("Quit requested via tray");
            app.exit(0);
        }
        None => {
            log::warn!("Unknown menu item: {}", event.id.as_ref());
        }
    }
}

/// Handles left-click on tray icon to show window.
fn on_tray_click(tray: &tauri::tray::TrayIcon, event: TrayIconEvent) {
    if matches!(
        event,
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
    ) {
        show_main_window(tray.app_handle());
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Menu Actions
// ─────────────────────────────────────────────────────────────────────────────

/// Shows and focuses the main window.
fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log::warn!("Main window not found");
        return;
    };

    focus_window(&window);
}

/// Toggles the autostart setting.
fn toggle_autostart(app: &AppHandle) {
    let autolaunch = app.autolaunch();

    let currently_enabled = autolaunch.is_enabled().unwrap_or(false);

    let result = if currently_enabled {
        autolaunch.disable()
    } else {
        autolaunch.enable()
    };

    match result {
        Ok(()) => {
            log::info!(
                "Autostart {}",
                if currently_enabled {
                    "disabled"
                } else {
                    "enabled"
                }
            );
        }
        Err(e) => {
            log::error!("Failed to toggle autostart: {}", e);
        }
    }
}

/// Stops all active streams.
fn stop_all_streams(app: &AppHandle) {
    spawn_with_state(app, |state| async move {
        let count = state.clear_all_streams().await;
        log::info!("Stopped {} stream(s) via tray", count);
    });
}

/// Restarts the server.
fn restart_server(app: &AppHandle) {
    spawn_with_state(app, |state| async move {
        state.restart().await;
    });
}

fn focus_window(window: &WebviewWindow) {
    // On macOS, show the dock icon when window is shown
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        let _ = window
            .app_handle()
            .set_activation_policy(ActivationPolicy::Regular);
    }

    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}
