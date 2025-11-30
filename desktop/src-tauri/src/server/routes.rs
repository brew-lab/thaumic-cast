use super::AppState;
use crate::network::get_local_ip;
use crate::sonos;
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use bytes::Bytes;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use tokio_stream::wrappers::BroadcastStream;
use uuid::Uuid;

pub fn create_router(state: AppState) -> Router {
    Router::new()
        // Health check
        .route("/api/health", get(health_check))
        // Local Sonos endpoints
        .route("/api/local/discover", get(discover_speakers))
        .route("/api/local/groups", get(get_groups))
        .route("/api/local/play", post(play_stream))
        .route("/api/local/stop", post(stop_stream))
        .route("/api/local/volume/{ip}", get(get_volume).post(set_volume))
        .route("/api/local/server-ip", get(get_server_ip))
        // Stream endpoints
        .route("/api/streams", post(create_stream))
        .route("/streams/{id}/live.mp3", get(stream_audio))
        // WebSocket ingest
        .route("/ws/ingest", get(ws_ingest_handler))
        .with_state(state)
}

// ============ Health Check ============

async fn health_check() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "ok",
        "service": "thaumic-cast-desktop"
    }))
}

// ============ Local Sonos Routes ============

#[derive(Deserialize)]
struct DiscoverQuery {
    refresh: Option<String>,
}

async fn discover_speakers(Query(params): Query<DiscoverQuery>) -> impl IntoResponse {
    let force_refresh = params.refresh.as_deref() == Some("true");
    match sonos::discover_speakers(force_refresh).await {
        Ok(speakers) => Json(serde_json::json!({ "speakers": speakers })).into_response(),
        Err(e) => {
            tracing::error!("Discovery error: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "discovery_failed",
                    "message": e.to_string()
                })),
            )
                .into_response()
        }
    }
}

#[derive(Deserialize)]
struct GroupsQuery {
    ip: Option<String>,
}

async fn get_groups(Query(params): Query<GroupsQuery>) -> impl IntoResponse {
    match sonos::get_zone_groups(params.ip.as_deref()).await {
        Ok(groups) => Json(serde_json::json!({ "groups": groups })).into_response(),
        Err(e) => {
            tracing::error!("Get groups error: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "groups_failed",
                    "message": e.to_string()
                })),
            )
                .into_response()
        }
    }
}

#[derive(Deserialize)]
struct PlayRequest {
    #[serde(rename = "coordinatorIp")]
    coordinator_ip: String,
    #[serde(rename = "streamUrl")]
    stream_url: String,
}

async fn play_stream(Json(body): Json<PlayRequest>) -> impl IntoResponse {
    match sonos::play_stream(&body.coordinator_ip, &body.stream_url).await {
        Ok(_) => Json(serde_json::json!({ "success": true })).into_response(),
        Err(e) => {
            tracing::error!("Play error: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "play_failed",
                    "message": e.to_string()
                })),
            )
                .into_response()
        }
    }
}

#[derive(Deserialize)]
struct StopRequest {
    #[serde(rename = "coordinatorIp")]
    coordinator_ip: String,
}

async fn stop_stream(Json(body): Json<StopRequest>) -> impl IntoResponse {
    match sonos::stop(&body.coordinator_ip).await {
        Ok(_) => Json(serde_json::json!({ "success": true })).into_response(),
        Err(e) => {
            tracing::error!("Stop error: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "stop_failed",
                    "message": e.to_string()
                })),
            )
                .into_response()
        }
    }
}

async fn get_volume(Path(ip): Path<String>) -> impl IntoResponse {
    match sonos::get_volume(&ip).await {
        Ok(volume) => Json(serde_json::json!({ "volume": volume })).into_response(),
        Err(e) => {
            tracing::error!("Get volume error: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "volume_failed",
                    "message": e.to_string()
                })),
            )
                .into_response()
        }
    }
}

#[derive(Deserialize)]
struct SetVolumeRequest {
    volume: u8,
}

async fn set_volume(Path(ip): Path<String>, Json(body): Json<SetVolumeRequest>) -> impl IntoResponse {
    match sonos::set_volume(&ip, body.volume).await {
        Ok(_) => Json(serde_json::json!({ "success": true })).into_response(),
        Err(e) => {
            tracing::error!("Set volume error: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "volume_failed",
                    "message": e.to_string()
                })),
            )
                .into_response()
        }
    }
}

async fn get_server_ip() -> impl IntoResponse {
    match get_local_ip() {
        Some(ip) => Json(serde_json::json!({ "ip": ip })).into_response(),
        None => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": "no_local_ip",
                "message": "Could not determine server local IP address"
            })),
        )
            .into_response(),
    }
}

// ============ Stream Routes ============

#[derive(Deserialize)]
struct CreateStreamRequest {
    #[serde(rename = "groupId")]
    group_id: Option<String>,
    quality: Option<String>,
    mode: Option<String>,
    #[serde(rename = "coordinatorIp")]
    coordinator_ip: Option<String>,
}

#[derive(Serialize)]
struct CreateStreamResponse {
    #[serde(rename = "streamId")]
    stream_id: String,
    #[serde(rename = "ingestUrl")]
    ingest_url: String,
    #[serde(rename = "playbackUrl")]
    playback_url: String,
}

async fn create_stream(
    State(state): State<AppState>,
    Json(body): Json<CreateStreamRequest>,
) -> impl IntoResponse {
    let stream_id = Uuid::new_v4().to_string();
    let port = state.config.read().port;

    // Log stream creation details
    tracing::info!(
        "Creating stream: id={}, group={:?}, quality={:?}, mode={:?}, coordinator={:?}",
        stream_id,
        body.group_id,
        body.quality,
        body.mode,
        body.coordinator_ip
    );

    // Pre-create the stream
    let _ = state.streams.get_or_create(&stream_id);

    // Get local IP for URLs
    let local_ip = get_local_ip().unwrap_or_else(|| "localhost".to_string());

    let response = CreateStreamResponse {
        stream_id: stream_id.clone(),
        ingest_url: format!(
            "ws://{}:{}/ws/ingest?streamId={}",
            local_ip, port, stream_id
        ),
        playback_url: format!("http://{}:{}/streams/{}/live.mp3", local_ip, port, stream_id),
    };

    (StatusCode::CREATED, Json(response))
}

#[derive(Deserialize)]
struct IngestQuery {
    #[serde(rename = "streamId")]
    stream_id: String,
    #[allow(dead_code)]
    token: Option<String>, // Ignored in desktop app (no auth)
}

async fn ws_ingest_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<IngestQuery>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ingest(socket, params.stream_id, state))
}

async fn handle_ingest(socket: WebSocket, stream_id: String, state: AppState) {
    tracing::info!("WebSocket ingest connected for stream: {}", stream_id);

    let stream = state.streams.get_or_create(&stream_id);
    let (mut _sender, mut receiver) = socket.split();

    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Binary(data)) => {
                stream.push_frame(Bytes::from(data));
            }
            Ok(Message::Close(_)) => {
                tracing::info!("WebSocket ingest closed for stream: {}", stream_id);
                break;
            }
            Err(e) => {
                tracing::error!("WebSocket error: {}", e);
                break;
            }
            _ => {}
        }
    }

    // Cleanup stream when ingest disconnects
    state.streams.remove(&stream_id);
    tracing::info!("Stream removed: {}", stream_id);
}

async fn stream_audio(
    Path(stream_id): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let stream = match state.streams.get(&stream_id) {
        Some(s) => s,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": "stream_not_found",
                    "message": "Stream not found"
                })),
            )
                .into_response();
        }
    };

    let subscription = match stream.subscribe() {
        Ok(sub) => sub,
        Err(e) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({
                    "error": "subscription_failed",
                    "message": e
                })),
            )
                .into_response();
        }
    };

    tracing::info!("New subscriber for stream: {}", stream_id);

    // Create a stream from buffered frames + broadcast receiver
    let buffered_frames = subscription.buffered_frames;
    let receiver = subscription.receiver;

    let stream_clone = stream.clone();

    let body_stream = async_stream::stream! {
        // First, yield all buffered frames
        for frame in buffered_frames {
            yield Ok::<_, Infallible>(frame);
        }

        // Then stream live frames
        let mut broadcast_stream = BroadcastStream::new(receiver);
        while let Some(result) = broadcast_stream.next().await {
            match result {
                Ok(frame) => yield Ok(frame),
                Err(_) => break, // Lagged or closed
            }
        }

        // Unsubscribe when done
        stream_clone.unsubscribe();
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "audio/mpeg")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONNECTION, "keep-alive")
        .body(Body::from_stream(body_stream))
        .unwrap()
        .into_response()
}
