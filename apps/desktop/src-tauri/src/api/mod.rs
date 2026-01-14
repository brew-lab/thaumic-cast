//! HTTP/WebSocket API layer.
//!
//! This module contains thin handlers that delegate to services.

use std::sync::atomic::{AtomicBool, Ordering};
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
    /// Whether network services have been started.
    services_started: Arc<AtomicBool>,
}

impl AppState {
    /// Creates a new AppState with initialized services.
    ///
    /// Delegates to `bootstrap_services()` for dependency wiring.
    /// Note: Services are not started automatically. Call `start_services()`
    /// after the user acknowledges the firewall warning or skips onboarding.
    ///
    /// # Panics
    ///
    /// Panics if the streaming runtime fails to initialize. This is intentional
    /// as the application cannot function without the streaming runtime.
    pub fn new() -> Self {
        let config = Config::default();
        let services = bootstrap_services(&config)
            .expect("Failed to bootstrap services - streaming runtime initialization failed");

        Self {
            services,
            config: Arc::new(RwLock::new(config)),
            services_started: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Sets the Tauri app handle (called during app setup).
    ///
    /// This propagates the handle to services that need it for:
    /// - Application restart functionality (AppLifecycle)
    /// - Emitting frontend events (BroadcastEventBridge)
    /// - Loading manual speaker configuration (DiscoveryService)
    pub fn set_app_handle(&self, handle: AppHandle) {
        use tauri::Manager;

        self.services.lifecycle.set_app_handle(handle.clone());
        self.services.event_bridge.set_app_handle(handle.clone());

        // Set app data dir for manual speaker configuration
        match handle.path().app_data_dir() {
            Ok(path) => self.services.discovery_service.set_app_data_dir(path),
            Err(e) => log::warn!(
                "Failed to get app data dir, manual speakers will not persist: {}",
                e
            ),
        }
    }

    /// Starts all background services (GENA renewal, topology monitor, latency monitor).
    ///
    /// This is called internally by `start_services()`. Prefer using `start_services()`
    /// which also starts the HTTP server and is idempotent.
    fn start_background_tasks(&self) {
        self.services.discovery_service.start_renewal_task();
        Arc::clone(&self.services.discovery_service).start_topology_monitor();
        self.services.latency_monitor.start();
    }

    /// Starts network services (HTTP server and background tasks).
    ///
    /// This is idempotent - calling multiple times has no effect after the first call.
    /// Should be called after the user acknowledges the firewall warning or skips onboarding,
    /// or immediately on startup if onboarding was already completed.
    ///
    /// The HTTP server runs on a dedicated high-priority streaming runtime to ensure
    /// consistent audio delivery even during UI freezes or CPU contention.
    ///
    /// This method spawns the HTTP server in a background task and returns immediately.
    pub fn start_services(&self) {
        // Only start once - use compare_exchange for thread safety
        if self
            .services_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            log::debug!("Network services already started, skipping");
            return;
        }

        log::info!("Starting network services...");

        // Start background tasks (GENA renewal, topology monitor) on Tauri's runtime
        self.start_background_tasks();

        // Spawn HTTP server on Tauri's runtime.
        // The server handles WebSocket, GENA callbacks, and other non-latency-critical traffic.
        // Only the WAV cadence loop is spawned on the streaming runtime (via handle passed
        // to create_wav_stream_with_cadence) to isolate timing-critical work.
        let state_clone = self.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = start_server(state_clone).await {
                log::error!("Server error: {}", e);
            }
        });
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

    // Use into_make_service_with_connect_info to enable ConnectInfo<SocketAddr> extraction
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;
    Ok(())
}
