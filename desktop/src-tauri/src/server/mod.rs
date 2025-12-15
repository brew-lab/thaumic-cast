mod routes;

use crate::network::{find_available_port, GENA_PORT_RANGE, HTTP_PORT_RANGE};
use crate::sonos::GenaListener;
use crate::stream::StreamManager;
use crate::Config;
use parking_lot::RwLock;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

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
}

pub async fn start_server(
    state: AppState,
    preferred_port: Option<u16>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Find an available HTTP port using shared utility
    let (http_port, listener) =
        find_available_port(HTTP_PORT_RANGE, preferred_port, [0, 0, 0, 0]).await?;

    // Start GENA listener with shared port range
    let mut gena_port = None;
    match GenaListener::new(*GENA_PORT_RANGE.start()) {
        Ok(gena) => {
            if let Err(e) = gena.start().await {
                tracing::error!("[GENA] Failed to start listener: {}", e);
            } else {
                // Get the actual GENA port after it binds
                gena_port = Some(gena.get_port());

                // Connect GENA events to stream manager
                if let Some(mut event_rx) = gena.take_event_receiver() {
                    let streams = Arc::clone(&state.streams);
                    tokio::spawn(async move {
                        while let Some((speaker_ip, event)) = event_rx.recv().await {
                            tracing::info!("[GENA] Forwarding event from {} to stream", speaker_ip);
                            streams.send_event_by_ip(&speaker_ip, &event).await;
                        }
                    });
                }
                *state.gena.write().await = Some(gena);
            }
        }
        Err(e) => {
            tracing::error!("[GENA] Failed to create listener: {}", e);
        }
    }

    // Store actual ports in state
    *state.actual_ports.write() = Some(ServerPorts {
        http_port,
        gena_port,
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
        .allow_credentials(false);

    let app = routes::create_router(state).layer(cors);

    tracing::info!("HTTP server listening on 0.0.0.0:{}", http_port);
    if let Some(gp) = gena_port {
        tracing::info!("GENA listener on port {}", gp);
    }

    axum::serve(listener, app).await?;

    Ok(())
}
