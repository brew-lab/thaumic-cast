//! System tray integration.
//!
//! Provides the system tray icon with context menu for quick access to
//! common actions: showing the status window and quitting the application.

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewWindow,
};
use thiserror::Error;

/// System tray menu item identifiers.
#[derive(Debug, Clone, Copy)]
enum MenuItem {
    ShowStatus,
    Quit,
}

impl MenuItem {
    const fn id(self) -> &'static str {
        match self {
            Self::ShowStatus => "show_status",
            Self::Quit => "quit",
        }
    }

    fn from_id(id: &str) -> Option<Self> {
        match id {
            "show_status" => Some(Self::ShowStatus),
            "quit" => Some(Self::Quit),
            _ => None,
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::ShowStatus => "Show Status",
            Self::Quit => "Quit",
        }
    }
}

/// Errors during tray initialization.
#[derive(Debug, Error)]
pub enum TrayError {
    #[error("failed to build tray: {0}")]
    Build(String),

    #[error("application icon not available")]
    MissingIcon,
}

/// Initializes the system tray with menu and event handlers.
pub fn setup_tray(app: &tauri::App) -> Result<(), TrayError> {
    let icon = app.default_window_icon().ok_or(TrayError::MissingIcon)?;

    let menu = MenuBuilder::new(app)
        .item(
            &MenuItemBuilder::with_id(MenuItem::ShowStatus.id(), MenuItem::ShowStatus.label())
                .build(app)
                .map_err(|e| TrayError::Build(e.to_string()))?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id(MenuItem::Quit.id(), MenuItem::Quit.label())
                .build(app)
                .map_err(|e| TrayError::Build(e.to_string()))?,
        )
        .build()
        .map_err(|e| TrayError::Build(e.to_string()))?;

    TrayIconBuilder::new()
        .icon(icon.clone())
        .menu(&menu)
        .tooltip("Thaumic Cast")
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(on_tray_click)
        .build(app)
        .map_err(|e| TrayError::Build(e.to_string()))?;

    log::debug!("System tray initialized");
    Ok(())
}

/// Handles context menu item selection.
fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match MenuItem::from_id(event.id.as_ref()) {
        Some(MenuItem::ShowStatus) => toggle_main_window(app),
        Some(MenuItem::Quit) => {
            log::info!("Quit requested via tray");
            app.exit(0);
        }
        None => log::warn!("Unknown menu item: {}", event.id.as_ref()),
    }
}

/// Handles left-click on tray icon to toggle window visibility.
fn on_tray_click(tray: &tauri::tray::TrayIcon, event: TrayIconEvent) {
    if matches!(
        event,
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
    ) {
        toggle_main_window(tray.app_handle());
    }
}

/// Toggles the main window visibility.
fn toggle_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log::warn!("Main window not found");
        return;
    };

    if is_visible(&window) {
        let _ = window.hide();
    } else {
        focus_window(&window);
    }
}

fn is_visible(window: &WebviewWindow) -> bool {
    window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true)
}

fn focus_window(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}
