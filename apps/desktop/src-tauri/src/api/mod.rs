//! HTTP/WebSocket API layer for the desktop app.
//!
//! This module provides the desktop-specific state wrapper and delegates
//! HTTP handling to thaumic-core.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::RwLock;
use tauri::{AppHandle, Manager};
use thaumic_core::{
    bootstrap_services, AppState as CoreAppState, AppStateBuilder, BootstrappedServices, Config,
};

use crate::tauri_emitter::TauriEventEmitter;

pub mod commands;

/// Application icon data embedded at compile time.
static ICON_DATA: &[u8] = include_bytes!("../../icons/icon.png");

/// Desktop-specific application state.
///
/// Wraps thaumic-core's services and adds Tauri-specific functionality:
/// - TauriEventEmitter for frontend events
/// - AppHandle for restart and app data directory
/// - Lifecycle operations (shutdown, restart)
#[derive(Clone)]
pub struct AppState {
    /// All bootstrapped services from thaumic-core.
    pub services: BootstrappedServices,
    /// Application configuration.
    pub config: Arc<RwLock<Config>>,
    /// Tauri event emitter for frontend notifications.
    pub tauri_emitter: Arc<TauriEventEmitter>,
    /// Tauri app handle for restart functionality.
    app_handle: Arc<RwLock<Option<AppHandle>>>,
    /// Whether network services have been started.
    services_started: Arc<AtomicBool>,
}

impl AppState {
    /// Creates a new AppState with initialized services.
    ///
    /// Delegates to `thaumic_core::bootstrap_services()` for dependency wiring.
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

        // Create Tauri event emitter and set it on the bridge
        let tauri_emitter = Arc::new(TauriEventEmitter::new());
        services
            .event_bridge
            .set_external_emitter(Arc::clone(&tauri_emitter) as Arc<dyn thaumic_core::EventEmitter>);

        Self {
            services,
            config: Arc::new(RwLock::new(config)),
            tauri_emitter,
            app_handle: Arc::new(RwLock::new(None)),
            services_started: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Sets the Tauri app handle (called during app setup).
    ///
    /// This propagates the handle to services that need it for:
    /// - Application restart functionality
    /// - Emitting frontend events
    /// - Loading manual speaker configuration
    pub fn set_app_handle(&self, handle: AppHandle) {
        *self.app_handle.write() = Some(handle.clone());

        // Set app handle on TauriEventEmitter for frontend events
        self.tauri_emitter.set_app_handle(handle.clone());

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

        // Build the core AppState for the HTTP server
        let core_state = self.build_core_app_state();

        // Spawn HTTP server on the DEDICATED STREAMING RUNTIME
        // This runs on high-priority threads to maintain consistent audio cadence
        // even when the main Tauri runtime is starved (e.g., during UI freezes)
        self.services.streaming_runtime.spawn(async move {
            if let Err(e) = thaumic_core::start_server(core_state).await {
                log::error!("Server error: {}", e);
            }
        });
    }

    /// Builds the core AppState for the HTTP server.
    fn build_core_app_state(&self) -> CoreAppState {
        AppStateBuilder::new()
            .sonos(Arc::clone(&self.services.sonos))
            .stream_coordinator(Arc::clone(&self.services.stream_coordinator))
            .discovery_service(Arc::clone(&self.services.discovery_service))
            .sonos_state(Arc::clone(&self.services.sonos_state))
            .broadcast_tx(self.services.broadcast_tx.clone())
            .event_bridge(Arc::clone(&self.services.event_bridge))
            .network(self.services.network.clone())
            .ws_manager(Arc::clone(&self.services.ws_manager))
            .latency_monitor(Arc::clone(&self.services.latency_monitor))
            .config(Arc::clone(&self.config))
            .icon_data(ICON_DATA)
            .build()
    }

    /// Graceful shutdown - cleans up all streams and subscriptions.
    pub async fn shutdown(&self) {
        self.services.shutdown().await;
    }

    /// Restarts the application with graceful cleanup.
    ///
    /// Performs a full shutdown before restarting to ensure clean state.
    pub async fn restart(&self) {
        log::info!("[AppState] Restart requested, performing cleanup...");

        // Perform full cleanup
        self.shutdown().await;

        // Small delay to allow cleanup to propagate
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // Trigger restart
        if let Some(handle) = self.app_handle.read().as_ref() {
            log::info!("[AppState] Restarting application...");
            tauri::process::restart(&handle.env());
        } else {
            log::error!("[AppState] Cannot restart: AppHandle not set");
        }
    }

    /// Clears all active streams without restarting.
    ///
    /// Use this when you need to stop all streaming activity but keep the app running.
    pub async fn clear_all_streams(&self) -> usize {
        self.services.clear_all_streams().await
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
