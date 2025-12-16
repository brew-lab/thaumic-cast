mod routes;

use crate::network::{find_available_port, GENA_PORT_RANGE, HTTP_PORT_RANGE};
use crate::sonos::gena::SonosEvent;
use crate::sonos::{GenaListener, SonosState};
use crate::stream::StreamManager;
use crate::Config;
use axum::http::{header, HeaderValue, Method};
use parking_lot::RwLock;
use std::sync::Arc;
use tower_http::cors::{AllowOrigin, CorsLayer};

/// Channel sender for a WebSocket client
pub type WsEventSender = tokio::sync::mpsc::Sender<String>;

/// Manages all connected WebSocket clients for event broadcasting
pub struct WsBroadcast {
    senders: tokio::sync::Mutex<Vec<WsEventSender>>,
}

impl WsBroadcast {
    pub fn new() -> Self {
        Self {
            senders: tokio::sync::Mutex::new(Vec::new()),
        }
    }

    /// Register a new client channel for broadcasting
    pub async fn register(&self, sender: WsEventSender) {
        self.senders.lock().await.push(sender);
    }

    /// Broadcast an event to all connected clients
    /// Removes disconnected clients automatically
    pub async fn broadcast(&self, event: &SonosEvent) {
        let json = match serde_json::to_string(event) {
            Ok(j) => j,
            Err(e) => {
                log::error!("[WsBroadcast] Failed to serialize event: {}", e);
                return;
            }
        };

        let mut senders = self.senders.lock().await;
        let mut failed_indices = Vec::new();

        for (i, sender) in senders.iter().enumerate() {
            if sender.send(json.clone()).await.is_err() {
                log::debug!("[WsBroadcast] Client {} disconnected", i);
                failed_indices.push(i);
            }
        }

        // Remove failed senders in reverse order to preserve indices
        for i in failed_indices.into_iter().rev() {
            senders.swap_remove(i);
        }
    }

    /// Get the number of connected clients
    pub async fn client_count(&self) -> usize {
        self.senders.lock().await.len()
    }
}

/// Result of starting the server, containing actual bound ports
#[derive(Debug, Clone)]
pub struct ServerPorts {
    pub http_port: u16,
    pub gena_port: Option<u16>,
}

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<RwLock<Config>>,
    pub streams: Arc<StreamManager>,
    pub gena: Arc<tokio::sync::RwLock<Option<GenaListener>>>,
    /// Actual ports the server bound to (set after startup)
    pub actual_ports: Arc<RwLock<Option<ServerPorts>>>,
    /// Non-fatal errors encountered during startup
    pub startup_errors: Arc<RwLock<Vec<String>>>,
    /// Centralized Sonos state for event-driven frontend updates
    pub sonos_state: Arc<SonosState>,
    /// WebSocket broadcast for pushing events to all connected clients
    pub ws_broadcast: Arc<WsBroadcast>,
}

impl AppState {
    /// Record a non-fatal startup error for display to users
    pub fn add_startup_error(&self, error: impl ToString) {
        self.startup_errors.write().push(error.to_string());
    }
}

pub async fn start_server(
    state: AppState,
    preferred_port: Option<u16>,
    _app_handle: tauri::AppHandle,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Find an available HTTP port using shared utility
    let (http_port, listener) =
        find_available_port(HTTP_PORT_RANGE, preferred_port, [0, 0, 0, 0]).await?;

    // Start GENA listener with shared port range
    let mut gena_port = None;
    match GenaListener::new(*GENA_PORT_RANGE.start()) {
        Ok(gena) => {
            if let Err(e) = gena.start().await {
                let msg = format!("GENA listener failed to start: {}", e);
                log::error!("[GENA] {}", msg);
                state.add_startup_error(msg);
            } else {
                // Get the actual GENA port after it binds
                gena_port = Some(gena.get_port());

                // Connect GENA events to WebSocket broadcast and SonosState
                if let Some(mut event_rx) = gena.take_event_receiver() {
                    let gena_ref = state.gena.clone();
                    let sonos_state = Arc::clone(&state.sonos_state);
                    let ws_broadcast = Arc::clone(&state.ws_broadcast);
                    tokio::spawn(async move {
                        while let Some((_speaker_ip, event)) = event_rx.recv().await {
                            // Broadcast to all connected WebSocket clients
                            ws_broadcast.broadcast(&event).await;

                            // Update centralized Sonos state (which emits to frontend)
                            if matches!(
                                event,
                                SonosEvent::TransportState { .. }
                                    | SonosEvent::SourceChanged { .. }
                                    | SonosEvent::GroupVolume { .. }
                                    | SonosEvent::GroupMute { .. }
                            ) {
                                let gena_guard = gena_ref.read().await;
                                if let Some(ref gena) = *gena_guard {
                                    let statuses = gena.get_all_group_statuses();
                                    sonos_state.set_group_statuses(statuses);
                                    // Also update subscription count
                                    sonos_state
                                        .set_gena_subscriptions(gena.active_subscriptions() as u64);
                                }
                            }
                        }
                    });
                }
                *state.gena.write().await = Some(gena);
            }
        }
        Err(e) => {
            let msg = format!("GENA listener failed to initialize: {}", e);
            log::error!("[GENA] {}", msg);
            state.add_startup_error(msg);
        }
    }

    // Store actual ports in state
    *state.actual_ports.write() = Some(ServerPorts {
        http_port,
        gena_port,
    });

    // CORS restricted to configured trusted origins
    // Note: Sonos speakers fetch streams via plain HTTP (no Origin header), so CORS doesn't affect them
    let trusted_origins = state.config.read().trusted_origins.clone();
    log::info!("CORS trusted origins: {:?}", trusted_origins);

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin: &HeaderValue, _| {
            let origin_str = origin.to_str().unwrap_or("");
            // Check against configured trusted origins (includes localhost by default)
            trusted_origins
                .iter()
                .any(|allowed| origin_str.starts_with(allowed))
        }))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
        .allow_credentials(false);

    let app = routes::create_router(state).layer(cors);

    log::info!("HTTP server listening on 0.0.0.0:{}", http_port);
    if let Some(gp) = gena_port {
        log::info!("GENA listener on port {}", gp);
    }

    axum::serve(listener, app).await?;

    Ok(())
}
