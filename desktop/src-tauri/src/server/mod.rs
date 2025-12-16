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

/// Unique ID for a WebSocket client connection
pub type WsClientId = u64;

/// Manages all connected WebSocket clients for event broadcasting
pub struct WsBroadcast {
    clients: tokio::sync::Mutex<std::collections::HashMap<WsClientId, WsEventSender>>,
    next_id: std::sync::atomic::AtomicU64,
    app_handle: std::sync::RwLock<Option<tauri::AppHandle>>,
}

impl WsBroadcast {
    pub fn new() -> Self {
        Self {
            clients: tokio::sync::Mutex::new(std::collections::HashMap::new()),
            next_id: std::sync::atomic::AtomicU64::new(1),
            app_handle: std::sync::RwLock::new(None),
        }
    }

    /// Set the app handle for emitting Tauri events
    pub fn set_app_handle(&self, handle: tauri::AppHandle) {
        *self.app_handle.write().unwrap() = Some(handle);
    }

    /// Emit clients-changed event to Tauri frontend
    fn emit_clients_changed(&self, count: usize) {
        if let Some(ref handle) = *self.app_handle.read().unwrap() {
            use tauri::Emitter;
            if let Err(e) = handle.emit("clients-changed", count as u64) {
                log::warn!("[WsBroadcast] Failed to emit clients-changed: {}", e);
            }
        }
    }

    /// Register a new client channel for broadcasting
    /// Returns a unique client ID for later unregistration
    pub async fn register(&self, sender: WsEventSender) -> WsClientId {
        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let count = {
            let mut clients = self.clients.lock().await;
            clients.insert(id, sender);
            clients.len()
        };
        self.emit_clients_changed(count);
        log::debug!("[WsBroadcast] Client {} registered, {} total", id, count);
        id
    }

    /// Unregister a client by ID (called when connection closes)
    pub async fn unregister(&self, client_id: WsClientId) {
        let count = {
            let mut clients = self.clients.lock().await;
            clients.remove(&client_id);
            clients.len()
        };
        self.emit_clients_changed(count);
        log::debug!(
            "[WsBroadcast] Client {} unregistered, {} remaining",
            client_id,
            count
        );
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

        let mut clients = self.clients.lock().await;
        let mut failed_ids = Vec::new();

        for (&id, sender) in clients.iter() {
            if sender.send(json.clone()).await.is_err() {
                log::debug!("[WsBroadcast] Client {} disconnected during broadcast", id);
                failed_ids.push(id);
            }
        }

        // Remove failed clients
        let had_failures = !failed_ids.is_empty();
        for id in failed_ids {
            clients.remove(&id);
        }

        // Emit event if any clients were removed
        if had_failures {
            let count = clients.len();
            drop(clients); // Release lock before emitting
            self.emit_clients_changed(count);
        }
    }

    /// Get the number of connected clients
    pub async fn client_count(&self) -> usize {
        self.clients.lock().await.len()
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
