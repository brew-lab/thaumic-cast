//! System tray integration.
//!
//! Provides the system tray icon with context menu for quick access to
//! common actions: viewing status, toggling autostart, and controlling streams.
//!
//! The tray menu status line updates dynamically when streams are created or ended.
//! On macOS, the tray icon uses template images that adapt to light/dark mode.

use std::future::Future;

use rust_i18n::t;
use tauri::{
    image::Image,
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewWindow,
};
use tauri_plugin_autostart::ManagerExt;
use thiserror::Error;

use crate::api::AppState;
use crate::events::{BroadcastEvent, StreamEvent};

// ─────────────────────────────────────────────────────────────────────────────
// Tray State
// ─────────────────────────────────────────────────────────────────────────────

/// Holds references to tray menu items that need dynamic updates.
#[derive(Clone)]
pub struct TrayState {
    /// The status menu item showing streaming state.
    status_item: MenuItem<tauri::Wry>,
    /// The tray icon for dynamic icon updates.
    tray_icon: TrayIcon<tauri::Wry>,
}

impl TrayState {
    /// Updates the status text based on current stream count.
    fn update_status(&self, stream_count: usize) {
        let text = format_status_text(stream_count);
        if let Err(e) = self.status_item.set_text(&text) {
            log::warn!("Failed to update tray status: {}", e);
        }
    }

    /// Updates the tray icon based on streaming state.
    fn update_icon(&self, is_streaming: bool) {
        let icon = if is_streaming {
            load_tray_icon_active()
        } else {
            load_tray_icon_idle()
        };

        match icon {
            Ok(img) => {
                if let Err(e) = self.tray_icon.set_icon(Some(img)) {
                    log::warn!("Failed to update tray icon: {}", e);
                }
            }
            Err(e) => {
                log::warn!("Failed to load tray icon: {}", e);
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Icon Loading
// ─────────────────────────────────────────────────────────────────────────────

/// Icon bytes for active state (embedded at compile time).
const TRAY_ICON_ACTIVE: &[u8] = include_bytes!("../../icons/tray/tray-template.png");
/// Icon bytes for idle state (embedded at compile time).
const TRAY_ICON_IDLE: &[u8] = include_bytes!("../../icons/tray/tray-idle.png");

/// Loads the active tray icon.
fn load_tray_icon_active() -> Result<Image<'static>, TrayError> {
    Image::from_bytes(TRAY_ICON_ACTIVE).map_err(|e| TrayError::Build(e.to_string()))
}

/// Loads the idle tray icon.
fn load_tray_icon_idle() -> Result<Image<'static>, TrayError> {
    Image::from_bytes(TRAY_ICON_IDLE).map_err(|e| TrayError::Build(e.to_string()))
}

/// Formats the status text for a given stream count.
fn format_status_text(stream_count: usize) -> String {
    match stream_count {
        0 => t!("tray.status_idle").to_string(),
        1 => t!("tray.status_streaming_one").to_string(),
        n => t!("tray.status_streaming_many", count = n).to_string(),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Menu Item Identifiers
// ─────────────────────────────────────────────────────────────────────────────

/// System tray menu item identifiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MenuItemId {
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

impl MenuItemId {
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
        return format_status_text(0);
    };

    format_status_text(state.services.stream_coordinator.stream_count())
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
///
/// Also starts a background task to update the status line when streams change.
pub fn setup_tray(app: &tauri::App) -> Result<(), TrayError> {
    // Load initial icon (idle state)
    let icon = load_tray_icon_idle()?;

    // Get app version from config
    let version = app.config().version.clone().unwrap_or_default();
    let app_name_label = format!("{} v{}", t!("tray.app_name"), version);

    // Build menu items
    let app_name = MenuItemBuilder::with_id(MenuItemId::AppName.id(), &app_name_label)
        .enabled(false)
        .build(app)
        .tray_err()?;

    let status = MenuItemBuilder::with_id(MenuItemId::Status.id(), get_status_text(app))
        .enabled(false)
        .build(app)
        .tray_err()?;

    let dashboard = MenuItemBuilder::with_id(MenuItemId::Dashboard.id(), t!("tray.dashboard"))
        .build(app)
        .tray_err()?;

    let launch_at_startup = CheckMenuItemBuilder::with_id(
        MenuItemId::LaunchAtStartup.id(),
        t!("tray.launch_at_startup"),
    )
    .checked(is_autostart_enabled(app))
    .build(app)
    .tray_err()?;

    let stop_all_streams =
        MenuItemBuilder::with_id(MenuItemId::StopAllStreams.id(), t!("tray.stop_all_streams"))
            .build(app)
            .tray_err()?;

    let restart_server =
        MenuItemBuilder::with_id(MenuItemId::RestartServer.id(), t!("tray.restart_server"))
            .build(app)
            .tray_err()?;

    let quit = MenuItemBuilder::with_id(MenuItemId::Quit.id(), t!("tray.quit"))
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

    // Build tray icon with platform-specific settings
    #[allow(unused_mut)] // mut needed for macOS icon_as_template
    let mut builder = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip(t!("tray.tooltip"))
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(on_tray_click);

    // On macOS, mark the icon as a template for automatic light/dark mode adaptation
    #[cfg(target_os = "macos")]
    {
        builder = builder.icon_as_template(true);
    }

    let tray_icon = builder.build(app).tray_err()?;

    // Store tray state for dynamic updates
    let tray_state = TrayState {
        status_item: status,
        tray_icon,
    };
    app.manage(tray_state);

    // Start the event listener for dynamic status updates
    start_status_listener(app.handle().clone());

    log::debug!("System tray initialized");
    Ok(())
}

/// Starts a background task that listens for stream events and updates the tray.
fn start_status_listener(app: AppHandle) {
    let Some(app_state) = app.try_state::<AppState>() else {
        log::warn!("AppState not available for tray status listener");
        return;
    };

    let mut rx = app_state.services.broadcast_tx.subscribe();
    let app_state = app_state.inner().clone();

    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(BroadcastEvent::Stream(event)) => {
                    // Update tray on stream created/ended events
                    if matches!(
                        event,
                        StreamEvent::Created { .. } | StreamEvent::Ended { .. }
                    ) {
                        let stream_count = app_state.services.stream_coordinator.stream_count();

                        if let Some(tray_state) = app.try_state::<TrayState>() {
                            tray_state.update_status(stream_count);
                            tray_state.update_icon(stream_count > 0);
                        }
                    }
                }
                Ok(_) => {
                    // Ignore other event types
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    log::debug!("Tray status listener lagged {} events", n);
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    log::debug!("Broadcast channel closed, stopping tray status listener");
                    break;
                }
            }
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Handlers
// ─────────────────────────────────────────────────────────────────────────────

/// Handles context menu item selection.
fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match MenuItemId::from_id(event.id.as_ref()) {
        Some(MenuItemId::AppName | MenuItemId::Status) => {
            // Disabled items, no action
        }
        Some(MenuItemId::Dashboard) => {
            show_main_window(app);
        }
        Some(MenuItemId::LaunchAtStartup) => {
            toggle_autostart(app);
        }
        Some(MenuItemId::StopAllStreams) => {
            stop_all_streams(app);
        }
        Some(MenuItemId::RestartServer) => {
            restart_server(app);
        }
        Some(MenuItemId::Quit) => {
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
