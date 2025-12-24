//! HTTP/WebSocket API layer.
//!
//! This module contains thin handlers that delegate to services.

use std::sync::Arc;

use parking_lot::RwLock;
use tauri::AppHandle;
use thiserror::Error;

use crate::bootstrap::{bootstrap_services, BootstrappedServices};
use crate::state::Config;

pub mod commands;
pub mod http;
pub mod response;
pub mod ws;
pub mod ws_connection;

/// Errors that can occur when starting or running the server.
#[derive(Debug, Error)]
pub enum ServerError {
    /// Failed to bind to a TCP port.
    #[error("Failed to bind to port: {0}")]
    Bind(#[from] std::io::Error),

    /// No available ports in the specified range.
    #[error("No available ports in range {start}-{end}")]
    NoAvailablePort { start: u16, end: u16 },
}

/// Shared application state for the API layer.
///
/// This is a thin wrapper that holds references to services.
/// All business logic lives in the services themselves.
/// Lifecycle operations are delegated to `AppLifecycle`.
#[derive(Clone)]
pub struct AppState {
    /// All bootstrapped services (sonos client, coordinators, discovery, lifecycle, etc.).
    pub services: BootstrappedServices,
    /// Application configuration.
    pub config: Arc<RwLock<Config>>,
}

impl AppState {
    /// Creates a new AppState with initialized services.
    ///
    /// Delegates to `bootstrap_services()` for dependency wiring.
    pub fn new() -> Self {
        let config = Config::default();
        let services = bootstrap_services(&config);

        Self {
            services,
            config: Arc::new(RwLock::new(config)),
        }
    }

    /// Sets the Tauri app handle (called during app setup).
    pub fn set_app_handle(&self, handle: AppHandle) {
        self.services.lifecycle.set_app_handle(handle);
    }

    /// Starts all background services.
    pub fn start_background_tasks(self: &Arc<Self>) {
        self.services.discovery_service.start_renewal_task();
        Arc::clone(&self.services.discovery_service).start_topology_monitor();
    }

    /// Graceful shutdown - cleans up all streams and subscriptions.
    ///
    /// This performs a complete cleanup:
    /// 1. Stops all playback and clears all streams
    /// 2. Unsubscribes from all GENA subscriptions
    pub async fn shutdown(&self) {
        self.services.lifecycle.shutdown().await;
    }

    /// Restarts the application with graceful cleanup.
    ///
    /// Performs a full shutdown before restarting to ensure clean state.
    pub async fn restart(&self) {
        self.services.lifecycle.restart().await;
    }

    /// Clears all active streams without restarting.
    ///
    /// Use this when you need to stop all streaming activity but keep the app running.
    pub async fn clear_all_streams(&self) -> usize {
        self.services.lifecycle.clear_all_streams().await
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

async fn find_available_port(
    start: u16,
    end: u16,
) -> Result<(u16, tokio::net::TcpListener), ServerError> {
    for port in start..=end {
        let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
        match tokio::net::TcpListener::bind(&addr).await {
            Ok(listener) => return Ok((port, listener)),
            Err(_) => continue,
        }
    }
    Err(ServerError::NoAvailablePort { start, end })
}

/// Starts the HTTP server on the configured or auto-discovered port.
pub async fn start_server(state: AppState) -> Result<(), ServerError> {
    let preferred_port = state.config.read().preferred_port;
    let (port, listener) = if preferred_port > 0 {
        let addr = std::net::SocketAddr::from(([0, 0, 0, 0], preferred_port));
        (preferred_port, tokio::net::TcpListener::bind(&addr).await?)
    } else {
        find_available_port(49400, 49410).await?
    };

    // Set port and signal waiters
    state.services.network.set_port(port);

    log::info!("Server listening on http://0.0.0.0:{}", port);
    let app = http::create_router(state);
    axum::serve(listener, app).await?;
    Ok(())
}
