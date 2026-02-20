//! HTTP/WebSocket API layer.
//!
//! This module contains thin handlers that delegate to services.
//! It provides the router construction and server startup functionality.

use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::RwLock;
use thiserror::Error;

use axum::serve::ListenerExt;

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

impl AppState {
    /// Creates a new `AppState` from bootstrapped services, config, and artwork settings.
    ///
    /// Resolves the artwork configuration using the precedence chain:
    /// 1. `url` (hosted) → `ArtworkSource::Url`
    /// 2. `data_dir/artwork.jpg` (local file) → `ArtworkSource::Bytes`
    /// 3. Embedded `DEFAULT_ARTWORK` → `ArtworkSource::Bytes`
    pub fn new(
        services: &crate::BootstrappedServices,
        config: Arc<RwLock<Config>>,
        artwork_config: ArtworkConfig,
    ) -> Self {
        Self {
            sonos: Arc::clone(&services.sonos),
            stream_coordinator: Arc::clone(&services.stream_coordinator),
            discovery_service: Arc::clone(&services.discovery_service),
            sonos_state: Arc::clone(&services.sonos_state),
            event_bridge: Arc::clone(&services.event_bridge),
            network: services.network.clone(),
            ws_manager: Arc::clone(&services.ws_manager),
            latency_monitor: Arc::clone(&services.latency_monitor),
            config,
            services_started: Arc::new(AtomicBool::new(false)),
            artwork: artwork_config.resolve(),
            mdns_advertiser: Arc::new(RwLock::new(None)),
        }
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

    // TCP_NODELAY: Disable Nagle's algorithm on every accepted connection.
    // Without this, TCP buffers small writes (1920-byte PCM frames) and sends them
    // in batches, causing uneven delivery timing to Sonos speakers.
    //
    // TCP keepalive: Detect dead connections within ~25s (10s idle + 3 × 5s probes)
    // instead of the default ~2 hours. Critical for streaming connections where a
    // stalled Sonos speaker would otherwise hold the async task alive indefinitely.
    let listener = listener.tap_io(|tcp_stream| {
        if let Err(err) = tcp_stream.set_nodelay(true) {
            log::warn!("Failed to set TCP_NODELAY on incoming connection: {err:#}");
        }

        let sock_ref = socket2::SockRef::from(&*tcp_stream);
        let keepalive = socket2::TcpKeepalive::new()
            .with_time(Duration::from_secs(10))
            .with_interval(Duration::from_secs(5));
        #[cfg(target_os = "linux")]
        let keepalive = keepalive.with_retries(3);
        if let Err(err) = sock_ref.set_tcp_keepalive(&keepalive) {
            log::warn!("Failed to set TCP keepalive: {err:#}");
        }
    });

    // Use into_make_service_with_connect_info to enable ConnectInfo<SocketAddr> extraction
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;
    Ok(())
}
