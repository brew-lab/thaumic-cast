//! Application lifecycle management service.
//!
//! Handles application-wide operations like shutdown, restart, and cleanup.

use std::sync::Arc;

use parking_lot::RwLock;
use tauri::{AppHandle, Manager};

use crate::api::ws_connection::WsConnectionManager;

use super::discovery_service::DiscoveryService;
use super::stream_coordinator::StreamCoordinator;

/// Manages application lifecycle operations.
///
/// This service encapsulates shutdown, restart, and cleanup logic,
/// separating lifecycle concerns from state container responsibilities.
pub struct AppLifecycle {
    app_handle: Arc<RwLock<Option<AppHandle>>>,
    stream_coordinator: Arc<StreamCoordinator>,
    discovery_service: Arc<DiscoveryService>,
    ws_manager: Arc<WsConnectionManager>,
}

impl AppLifecycle {
    /// Creates a new AppLifecycle service.
    ///
    /// # Arguments
    /// * `stream_coordinator` - Reference to the stream coordinator for stream cleanup
    /// * `discovery_service` - Reference to the discovery service for GENA cleanup
    /// * `ws_manager` - Reference to the WebSocket connection manager
    pub fn new(
        stream_coordinator: Arc<StreamCoordinator>,
        discovery_service: Arc<DiscoveryService>,
        ws_manager: Arc<WsConnectionManager>,
    ) -> Self {
        Self {
            app_handle: Arc::new(RwLock::new(None)),
            stream_coordinator,
            discovery_service,
            ws_manager,
        }
    }

    /// Sets the Tauri app handle (called during app setup).
    ///
    /// This must be called before `restart()` can work.
    pub fn set_app_handle(&self, handle: AppHandle) {
        *self.app_handle.write() = Some(handle);
    }

    /// Graceful shutdown - cleans up all streams and subscriptions.
    ///
    /// This performs a complete cleanup:
    /// 1. Stops all playback and clears all streams
    /// 2. Unsubscribes from all GENA subscriptions
    pub async fn shutdown(&self) {
        log::info!("[AppLifecycle] Beginning graceful shutdown...");

        // Clear all streams and stop playback
        let streams_cleared = self.stream_coordinator.clear_all().await;
        log::info!("[AppLifecycle] Cleared {} stream(s)", streams_cleared);

        // Unsubscribe from all GENA events
        self.discovery_service.shutdown().await;

        log::info!("[AppLifecycle] Shutdown complete");
    }

    /// Restarts the application with graceful cleanup.
    ///
    /// Performs a full shutdown before restarting to ensure clean state.
    pub async fn restart(&self) {
        log::info!("[AppLifecycle] Restart requested, performing cleanup...");

        // Perform full cleanup
        self.shutdown().await;

        // Small delay to allow cleanup to propagate
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // Trigger restart
        if let Some(handle) = self.app_handle.read().as_ref() {
            log::info!("[AppLifecycle] Restarting application...");
            tauri::process::restart(&handle.env());
        } else {
            log::error!("[AppLifecycle] Cannot restart: AppHandle not set");
        }
    }

    /// Clears all active streams and closes all WebSocket connections.
    ///
    /// Use this when you need to stop all streaming activity but keep the app running.
    /// This will disconnect any connected extension clients.
    ///
    /// # Returns
    /// The number of streams that were cleared.
    pub async fn clear_all_streams(&self) -> usize {
        // Close all WebSocket connections first (disconnects extension clients)
        let connections_closed = self.ws_manager.close_all();
        if connections_closed > 0 {
            log::info!(
                "[AppLifecycle] Closed {} WebSocket connection(s)",
                connections_closed
            );
        }

        // Then clear all streams and stop playback
        self.stream_coordinator.clear_all().await
    }
}
