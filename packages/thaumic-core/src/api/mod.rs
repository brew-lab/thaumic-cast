//! HTTP/WebSocket API layer.
//!
//! This module contains thin handlers that delegate to services.
//! It provides the router construction and server startup functionality.

use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::RwLock;
use thiserror::Error;
use tokio::sync::broadcast;

use crate::context::NetworkContext;
use crate::events::{BroadcastEvent, BroadcastEventBridge};
use crate::mdns_advertise::MdnsAdvertiser;
use crate::services::{DiscoveryService, LatencyMonitor, StreamCoordinator};
use crate::sonos::SonosClient;
use crate::state::{Config, SonosState};

pub mod http;
pub mod response;
pub mod ws;
pub mod ws_connection;

pub use ws_connection::WsConnectionManager;

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
#[derive(Clone)]
pub struct AppState {
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
    /// Event bridge for emitting events to WebSocket and Tauri frontend.
    pub event_bridge: Arc<BroadcastEventBridge>,
    /// Network configuration (port, local IP).
    pub network: NetworkContext,
    /// Manages WebSocket connections.
    pub ws_manager: Arc<WsConnectionManager>,
    /// Latency monitoring service.
    pub latency_monitor: Arc<LatencyMonitor>,
    /// Application configuration.
    pub config: Arc<RwLock<Config>>,
    /// Whether network services have been started.
    services_started: Arc<AtomicBool>,
    /// Optional icon data for album art display.
    pub artwork: Option<&'static [u8]>,
    /// mDNS advertiser for network discovery (optional, may fail on some systems).
    /// Kept alive for its Drop impl to unregister the service on shutdown.
    /// Created after server binds to get the actual port.
    #[allow(dead_code)]
    mdns_advertiser: Arc<RwLock<Option<MdnsAdvertiser>>>,
}

/// Builder for constructing an `AppState`.
#[derive(Default)]
pub struct AppStateBuilder {
    sonos: Option<Arc<dyn SonosClient>>,
    stream_coordinator: Option<Arc<StreamCoordinator>>,
    discovery_service: Option<Arc<DiscoveryService>>,
    sonos_state: Option<Arc<SonosState>>,
    broadcast_tx: Option<broadcast::Sender<BroadcastEvent>>,
    event_bridge: Option<Arc<BroadcastEventBridge>>,
    network: Option<NetworkContext>,
    ws_manager: Option<Arc<WsConnectionManager>>,
    latency_monitor: Option<Arc<LatencyMonitor>>,
    config: Option<Arc<RwLock<Config>>>,
    artwork: Option<&'static [u8]>,
}

impl AppStateBuilder {
    /// Creates a new builder.
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the Sonos client.
    pub fn sonos(mut self, sonos: Arc<dyn SonosClient>) -> Self {
        self.sonos = Some(sonos);
        self
    }

    /// Sets the stream coordinator.
    pub fn stream_coordinator(mut self, coordinator: Arc<StreamCoordinator>) -> Self {
        self.stream_coordinator = Some(coordinator);
        self
    }

    /// Sets the discovery service.
    pub fn discovery_service(mut self, service: Arc<DiscoveryService>) -> Self {
        self.discovery_service = Some(service);
        self
    }

    /// Sets the Sonos state.
    pub fn sonos_state(mut self, state: Arc<SonosState>) -> Self {
        self.sonos_state = Some(state);
        self
    }

    /// Sets the broadcast sender.
    pub fn broadcast_tx(mut self, tx: broadcast::Sender<BroadcastEvent>) -> Self {
        self.broadcast_tx = Some(tx);
        self
    }

    /// Sets the event bridge.
    pub fn event_bridge(mut self, bridge: Arc<BroadcastEventBridge>) -> Self {
        self.event_bridge = Some(bridge);
        self
    }

    /// Sets the network context.
    pub fn network(mut self, network: NetworkContext) -> Self {
        self.network = Some(network);
        self
    }

    /// Sets the WebSocket connection manager.
    pub fn ws_manager(mut self, manager: Arc<WsConnectionManager>) -> Self {
        self.ws_manager = Some(manager);
        self
    }

    /// Sets the latency monitor.
    pub fn latency_monitor(mut self, monitor: Arc<LatencyMonitor>) -> Self {
        self.latency_monitor = Some(monitor);
        self
    }

    /// Sets the configuration.
    pub fn config(mut self, config: Arc<RwLock<Config>>) -> Self {
        self.config = Some(config);
        self
    }

    /// Sets the icon data for album art display.
    pub fn artwork(mut self, data: &'static [u8]) -> Self {
        self.artwork = Some(data);
        self
    }

    /// Builds the `AppState`, panicking if required fields are missing.
    pub fn build(self) -> AppState {
        AppState {
            sonos: self.sonos.expect("sonos is required"),
            stream_coordinator: self
                .stream_coordinator
                .expect("stream_coordinator is required"),
            discovery_service: self
                .discovery_service
                .expect("discovery_service is required"),
            sonos_state: self.sonos_state.expect("sonos_state is required"),
            broadcast_tx: self.broadcast_tx.expect("broadcast_tx is required"),
            event_bridge: self.event_bridge.expect("event_bridge is required"),
            network: self.network.expect("network is required"),
            ws_manager: self.ws_manager.expect("ws_manager is required"),
            latency_monitor: self.latency_monitor.expect("latency_monitor is required"),
            config: self.config.expect("config is required"),
            services_started: Arc::new(AtomicBool::new(false)),
            artwork: self.artwork,
            mdns_advertiser: Arc::new(RwLock::new(None)),
        }
    }
}

impl AppState {
    /// Creates a new builder for constructing an `AppState`.
    pub fn builder() -> AppStateBuilder {
        AppStateBuilder::new()
    }

    /// Marks services as started.
    ///
    /// Returns `true` if this was the first call to mark started,
    /// `false` if already started.
    pub fn mark_services_started(&self) -> bool {
        self.services_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// Returns whether services have been started.
    pub fn services_started(&self) -> bool {
        self.services_started.load(Ordering::SeqCst)
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
    state.network.set_port(port);

    // Start mDNS advertisement now that we know the actual port (best-effort, non-fatal)
    if let Ok(ip) = state.network.get_local_ip().parse::<IpAddr>() {
        match MdnsAdvertiser::new(ip, port) {
            Ok(advertiser) => {
                *state.mdns_advertiser.write() = Some(advertiser);
            }
            Err(e) => {
                log::debug!("[Server] mDNS advertisement unavailable: {}", e);
            }
        }
    }

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
