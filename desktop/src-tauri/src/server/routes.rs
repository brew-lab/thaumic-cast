use super::AppState;
use crate::generated::{SonosStateSnapshot, WsAction, WsCommand, WsResponse};
use crate::network::get_local_ip;
use crate::sonos;
use crate::sonos::GenaService;
use crate::stream::{format_icy_metadata, StreamState, ICY_METAINT};
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
use futures_util::{SinkExt, StreamExt};
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
        .route("/api/local/status", get(get_group_status))
        .route("/api/local/play", post(play_stream))
        .route("/api/local/stop", post(stop_stream))
        .route("/api/local/volume/{ip}", get(get_volume).post(set_volume))
        .route("/api/local/server-ip", get(get_server_ip))
        // Stream endpoints
        .route("/api/streams", post(create_stream))
        .route("/api/streams/{id}/metadata", post(update_stream_metadata))
        .route("/streams/{id}/live.mp3", get(stream_audio))
        .route("/streams/{id}/live.aac", get(stream_audio))
        // WebSocket endpoints
        .route("/ws", get(ws_handler))
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
            log::error!("Discovery error: {}", e);
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
            log::error!("Get groups error: {}", e);
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

/// Get runtime status of all subscribed groups (transport state, current URI, etc.)
async fn get_group_status(State(state): State<AppState>) -> impl IntoResponse {
    let gena_guard = state.gena.read().await;
    let statuses = match gena_guard.as_ref() {
        Some(gena) => gena.get_all_group_statuses(),
        None => vec![],
    };
    Json(serde_json::json!({ "statuses": statuses }))
}

#[derive(Deserialize)]
struct PlayRequest {
    #[serde(rename = "coordinatorIp")]
    coordinator_ip: String,
    #[serde(rename = "streamUrl")]
    stream_url: String,
    metadata: Option<sonos::StreamMetadata>,
}

async fn play_stream(
    State(state): State<AppState>,
    Json(body): Json<PlayRequest>,
) -> impl IntoResponse {
    // Set expected stream URL for source verification via GENA events
    {
        if let Some(ref gena) = *state.gena.read().await {
            gena.set_expected_stream_url(&body.coordinator_ip, &body.stream_url);
        }
    }

    match sonos::play_stream(
        &body.coordinator_ip,
        &body.stream_url,
        body.metadata.as_ref(),
    )
    .await
    {
        Ok(_) => {
            // Subscribe to GENA events for this speaker (spawn in background)
            let gena_clone = state.gena.clone();
            let coordinator_ip = body.coordinator_ip.clone();
            tokio::spawn(async move {
                if let Some(ref gena) = *gena_clone.read().await {
                    // Subscribe to AVTransport (playback state) and GroupRenderingControl (group volume)
                    if let Err(e) = gena
                        .subscribe(&coordinator_ip, GenaService::AVTransport)
                        .await
                    {
                        log::warn!("[Routes] Failed to subscribe to AVTransport: {}", e);
                    }
                    if let Err(e) = gena
                        .subscribe(&coordinator_ip, GenaService::GroupRenderingControl)
                        .await
                    {
                        log::warn!(
                            "[Routes] Failed to subscribe to GroupRenderingControl: {}",
                            e
                        );
                    }
                }
            });

            Json(serde_json::json!({ "success": true })).into_response()
        }
        Err(e) => {
            log::error!("Play error: {}", e);
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

async fn stop_stream(
    State(_state): State<AppState>,
    Json(body): Json<StopRequest>,
) -> impl IntoResponse {
    // Note: We keep GENA subscriptions active for continuous status monitoring
    match sonos::stop(&body.coordinator_ip).await {
        Ok(_) => Json(serde_json::json!({ "success": true })).into_response(),
        Err(e) => {
            log::error!("Stop error: {}", e);
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

async fn get_volume(Path(coordinator_ip): Path<String>) -> impl IntoResponse {
    // Use group volume for consistent multi-speaker control
    match sonos::get_group_volume(&coordinator_ip).await {
        Ok(volume) => Json(serde_json::json!({ "volume": volume })).into_response(),
        Err(e) => {
            log::error!("Get group volume error: {}", e);
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

async fn set_volume(
    Path(coordinator_ip): Path<String>,
    Json(body): Json<SetVolumeRequest>,
) -> impl IntoResponse {
    // Use group volume for consistent multi-speaker control
    match sonos::set_group_volume(&coordinator_ip, body.volume).await {
        Ok(_) => Json(serde_json::json!({ "success": true })).into_response(),
        Err(e) => {
            log::error!("Set group volume error: {}", e);
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
    codec: Option<String>,
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
    let port = state
        .actual_ports
        .read()
        .as_ref()
        .map(|p| p.http_port)
        .unwrap_or(45100);

    // Log stream creation details
    log::info!(
        "Creating stream: id={}, group={:?}, quality={:?}, mode={:?}, coordinator={:?}, codec={:?}",
        stream_id,
        body.group_id,
        body.quality,
        body.mode,
        body.coordinator_ip,
        body.codec
    );

    // Determine file extension based on codec
    let format = match body.codec.as_deref() {
        Some("he-aac") | Some("aac-lc") => "aac",
        _ => "mp3",
    };

    // Pre-create the stream
    let stream = state.streams.get_or_create(&stream_id);

    // Store coordinator IP if provided (for GENA event routing)
    if let Some(ref coordinator_ip) = body.coordinator_ip {
        stream.set_speaker_ip(coordinator_ip.clone());
    }

    // Get local IP for URLs
    let local_ip = get_local_ip().unwrap_or_else(|| "localhost".to_string());

    let response = CreateStreamResponse {
        stream_id: stream_id.clone(),
        ingest_url: format!(
            "ws://{}:{}/ws/ingest?streamId={}",
            local_ip, port, stream_id
        ),
        playback_url: format!(
            "http://{}:{}/streams/{}/live.{}",
            local_ip, port, stream_id, format
        ),
    };

    (StatusCode::CREATED, Json(response))
}

#[derive(Deserialize)]
struct UpdateStreamMetadataRequest {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    artwork: Option<String>,
}

async fn update_stream_metadata(
    Path(stream_id): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<UpdateStreamMetadataRequest>,
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

    let metadata = sonos::StreamMetadata {
        title: body.title,
        artist: body.artist,
        album: body.album,
        artwork: body.artwork,
    };

    stream.set_metadata(metadata);
    log::info!("Updated metadata for stream: {}", stream_id);

    Json(serde_json::json!({ "success": true })).into_response()
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
    log::info!("WebSocket ingest connected for stream: {}", stream_id);

    let stream = state.streams.get_or_create(&stream_id);
    let (sender, mut receiver) = socket.split();

    // Store the sender for sending events back to the extension
    stream.set_ws_sender(sender).await;

    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Binary(data)) => {
                stream.push_frame(Bytes::from(data));
            }
            Ok(Message::Close(_)) => {
                log::info!("WebSocket ingest closed for stream: {}", stream_id);
                break;
            }
            Err(e) => {
                log::error!("WebSocket error: {}", e);
                break;
            }
            _ => {}
        }
    }

    // Note: We keep GENA subscriptions active for continuous status monitoring

    // Cleanup stream when ingest disconnects
    state.streams.remove(&stream_id);
    log::info!("Stream removed: {}", stream_id);
}

// ============ WebSocket Command Handler ============

/// Event sent on WebSocket connection with initial state
#[derive(Serialize)]
struct WsConnectedEvent {
    r#type: &'static str,
    state: SonosStateSnapshot,
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws_connection(socket, state))
}

async fn handle_ws_connection(socket: WebSocket, state: AppState) {
    log::info!("WebSocket control connection established");

    let (mut sender, mut receiver) = socket.split();

    // Send connected event with initial state
    let connected_event = WsConnectedEvent {
        r#type: "connected",
        state: state.sonos_state.snapshot(),
    };
    if let Ok(json) = serde_json::to_string(&connected_event) {
        if let Err(e) = sender.send(Message::Text(json.into())).await {
            log::error!("Failed to send connected event: {}", e);
            return;
        }
    }

    // Process incoming messages
    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                log::debug!("Received WS command: {}", text);
                let response = handle_ws_command(&text, &state).await;
                log::debug!("Sending WS response: {:?}", response);
                if let Ok(json) = serde_json::to_string(&response) {
                    if let Err(e) = sender.send(Message::Text(json.into())).await {
                        log::error!("Failed to send response: {}", e);
                        break;
                    }
                }
            }
            Ok(Message::Close(_)) => {
                log::info!("WebSocket control connection closed");
                break;
            }
            Err(e) => {
                log::error!("WebSocket error: {}", e);
                break;
            }
            _ => {}
        }
    }

    log::info!("WebSocket control connection ended");
}

async fn handle_ws_command(text: &str, state: &AppState) -> WsResponse {
    let command: WsCommand = match serde_json::from_str(text) {
        Ok(cmd) => cmd,
        Err(e) => {
            return WsResponse {
                id: String::new(),
                success: false,
                data: None,
                error: Some(format!("Invalid command: {}", e)),
            };
        }
    };

    let id = command.id.clone();

    match command.action {
        WsAction::GetGroups => {
            let ip = command
                .payload
                .as_ref()
                .and_then(|p| p.get("speakerIp"))
                .and_then(|v| v.as_str());

            match sonos::get_zone_groups(ip).await {
                Ok(groups) => WsResponse {
                    id,
                    success: true,
                    data: Some(serde_json::json!({ "groups": groups }).as_object().unwrap().clone()),
                    error: None,
                },
                Err(e) => WsResponse {
                    id,
                    success: false,
                    data: None,
                    error: Some(e.to_string()),
                },
            }
        }
        WsAction::GetVolume => {
            let ip = command
                .payload
                .as_ref()
                .and_then(|p| p.get("speakerIp"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            match sonos::get_group_volume(ip).await {
                Ok(volume) => WsResponse {
                    id,
                    success: true,
                    data: Some(serde_json::json!({ "volume": volume }).as_object().unwrap().clone()),
                    error: None,
                },
                Err(e) => WsResponse {
                    id,
                    success: false,
                    data: None,
                    error: Some(e.to_string()),
                },
            }
        }
        WsAction::SetVolume => {
            let ip = command
                .payload
                .as_ref()
                .and_then(|p| p.get("speakerIp"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let volume = command
                .payload
                .as_ref()
                .and_then(|p| p.get("volume"))
                .and_then(|v| v.as_u64())
                .unwrap_or(50) as u8;

            match sonos::set_group_volume(ip, volume).await {
                Ok(_) => WsResponse {
                    id,
                    success: true,
                    data: None,
                    error: None,
                },
                Err(e) => WsResponse {
                    id,
                    success: false,
                    data: None,
                    error: Some(e.to_string()),
                },
            }
        }
        WsAction::Play => {
            let coordinator_ip = command
                .payload
                .as_ref()
                .and_then(|p| p.get("coordinatorIp"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let stream_url = command
                .payload
                .as_ref()
                .and_then(|p| p.get("streamUrl"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let metadata: Option<crate::generated::StreamMetadata> = command
                .payload
                .as_ref()
                .and_then(|p| p.get("metadata"))
                .and_then(|v| serde_json::from_value(v.clone()).ok());

            match sonos::play_stream(coordinator_ip, stream_url, metadata.as_ref()).await {
                Ok(_) => WsResponse {
                    id,
                    success: true,
                    data: None,
                    error: None,
                },
                Err(e) => WsResponse {
                    id,
                    success: false,
                    data: None,
                    error: Some(e.to_string()),
                },
            }
        }
        WsAction::Stop => {
            let coordinator_ip = command
                .payload
                .as_ref()
                .and_then(|p| p.get("coordinatorIp"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            match sonos::stop(coordinator_ip).await {
                Ok(_) => WsResponse {
                    id,
                    success: true,
                    data: None,
                    error: None,
                },
                Err(e) => WsResponse {
                    id,
                    success: false,
                    data: None,
                    error: Some(e.to_string()),
                },
            }
        }
        WsAction::Discover => {
            let refresh = command
                .payload
                .as_ref()
                .and_then(|p| p.get("refresh"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            match sonos::discover_speakers(refresh).await {
                Ok(speakers) => WsResponse {
                    id,
                    success: true,
                    data: Some(serde_json::json!({ "speakers": speakers }).as_object().unwrap().clone()),
                    error: None,
                },
                Err(e) => WsResponse {
                    id,
                    success: false,
                    data: None,
                    error: Some(e.to_string()),
                },
            }
        }
        WsAction::CreateStream => {
            let _quality_str = command
                .payload
                .as_ref()
                .and_then(|p| p.get("quality"))
                .and_then(|v| v.as_str())
                .unwrap_or("medium");
            let metadata = command
                .payload
                .as_ref()
                .and_then(|p| p.get("metadata"))
                .and_then(|v| serde_json::from_value(v.clone()).ok());

            let stream_id = Uuid::new_v4().to_string();
            let _stream = state.streams.get_or_create(&stream_id);

            if let Some(meta) = metadata {
                if let Some(stream) = state.streams.get(&stream_id) {
                    stream.set_metadata(meta);
                }
            }

            let local_ip = get_local_ip().unwrap_or_else(|| "127.0.0.1".to_string());
            let actual_ports = state.actual_ports.read();
            let port = actual_ports.as_ref().map(|p| p.http_port).unwrap_or(45100);

            let ingest_url = format!("ws://{}:{}/ws/ingest?streamId={}", local_ip, port, stream_id);
            let playback_url = format!("http://{}:{}/streams/{}/live.mp3", local_ip, port, stream_id);

            WsResponse {
                id,
                success: true,
                data: Some(
                    serde_json::json!({
                        "streamId": stream_id,
                        "ingestUrl": ingest_url,
                        "playbackUrl": playback_url
                    })
                    .as_object()
                    .unwrap()
                    .clone(),
                ),
                error: None,
            }
        }
        WsAction::StopStream => {
            let stream_id = command
                .payload
                .as_ref()
                .and_then(|p| p.get("streamId"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            state.streams.remove(stream_id);

            WsResponse {
                id,
                success: true,
                data: None,
                error: None,
            }
        }
        WsAction::UpdateMetadata => {
            let stream_id = command
                .payload
                .as_ref()
                .and_then(|p| p.get("streamId"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let metadata = command
                .payload
                .as_ref()
                .and_then(|p| p.get("metadata"))
                .and_then(|v| serde_json::from_value(v.clone()).ok());

            if let Some(stream) = state.streams.get(stream_id) {
                if let Some(meta) = metadata {
                    stream.set_metadata(meta);
                }
                WsResponse {
                    id,
                    success: true,
                    data: None,
                    error: None,
                }
            } else {
                WsResponse {
                    id,
                    success: false,
                    data: None,
                    error: Some("Stream not found".to_string()),
                }
            }
        }
    }
}

async fn stream_audio(
    Path(stream_id): Path<String>,
    headers: axum::http::HeaderMap,
    uri: axum::http::Uri,
    State(state): State<AppState>,
) -> impl IntoResponse {
    // Determine format from URL extension
    let is_aac = uri.path().ends_with(".aac");
    let content_type = if is_aac { "audio/aac" } else { "audio/mpeg" };
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

    // Check if client requested ICY metadata
    let wants_icy = headers
        .get("icy-metadata")
        .and_then(|v| v.to_str().ok())
        .map(|v| v == "1")
        .unwrap_or(false);

    log::info!(
        "New subscriber for stream: {} (format: {}, icy_metadata: {})",
        stream_id,
        if is_aac { "aac" } else { "mp3" },
        wants_icy
    );

    let buffered_frames = subscription.buffered_frames;
    let receiver = subscription.receiver;
    let stream_clone = stream.clone();

    // Capture values outside macro for proper dead code analysis
    let icy_interval = ICY_METAINT;

    let body_stream = async_stream::stream! {
        let mut bytes_since_meta: usize = 0;

        // First, yield all buffered frames
        for frame in buffered_frames {
            for chunk in process_icy_chunk(frame, &stream_clone, wants_icy, &mut bytes_since_meta, icy_interval) {
                yield Ok::<_, Infallible>(chunk);
            }
        }

        // Then stream live frames
        let mut broadcast_stream = BroadcastStream::new(receiver);
        while let Some(result) = broadcast_stream.next().await {
            match result {
                Ok(frame) => {
                    for chunk in process_icy_chunk(frame, &stream_clone, wants_icy, &mut bytes_since_meta, icy_interval) {
                        yield Ok(chunk);
                    }
                }
                Err(_) => break,
            }
        }

        stream_clone.unsubscribe();
    };

    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONNECTION, "keep-alive");

    // Add ICY headers if client requested metadata
    if wants_icy {
        response = response
            .header("icy-metaint", ICY_METAINT.to_string())
            .header("icy-name", "Thaumic Cast");
    }

    response
        .body(Body::from_stream(body_stream))
        .unwrap()
        .into_response()
}

/// Process a chunk with ICY metadata injection
fn process_icy_chunk(
    chunk: Bytes,
    stream: &std::sync::Arc<StreamState>,
    wants_icy: bool,
    bytes_since_meta: &mut usize,
    icy_interval: usize,
) -> Vec<Bytes> {
    if !wants_icy {
        return vec![chunk];
    }

    let mut result = Vec::new();
    let mut remaining = chunk.as_ref();

    while !remaining.is_empty() {
        let bytes_until_meta = icy_interval - *bytes_since_meta;

        if remaining.len() < bytes_until_meta {
            result.push(Bytes::copy_from_slice(remaining));
            *bytes_since_meta += remaining.len();
            break;
        } else {
            // Output audio up to metadata point
            result.push(Bytes::copy_from_slice(&remaining[..bytes_until_meta]));

            // Inject metadata
            let metadata = stream.get_metadata();
            let meta_block = format_icy_metadata(metadata.as_ref());
            result.push(Bytes::from(meta_block));

            remaining = &remaining[bytes_until_meta..];
            *bytes_since_meta = 0;
        }
    }

    result
}
