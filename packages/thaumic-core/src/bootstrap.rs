//! Application bootstrap and dependency wiring.
//!
//! This module contains the composition root - the single place where all
//! services are instantiated and wired together. This pattern provides:
//!
//! - **Clarity**: All dependency relationships are visible in one place
//! - **Testability**: Easy to swap implementations for testing
//! - **Maintainability**: Service creation logic is isolated from usage

use std::sync::Arc;
use std::time::Duration;

use reqwest::Client;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

use crate::api::WsConnectionManager;
use crate::context::{LocalIpDetector, NetworkContext};
use crate::error::{ThaumicError, ThaumicResult};
use crate::events::{BroadcastEvent, BroadcastEventBridge, EventEmitter};
use crate::protocol_constants::{EVENT_CHANNEL_CAPACITY, SOAP_TIMEOUT_SECS};
use crate::runtime::TokioSpawner;
use crate::services::{DiscoveryService, LatencyMonitor, StreamCoordinator};
use crate::sonos::{SonosClient, SonosClientImpl, SonosPlayback, SonosTopologyClient};
use crate::state::{Config, SonosState};
use crate::streaming_runtime::StreamingRuntime;

/// Container for all bootstrapped services.
///
/// This struct holds all the wired services created during bootstrap.
/// It's consumed by `AppState` to build the final application state.
#[derive(Clone)]
pub struct BootstrappedServices {
    /// Sonos client for speaker operations.
    pub sonos: Arc<dyn SonosClient>,
    /// Coordinates active audio streams.
    pub stream_coordinator: Arc<StreamCoordinator>,
    /// Manages Sonos device discovery and topology.
    pub discovery_service: Arc<DiscoveryService>,
    /// Runtime state for discovered Sonos groups.
    pub sonos_state: Arc<SonosState>,
    /// Broadcast channel sender for real-time events.
    pub broadcast_tx: broadcast::Sender<BroadcastEvent>,
    /// Event bridge for emitting events to WebSocket and optional external consumers.
    pub event_bridge: Arc<BroadcastEventBridge>,
    /// Network configuration (port, local IP).
    pub network: NetworkContext,
    /// Manages WebSocket connections.
    pub ws_manager: Arc<WsConnectionManager>,
    /// Latency monitoring service.
    pub latency_monitor: Arc<LatencyMonitor>,
    /// Dedicated high-priority runtime for HTTP streaming.
    pub streaming_runtime: Arc<StreamingRuntime>,
    /// Shared HTTP client for connection pooling.
    http_client: Client,
    /// Task spawner for background operations.
    pub spawner: TokioSpawner,
    /// Cancellation token for graceful shutdown.
    pub cancel_token: CancellationToken,
}

impl BootstrappedServices {
    /// Returns the shared HTTP client.
    pub fn http_client(&self) -> &Client {
        &self.http_client
    }

    /// Initiates graceful shutdown of all services.
    pub async fn shutdown(&self) {
        log::info!("[Bootstrap] Beginning graceful shutdown...");

        // Signal cancellation to all background tasks
        self.cancel_token.cancel();

        // Clear all streams and stop playback
        let streams_cleared = self.stream_coordinator.clear_all().await;
        log::info!("[Bootstrap] Cleared {} stream(s)", streams_cleared);

        // Unsubscribe from all GENA events
        self.discovery_service.shutdown().await;

        log::info!("[Bootstrap] Shutdown complete");
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
                "[Bootstrap] Closed {} WebSocket connection(s)",
                connections_closed
            );
        }

        // Then clear all streams and stop playback
        self.stream_coordinator.clear_all().await
    }
}

/// Creates the shared HTTP client for all Sonos communication.
///
/// Using a shared client enables connection pooling for better performance.
/// This is created once during bootstrap and injected into services that need it.
fn create_http_client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(SOAP_TIMEOUT_SECS))
        .build()
        .expect("Failed to create HTTP client")
}

/// Bootstraps all application services with their dependencies.
///
/// This is the composition root where all services are instantiated and
/// wired together. The wiring order matters - services are created in
/// dependency order:
///
/// 1. Streaming runtime (dedicated high-priority thread pool)
/// 2. Shared infrastructure (HTTP client, broadcast channel, cancellation token)
/// 3. Shared state (port, local_ip, sonos_state)
/// 4. Sonos client (depends on HTTP client)
/// 5. Stream coordinator (depends on sonos, port, local_ip)
/// 6. Latency monitor (depends on sonos, stream_manager, event_bridge)
/// 7. Discovery service (depends on sonos, stream_coordinator, sonos_state, broadcast, HTTP client)
///
/// # Arguments
/// * `config` - Application configuration
///
/// # Returns
///
/// A `BootstrappedServices` container with all services ready to use.
///
/// # Errors
///
/// Returns an error if the streaming runtime fails to start.
pub fn bootstrap_services(config: &Config) -> ThaumicResult<BootstrappedServices> {
    // Create dedicated streaming runtime first (high-priority threads)
    let streaming_runtime = Arc::new(StreamingRuntime::new().map_err(|e| {
        ThaumicError::Internal(format!("Failed to create streaming runtime: {}", e))
    })?);

    // Create task spawner from current runtime
    let spawner = TokioSpawner::current();

    // Create shared HTTP client for connection pooling
    let http_client = create_http_client();

    // Create broadcast channel for real-time events to WebSocket clients
    let (broadcast_tx, _) = broadcast::channel::<BroadcastEvent>(EVENT_CHANNEL_CAPACITY);

    // Create the event bridge that maps domain events to broadcast transport
    let event_bridge = Arc::new(BroadcastEventBridge::with_sender(broadcast_tx.clone()));

    // Create cancellation token for graceful shutdown
    let cancel_token = CancellationToken::new();

    // Create IP detector and network context (auto-detect mode for desktop app)
    let ip_detector = LocalIpDetector::arc();
    let network = NetworkContext::auto_detect(0, ip_detector)
        .map_err(|e| ThaumicError::Internal(format!("Failed to detect local IP: {}", e)))?;

    // Shared mutable state
    let sonos_state = Arc::new(SonosState::default());
    let ws_manager = Arc::new(WsConnectionManager::new());

    // Create the Sonos client (implements multiple traits)
    let sonos_impl = Arc::new(SonosClientImpl::new(http_client.clone()));

    // Validate streaming config (panics early if invalid)
    config
        .streaming
        .validate()
        .expect("Invalid streaming configuration");

    // Wire up stream coordinator with its dependencies
    let stream_coordinator = Arc::new(StreamCoordinator::new(
        Arc::clone(&sonos_impl) as Arc<dyn SonosPlayback>,
        Arc::clone(&sonos_state),
        network.clone(),
        Arc::clone(&event_bridge) as Arc<dyn EventEmitter>,
        config.streaming.clone(),
    ));

    // Wire up latency monitor with its dependencies
    let latency_monitor = Arc::new(LatencyMonitor::new(
        Arc::clone(&sonos_impl) as Arc<dyn SonosPlayback>,
        stream_coordinator.stream_manager(),
        Arc::clone(&event_bridge) as Arc<dyn EventEmitter>,
        cancel_token.clone(),
        spawner.clone(),
    ));

    // Wire up discovery service with its dependencies
    let discovery_service = Arc::new(DiscoveryService::new(
        Arc::clone(&sonos_impl) as Arc<dyn SonosTopologyClient>,
        Arc::clone(&stream_coordinator),
        Arc::clone(&sonos_state),
        Arc::clone(&event_bridge) as Arc<dyn EventEmitter>,
        network.clone(),
        http_client.clone(),
        config.topology_refresh_interval,
        spawner.clone(),
    ));

    // Coerce to the general SonosClient trait for storage
    let sonos: Arc<dyn SonosClient> = sonos_impl;

    Ok(BootstrappedServices {
        sonos,
        stream_coordinator,
        discovery_service,
        sonos_state,
        broadcast_tx,
        event_bridge,
        network,
        ws_manager,
        latency_monitor,
        streaming_runtime,
        http_client,
        spawner,
        cancel_token,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_client_has_timeout() {
        let client = create_http_client();
        // We can't directly test timeout, but verify client is created
        assert!(client.get("http://example.com").build().is_ok());
    }
}
