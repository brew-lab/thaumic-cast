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

use crate::api::ws_connection::WsConnectionManager;
use crate::config::{EVENT_CHANNEL_CAPACITY, SOAP_TIMEOUT_SECS};
use crate::context::NetworkContext;
use crate::events::{BroadcastEvent, BroadcastEventBridge, EventEmitter};
use crate::services::{AppLifecycle, DiscoveryService, LatencyMonitor, StreamCoordinator};
use crate::sonos::{SonosClient, SonosClientImpl, SonosPlayback, SonosTopologyClient};
use crate::state::{Config, SonosState};
use crate::utils::{IpDetector, LocalIpDetector};
use tokio_util::sync::CancellationToken;

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
    /// Manages application lifecycle (shutdown, restart).
    pub lifecycle: Arc<AppLifecycle>,
    /// Runtime state for discovered Sonos groups.
    pub sonos_state: Arc<SonosState>,
    /// Broadcast channel sender for real-time events.
    pub broadcast_tx: broadcast::Sender<BroadcastEvent>,
    /// Event bridge for emitting events to WebSocket and Tauri frontend.
    pub event_bridge: Arc<BroadcastEventBridge>,
    /// Network configuration (port, local IP).
    pub network: NetworkContext,
    /// Manages WebSocket connections.
    pub ws_manager: Arc<WsConnectionManager>,
    /// Latency monitoring service.
    pub latency_monitor: Arc<LatencyMonitor>,
    /// Shared HTTP client for connection pooling.
    http_client: Client,
}

impl BootstrappedServices {
    /// Returns the shared HTTP client.
    pub fn http_client(&self) -> &Client {
        &self.http_client
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
/// 1. Shared infrastructure (HTTP client, broadcast channel, cancellation token)
/// 2. Shared state (port, local_ip, sonos_state)
/// 3. Sonos client (depends on HTTP client)
/// 4. Stream coordinator (depends on sonos, port, local_ip)
/// 5. Latency monitor (depends on sonos, stream_manager, event_bridge)
/// 6. Discovery service (depends on sonos, stream_coordinator, sonos_state, broadcast, HTTP client)
///
/// # Arguments
/// * `config` - Application configuration
///
/// # Returns
///
/// A `BootstrappedServices` container with all services ready to use.
pub fn bootstrap_services(config: &Config) -> BootstrappedServices {
    // Create shared HTTP client for connection pooling
    let http_client = create_http_client();

    // Create broadcast channel for real-time events to WebSocket clients
    let (broadcast_tx, _) = broadcast::channel::<BroadcastEvent>(EVENT_CHANNEL_CAPACITY);

    // Create the event bridge that maps domain events to broadcast transport
    let event_bridge = Arc::new(BroadcastEventBridge::new(broadcast_tx.clone()));

    // Create cancellation token for graceful shutdown
    let cancel_token = CancellationToken::new();

    // Create IP detector (shared across services)
    let ip_detector = LocalIpDetector::arc();

    // Shared mutable state
    let network = NetworkContext::new(0, detect_initial_ip(&ip_detector), ip_detector);
    let sonos_state = Arc::new(SonosState::default());
    let ws_manager = Arc::new(WsConnectionManager::new());

    // Create the Sonos client (implements multiple traits)
    let sonos_impl = Arc::new(SonosClientImpl::new(http_client.clone()));

    // Wire up stream coordinator with its dependencies
    let stream_coordinator = Arc::new(StreamCoordinator::new(
        Arc::clone(&sonos_impl) as Arc<dyn SonosPlayback>,
        Arc::clone(&sonos_state),
        network.clone(),
        Arc::clone(&event_bridge) as Arc<dyn EventEmitter>,
        config.max_concurrent_streams,
        config.stream_buffer_frames,
        config.stream_channel_capacity,
    ));

    // Wire up latency monitor with its dependencies
    let latency_monitor = Arc::new(LatencyMonitor::new(
        Arc::clone(&sonos_impl) as Arc<dyn SonosPlayback>,
        stream_coordinator.stream_manager(),
        Arc::clone(&event_bridge) as Arc<dyn EventEmitter>,
        cancel_token.clone(),
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
    ));

    // Wire up lifecycle service with its dependencies
    let lifecycle = Arc::new(AppLifecycle::new(
        Arc::clone(&stream_coordinator),
        Arc::clone(&discovery_service),
        Arc::clone(&ws_manager),
    ));

    // Coerce to the general SonosClient trait for storage
    let sonos: Arc<dyn SonosClient> = sonos_impl;

    BootstrappedServices {
        sonos,
        stream_coordinator,
        discovery_service,
        lifecycle,
        sonos_state,
        broadcast_tx,
        event_bridge,
        network,
        ws_manager,
        latency_monitor,
        http_client,
    }
}

/// Detects the local IP address at startup.
///
/// Falls back to localhost if detection fails.
fn detect_initial_ip(ip_detector: &Arc<dyn IpDetector>) -> String {
    ip_detector.detect().unwrap_or_else(|e| {
        log::warn!(
            "Failed to detect local IP at startup: {}. Using fallback.",
            e
        );
        "127.0.0.1".to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_creates_all_services() {
        let config = Config::default();
        let services = bootstrap_services(&config);

        // Verify all services are created
        assert_eq!(services.network.get_port(), 0);
        assert!(!services.network.get_local_ip().is_empty());
    }
}
