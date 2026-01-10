//! Native UI components for the desktop application.
//!
//! This module handles platform-native UI elements such as the system tray,
//! notifications, and window management behaviors.

pub mod tray;

pub use tray::{setup_tray, TrayState};
