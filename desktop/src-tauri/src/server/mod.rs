mod routes;

use crate::sonos::GenaListener;
use crate::stream::StreamManager;
use crate::Config;
use parking_lot::RwLock;
use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

const GENA_PORT: u16 = 3001;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<RwLock<Config>>,
    pub streams: Arc<StreamManager>,
    pub gena: Arc<tokio::sync::RwLock<Option<GenaListener>>>,
}

pub async fn start_server(state: AppState, port: u16) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Start GENA listener
    match GenaListener::new(GENA_PORT) {
        Ok(gena) => {
            if let Err(e) = gena.start().await {
                tracing::error!("[GENA] Failed to start listener: {}", e);
            } else {
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

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
        .allow_credentials(false);

    let app = routes::create_router(state).layer(cors);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("HTTP server listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
