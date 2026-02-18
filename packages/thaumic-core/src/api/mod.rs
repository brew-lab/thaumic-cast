//! HTTP/WebSocket API layer.
//!
//! This module contains thin handlers that delegate to services.
//! It provides the router construction and server startup functionality.

use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::RwLock;
use thiserror::Error;

use crate::artwork::{ArtworkConfig, ArtworkSource};
use crate::context::NetworkContext;
use crate::events::BroadcastEventBridge;
use crate::mdns_advertise::MdnsAdvertiser;
use crate::services::{DiscoveryService, LatencyMonitor, StreamCoordinator};
use crate::sonos::SonosClient;
use crate::state::{Config, SonosState};

pub mod http;
pub mod response;
mod stream;
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
    /// Artwork source for Sonos album art display.
    pub artwork: ArtworkSource,
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
    event_bridge: Option<Arc<BroadcastEventBridge>>,
    network: Option<NetworkContext>,
    ws_manager: Option<Arc<WsConnectionManager>>,
    latency_monitor: Option<Arc<LatencyMonitor>>,
    config: Option<Arc<RwLock<Config>>>,
    artwork_config: Option<ArtworkConfig>,
}

impl AppStateBuilder {
    /// Creates a new builder.
    pub fn new() -> Self {
        Self::default()
    }

    /// Populates all shared service fields from a `BootstrappedServices` container.
    ///
    /// This sets the 8 fields that overlap between `BootstrappedServices` and `AppState`,
    /// leaving only app-specific fields (`config`, `artwork_config`) to be set individually.
    pub fn from_services(mut self, services: &crate::BootstrappedServices) -> Self {
        self.sonos = Some(Arc::clone(&services.sonos));
        self.stream_coordinator = Some(Arc::clone(&services.stream_coordinator));
        self.discovery_service = Some(Arc::clone(&services.discovery_service));
        self.sonos_state = Some(Arc::clone(&services.sonos_state));
        self.event_bridge = Some(Arc::clone(&services.event_bridge));
        self.network = Some(services.network.clone());
        self.ws_manager = Some(Arc::clone(&services.ws_manager));
        self.latency_monitor = Some(Arc::clone(&services.latency_monitor));
        self
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

    /// Sets the artwork configuration.
    ///
    /// The configuration will be resolved during `build()` using the precedence chain:
    /// 1. `url` (hosted) → `ArtworkSource::Url`
    /// 2. `data_dir/artwork.jpg` (local file) → `ArtworkSource::Bytes`
    /// 3. Embedded `DEFAULT_ARTWORK` → `ArtworkSource::Bytes`
    pub fn artwork_config(mut self, config: ArtworkConfig) -> Self {
        self.artwork_config = Some(config);
        self
    }

    /// Builds the `AppState`, panicking if required fields are missing.
    ///
    /// Resolves the artwork configuration using the precedence chain.
    pub fn build(self) -> AppState {
        // Resolve artwork config, defaulting to embedded artwork if not specified
        let artwork = self.artwork_config.unwrap_or_default().resolve();

        AppState {
            sonos: self.sonos.expect("sonos is required"),
            stream_coordinator: self
                .stream_coordinator
                .expect("stream_coordinator is required"),
            discovery_service: self
                .discovery_service
                .expect("discovery_service is required"),
            sonos_state: self.sonos_state.expect("sonos_state is required"),
            event_bridge: self.event_bridge.expect("event_bridge is required"),
            network: self.network.expect("network is required"),
            ws_manager: self.ws_manager.expect("ws_manager is required"),
            latency_monitor: self.latency_monitor.expect("latency_monitor is required"),
            config: self.config.expect("config is required"),
            services_started: Arc::new(AtomicBool::new(false)),
            artwork,
            mdns_advertiser: Arc::new(RwLock::new(None)),
        }
    }
}

impl AppState {
    /// Creates a new builder for constructing an `AppState`.
    pub fn builder() -> AppStateBuilder {
        AppStateBuilder::new()
    }

    /// Returns the artwork URL to use in Sonos DIDL-Lite metadata.
    ///
    /// For external URLs, returns that URL directly.
    /// For local bytes, returns the local `/artwork.jpg` endpoint URL.
    #[must_use]
    pub fn artwork_metadata_url(&self) -> String {
        let local_url = self.network.url_builder().artwork_url();
        self.artwork.metadata_url(&local_url)
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
