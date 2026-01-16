//! System tray integration.
//!
//! Provides the system tray icon with context menu for quick access to
//! common actions: viewing status, toggling autostart, and controlling streams.
//!
//! The tray menu status line updates dynamically when streams are created or ended.
//! On macOS, the tray icon uses template images that adapt to light/dark mode.

use std::future::Future;
#[cfg(target_os = "windows")]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use rust_i18n::t;
use tauri::{
    image::Image,
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewWindow,
};
use tauri_plugin_autostart::ManagerExt;
use thiserror::Error;

use thaumic_core::{BroadcastEvent, StreamEvent};

use crate::api::AppState;

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
    /// Current streaming state (for Windows icon selection).
    #[cfg(target_os = "windows")]
    is_streaming: Arc<AtomicBool>,
    /// Current theme - true if dark (for Windows icon selection).
    #[cfg(target_os = "windows")]
    is_dark_theme: Arc<AtomicBool>,
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
    /// On Windows, also considers current theme for icon selection.
    fn update_icon(&self, is_streaming: bool) {
        #[cfg(target_os = "windows")]
        {
            self.is_streaming.store(is_streaming, Ordering::Relaxed);
            let is_dark = self.is_dark_theme.load(Ordering::Relaxed);
            let theme = if is_dark {
                tauri::Theme::Dark
            } else {
                tauri::Theme::Light
            };
            self.set_icon_or_warn(load_tray_icon_for_state(theme, is_streaming));
        }

        #[cfg(not(target_os = "windows"))]
        {
            let icon = if is_streaming {
                load_tray_icon_active()
            } else {
                load_tray_icon_idle()
            };
            self.set_icon_or_warn(icon);
        }
    }

    /// Updates the tray icon when system theme changes (Windows only).
    #[cfg(target_os = "windows")]
    pub fn update_for_theme(&self, theme: tauri::Theme) {
        self.is_dark_theme
            .store(matches!(theme, tauri::Theme::Dark), Ordering::Relaxed);
        let is_streaming = self.is_streaming.load(Ordering::Relaxed);
        self.set_icon_or_warn(load_tray_icon_for_state(theme, is_streaming));
    }

    /// Updates the tray icon when system theme changes (no-op on non-Windows).
    #[cfg(not(target_os = "windows"))]
    pub fn update_for_theme(&self, _theme: tauri::Theme) {
        // No-op: macOS uses template icons, Linux has no theme detection
    }

    /// Sets the tray icon, logging warnings on failure.
    fn set_icon_or_warn(&self, icon: Result<Image<'static>, TrayError>) {
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
/// Used on macOS (template) and Linux.
#[cfg(not(target_os = "windows"))]
const TRAY_ICON_ACTIVE: &[u8] = include_bytes!("../../icons/tray/tray-template.png");
/// Icon bytes for idle state (embedded at compile time).
/// Used on macOS and Linux.
#[cfg(not(target_os = "windows"))]
const TRAY_ICON_IDLE: &[u8] = include_bytes!("../../icons/tray/tray-idle.png");

// Windows icons: 4-state matrix (theme × streaming state)
#[cfg(target_os = "windows")]
const TRAY_ICON_LIGHT_IDLE: &[u8] = include_bytes!("../../icons/tray/tray-light-idle.png");
#[cfg(target_os = "windows")]
const TRAY_ICON_LIGHT_ACTIVE: &[u8] = include_bytes!("../../icons/tray/tray-light-active.png");
#[cfg(target_os = "windows")]
const TRAY_ICON_DARK_IDLE: &[u8] = include_bytes!("../../icons/tray/tray-dark-idle.png");
#[cfg(target_os = "windows")]
const TRAY_ICON_DARK_ACTIVE: &[u8] = include_bytes!("../../icons/tray/tray-dark-active.png");

/// Loads the active tray icon (macOS/Linux).
#[cfg(not(target_os = "windows"))]
fn load_tray_icon_active() -> Result<Image<'static>, TrayError> {
    Image::from_bytes(TRAY_ICON_ACTIVE).map_err(|e| TrayError::Build(e.to_string()))
}

/// Loads the idle tray icon (macOS/Linux).
#[cfg(not(target_os = "windows"))]
fn load_tray_icon_idle() -> Result<Image<'static>, TrayError> {
    Image::from_bytes(TRAY_ICON_IDLE).map_err(|e| TrayError::Build(e.to_string()))
}

/// Detects the current system theme from the main window (Windows).
#[cfg(target_os = "windows")]
fn detect_system_theme(app: &tauri::App) -> tauri::Theme {
    app.get_webview_window("main")
        .and_then(|w| w.theme().ok())
        .unwrap_or(tauri::Theme::Light)
}

/// Loads the appropriate tray icon based on theme and streaming state (Windows).
#[cfg(target_os = "windows")]
fn load_tray_icon_for_state(
    theme: tauri::Theme,
    is_streaming: bool,
) -> Result<Image<'static>, TrayError> {
    let bytes = match (theme, is_streaming) {
        (tauri::Theme::Light, false) => TRAY_ICON_LIGHT_IDLE,
        (tauri::Theme::Light, true) => TRAY_ICON_LIGHT_ACTIVE,
        (tauri::Theme::Dark, false) => TRAY_ICON_DARK_IDLE,
        (tauri::Theme::Dark, true) => TRAY_ICON_DARK_ACTIVE,
        // tauri::Theme is non_exhaustive, but currently only has Light/Dark
        _ => TRAY_ICON_LIGHT_IDLE,
    };
    Image::from_bytes(bytes).map_err(|e| TrayError::Build(e.to_string()))
}

/// Loads the initial tray icon (Windows - uses theme detection).
#[cfg(target_os = "windows")]
fn load_initial_tray_icon(app: &tauri::App) -> Result<Image<'static>, TrayError> {
    load_tray_icon_for_state(detect_system_theme(app), false)
}

/// Loads the initial tray icon (macOS/Linux - idle state).
#[cfg(not(target_os = "windows"))]
fn load_initial_tray_icon(_app: &tauri::App) -> Result<Image<'static>, TrayError> {
    load_tray_icon_idle()
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
    // Load initial icon (theme-aware on Windows, idle on other platforms)
    let icon = load_initial_tray_icon(app)?;

    // Detect initial theme for Windows state tracking
    #[cfg(target_os = "windows")]
    let initial_is_dark = matches!(detect_system_theme(app), tauri::Theme::Dark);

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
        #[cfg(target_os = "windows")]
        is_streaming: Arc::new(AtomicBool::new(false)),
        #[cfg(target_os = "windows")]
        is_dark_theme: Arc::new(AtomicBool::new(initial_is_dark)),
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

/// Shows and focuses the window from the system tray.
/// On macOS, also shows the dock icon.
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
