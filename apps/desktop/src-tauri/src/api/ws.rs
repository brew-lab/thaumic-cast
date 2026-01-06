//! WebSocket handler for real-time client communication.

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::response::IntoResponse;
use bytes::Bytes;
use futures::sink::SinkExt;
use futures::stream::StreamExt;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::api::AppState;
use crate::config::{WS_HEARTBEAT_CHECK_INTERVAL_SECS, WS_HEARTBEAT_TIMEOUT_SECS};
use crate::services::StreamCoordinator;
use crate::stream::{AudioCodec, Passthrough, StreamMetadata, Transcoder};

// ─────────────────────────────────────────────────────────────────────────────
// Stream Guard (RAII cleanup)
// ─────────────────────────────────────────────────────────────────────────────

/// RAII guard that ensures stream cleanup on drop.
///
/// This prevents stream leaks if the WebSocket handler panics or exits
/// unexpectedly after a stream has been created.
struct StreamGuard {
    stream_id: String,
    stream_coordinator: Arc<StreamCoordinator>,
}

impl StreamGuard {
    fn new(stream_id: String, stream_coordinator: Arc<StreamCoordinator>) -> Self {
        Self {
            stream_id,
            stream_coordinator,
        }
    }

    /// Returns a reference to the stream ID.
    fn id(&self) -> &str {
        &self.stream_id
    }
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        self.stream_coordinator.remove_stream(&self.stream_id);
        log::info!("[WS] Stream cleanup: {}", self.stream_id);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Message Types
// ─────────────────────────────────────────────────────────────────────────────

/// Incoming WebSocket message envelope.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
enum WsIncoming {
    Handshake { payload: HandshakeRequest },
    Heartbeat,
    MetadataUpdate { payload: StreamMetadata },
    SetVolume { payload: WsVolumeRequest },
    SetMute { payload: WsMuteRequest },
    GetVolume { payload: WsSpeakerRequest },
    GetMute { payload: WsSpeakerRequest },
    StartPlayback { payload: StartPlaybackRequest },
}

/// Request payload for starting playback via WebSocket.
/// Supports both single speaker (legacy) and multi-speaker (new).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartPlaybackRequest {
    /// Multiple speaker IPs (multi-group support).
    #[serde(default)]
    speaker_ips: Option<Vec<String>>,
    /// Legacy single speaker IP (backward compatibility).
    #[serde(default)]
    speaker_ip: Option<String>,
    /// Optional initial metadata to display on Sonos.
    /// If not provided, Sonos will show default "Browser Audio".
    #[serde(default)]
    metadata: Option<StreamMetadata>,
}

impl StartPlaybackRequest {
    /// Gets the speaker IPs, preferring the array field over the legacy single field.
    fn get_speaker_ips(&self) -> Vec<String> {
        if let Some(ips) = &self.speaker_ips {
            ips.clone()
        } else if let Some(ip) = &self.speaker_ip {
            vec![ip.clone()]
        } else {
            vec![]
        }
    }
}

/// Request payload for volume control via WebSocket.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsVolumeRequest {
    ip: String,
    volume: u8,
}

/// Request payload for mute control via WebSocket.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsMuteRequest {
    ip: String,
    mute: bool,
}

/// Request payload for speaker queries via WebSocket.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsSpeakerRequest {
    ip: String,
}

/// Encoder configuration from extension.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncoderConfig {
    codec: String,
    #[allow(dead_code)]
    bitrate: Option<u32>,
    #[allow(dead_code)]
    sample_rate: Option<u32>,
    #[allow(dead_code)]
    channels: Option<u8>,
}

/// Handshake request payload from client.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HandshakeRequest {
    /// Legacy codec field (deprecated).
    #[serde(default)]
    codec: Option<String>,
    /// New encoder config from extension.
    #[serde(default)]
    encoder_config: Option<EncoderConfig>,
}

/// Outgoing WebSocket messages.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
enum WsOutgoing {
    HandshakeAck {
        payload: HandshakePayload,
    },
    HeartbeatAck,
    Error {
        message: String,
    },
    InitialState {
        payload: serde_json::Value,
    },
    VolumeState {
        payload: WsVolumePayload,
    },
    MuteState {
        payload: WsMutePayload,
    },
    StreamReady {
        payload: StreamReadyPayload,
    },
    PlaybackError {
        payload: PlaybackErrorPayload,
    },
    /// Multi-group playback results (per-speaker success/failure).
    PlaybackResults {
        payload: PlaybackResultsPayload,
    },
}

/// Payload for stream ready notification.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamReadyPayload {
    buffer_size: usize,
}

/// Payload for playback error notification.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaybackErrorPayload {
    message: String,
}

/// Payload for multi-group playback results.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaybackResultsPayload {
    /// Per-speaker results (success/failure for each).
    results: Vec<crate::services::stream_coordinator::PlaybackResult>,
}

/// Payload for volume state responses.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WsVolumePayload {
    ip: String,
    volume: u8,
}

/// Payload for mute state responses.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WsMutePayload {
    ip: String,
    mute: bool,
}

impl WsOutgoing {
    /// Serializes the message to a WebSocket text message.
    fn to_message(&self) -> Option<Message> {
        serde_json::to_string(self).ok().map(Message::Text)
    }
}

/// Handshake acknowledgment payload.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HandshakePayload {
    stream_id: String,
}

/// Executes an async command and sends the appropriate response.
///
/// On success, sends the provided response message. On error, sends an error message.
async fn send_command_response<F, T, E, R>(
    sender: &mut futures::stream::SplitSink<WebSocket, Message>,
    fut: F,
    response_fn: R,
) where
    F: std::future::Future<Output = Result<T, E>>,
    E: std::fmt::Display,
    R: FnOnce(T) -> WsOutgoing,
{
    match fut.await {
        Ok(value) => {
            if let Some(msg) = response_fn(value).to_message() {
                let _ = sender.send(msg).await;
            }
        }
        Err(e) => {
            let err = WsOutgoing::Error {
                message: e.to_string(),
            };
            if let Some(msg) = err.to_message() {
                let _ = sender.send(msg).await;
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Message Handlers
// ─────────────────────────────────────────────────────────────────────────────

/// Builds the initial state message for WebSocket clients.
///
/// Includes Sonos state (groups, transport, volume, mute), active playback sessions,
/// and current network health status.
fn build_initial_state(state: &AppState) -> Option<Message> {
    let mut payload = state.services.sonos_state.to_json();

    // Add sessions to the initial state
    if let serde_json::Value::Object(ref mut map) = payload {
        let sessions = state.services.stream_coordinator.get_all_sessions();
        map.insert(
            "sessions".to_string(),
            serde_json::to_value(&sessions).unwrap_or(serde_json::Value::Array(vec![])),
        );

        // Add network health to the initial state
        let health_state = state
            .services
            .discovery_service
            .topology_monitor()
            .get_network_health();
        map.insert(
            "networkHealth".to_string(),
            serde_json::to_value(health_state.health).unwrap_or(serde_json::Value::Null),
        );
        if let Some(reason) = &health_state.reason {
            map.insert(
                "networkHealthReason".to_string(),
                serde_json::Value::String(reason.clone()),
            );
        }
    }

    WsOutgoing::InitialState { payload }.to_message()
}

/// Result of handling a handshake request.
enum HandshakeResult {
    /// Successfully created stream with this ID.
    Success(String),
    /// Failed to create stream, connection should close.
    Error(String),
}

/// Resolves input codec string to output codec and transcoder.
///
/// For PCM input, returns WAV output with passthrough (WAV header added by HTTP handler).
/// For pre-encoded formats, returns passthrough transcoder.
fn resolve_codec(codec_str: Option<&str>) -> (AudioCodec, Arc<dyn Transcoder>) {
    match codec_str {
        // PCM input: output as WAV (header added per-connection by HTTP handler)
        Some("pcm") => {
            log::info!("[WS] PCM input → WAV output");
            (AudioCodec::Wav, Arc::new(Passthrough))
        }
        // Pre-encoded formats: passthrough
        Some("aac") | Some("aac-lc") | Some("he-aac") | Some("he-aac-v2") => {
            (AudioCodec::Aac, Arc::new(Passthrough))
        }
        Some("mp3") => (AudioCodec::Mp3, Arc::new(Passthrough)),
        Some("flac") => (AudioCodec::Flac, Arc::new(Passthrough)),
        Some("wav") => (AudioCodec::Wav, Arc::new(Passthrough)),
        _ => {
            log::warn!("[WS] Unknown codec {:?}, defaulting to WAV", codec_str);
            (AudioCodec::Wav, Arc::new(Passthrough))
        }
    }
}

/// Handles a HANDSHAKE message: creates a stream and returns ack or error.
fn handle_handshake(state: &AppState, payload: HandshakeRequest) -> HandshakeResult {
    // Get codec from encoder_config (preferred) or legacy codec field
    let codec_str = payload
        .encoder_config
        .as_ref()
        .map(|c| c.codec.as_str())
        .or(payload.codec.as_deref());

    let (output_codec, transcoder) = resolve_codec(codec_str);

    log::info!(
        "[WS] Creating stream: input={:?}, output={:?}",
        codec_str,
        output_codec
    );

    match state
        .services
        .stream_coordinator
        .create_stream(output_codec, transcoder)
    {
        Ok(id) => HandshakeResult::Success(id),
        Err(e) => HandshakeResult::Error(e),
    }
}

/// Handles a METADATA_UPDATE message: updates stream metadata.
fn handle_metadata_update(state: &AppState, stream_id: &str, metadata: StreamMetadata) {
    // [DIAG] Log metadata updates from extension
    log::info!(
        "[WS] METADATA_UPDATE for stream {}: title={:?}, artist={:?}, source={:?}",
        stream_id,
        metadata.title,
        metadata.artist,
        metadata.source
    );
    state
        .services
        .stream_coordinator
        .update_metadata(stream_id, metadata);
}

/// Handles binary audio data: pushes frame to stream buffer.
///
/// Returns `true` if this was the first frame (stream just became ready),
/// `false` otherwise.
fn handle_binary_data(state: &AppState, stream_id: &str, data: Vec<u8>) -> bool {
    state
        .services
        .stream_coordinator
        .push_frame(stream_id, Bytes::from(data))
        .unwrap_or(false)
}

/// WebSocket upgrade handler.
pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

/// Main WebSocket connection handler.
async fn handle_ws(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let mut stream_guard: Option<StreamGuard> = None;
    let mut broadcast_rx = state.services.broadcast_tx.subscribe();
    let mut last_activity = Instant::now();

    // Register connection for tracking and force-close capability
    let conn_guard = state.services.ws_manager.register();
    let cancel_token = conn_guard.cancel_token().clone();

    log::info!("[WS] New connection established: {}", conn_guard.id());

    // Send initial state immediately on connect (before any handshake)
    // This allows clients to monitor speaker state without creating a stream
    if let Some(msg) = build_initial_state(&state) {
        if sender.send(msg).await.is_err() {
            log::warn!("[WS] Failed to send initial state, client disconnected");
            return;
        }
    }

    loop {
        tokio::select! {
            // Handle force-close request
            _ = cancel_token.cancelled() => {
                log::info!("[WS] Connection force-closed: {}", conn_guard.id());
                break;
            }
            // Handle incoming messages from the client
            msg = receiver.next() => {
                last_activity = Instant::now();
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        let parsed = serde_json::from_str::<WsIncoming>(&text);
                        match parsed {
                            Ok(WsIncoming::Handshake { payload }) => {
                                match handle_handshake(&state, payload) {
                                    HandshakeResult::Success(id) => {
                                        // Create guard immediately - cleanup happens on drop
                                        let guard = StreamGuard::new(
                                            id.clone(),
                                            Arc::clone(&state.services.stream_coordinator),
                                        );
                                        let ack = WsOutgoing::HandshakeAck {
                                            payload: HandshakePayload { stream_id: id },
                                        };
                                        stream_guard = Some(guard);
                                        if let Some(msg) = ack.to_message() {
                                            let _ = sender.send(msg).await;
                                        }
                                    }
                                    HandshakeResult::Error(e) => {
                                        let err = WsOutgoing::Error { message: e };
                                        if let Some(msg) = err.to_message() {
                                            let _ = sender.send(msg).await;
                                        }
                                        break;
                                    }
                                }
                            }
                            Ok(WsIncoming::Heartbeat) => {
                                if let Some(msg) = WsOutgoing::HeartbeatAck.to_message() {
                                    let _ = sender.send(msg).await;
                                }
                            }
                            Ok(WsIncoming::MetadataUpdate { payload }) => {
                                if let Some(ref guard) = stream_guard {
                                    handle_metadata_update(&state, guard.id(), payload);
                                }
                            }
                            Ok(WsIncoming::SetVolume { payload }) => {
                                let ip = payload.ip.clone();
                                let volume = payload.volume;
                                send_command_response(
                                    &mut sender,
                                    state.services.sonos.set_group_volume(&payload.ip, volume),
                                    |()| WsOutgoing::VolumeState {
                                        payload: WsVolumePayload { ip, volume },
                                    },
                                )
                                .await;
                            }
                            Ok(WsIncoming::SetMute { payload }) => {
                                let ip = payload.ip.clone();
                                let mute = payload.mute;
                                send_command_response(
                                    &mut sender,
                                    state.services.sonos.set_group_mute(&payload.ip, mute),
                                    |()| WsOutgoing::MuteState {
                                        payload: WsMutePayload { ip, mute },
                                    },
                                )
                                .await;
                            }
                            Ok(WsIncoming::GetVolume { payload }) => {
                                let ip = payload.ip.clone();
                                send_command_response(
                                    &mut sender,
                                    state.services.sonos.get_group_volume(&payload.ip),
                                    |volume| WsOutgoing::VolumeState {
                                        payload: WsVolumePayload { ip, volume },
                                    },
                                )
                                .await;
                            }
                            Ok(WsIncoming::GetMute { payload }) => {
                                let ip = payload.ip.clone();
                                send_command_response(
                                    &mut sender,
                                    state.services.sonos.get_group_mute(&payload.ip),
                                    |mute| WsOutgoing::MuteState {
                                        payload: WsMutePayload { ip, mute },
                                    },
                                )
                                .await;
                            }
                            Ok(WsIncoming::StartPlayback { payload }) => {
                                // [DIAG] Log START_PLAYBACK request with initial metadata
                                log::info!(
                                    "[WS] START_PLAYBACK: metadata={:?}",
                                    payload.metadata.as_ref().map(|m| format!(
                                        "title={:?}, artist={:?}, source={:?}",
                                        m.title, m.artist, m.source
                                    ))
                                );

                                if let Some(ref guard) = stream_guard {
                                    let stream_id = guard.id().to_string();
                                    let speaker_ips = payload.get_speaker_ips();

                                    if speaker_ips.is_empty() {
                                        let msg = WsOutgoing::PlaybackError {
                                            payload: PlaybackErrorPayload {
                                                message: "No speaker IPs provided".into(),
                                            },
                                        };
                                        if let Some(msg) = msg.to_message() {
                                            let _ = sender.send(msg).await;
                                        }
                                        continue;
                                    }

                                    // Update stream's stored metadata BEFORE starting playback
                                    // This ensures ICY metadata is available immediately,
                                    // not just when METADATA_UPDATE arrives later
                                    if let Some(ref metadata) = payload.metadata {
                                        state
                                            .services
                                            .stream_coordinator
                                            .update_metadata(&stream_id, metadata.clone());
                                    }

                                    // Start playback on all speakers (multi-group support)
                                    let results = state
                                        .services
                                        .stream_coordinator
                                        .start_playback_multi(
                                            &speaker_ips,
                                            &stream_id,
                                            payload.metadata.as_ref(),
                                        )
                                        .await;

                                    // Start latency monitoring for each successful speaker
                                    for result in &results {
                                        if result.success {
                                            state
                                                .services
                                                .latency_monitor
                                                .start_monitoring(&stream_id, &result.speaker_ip)
                                                .await;
                                        }
                                    }

                                    // Send PLAYBACK_RESULTS with per-speaker outcomes
                                    let msg = WsOutgoing::PlaybackResults {
                                        payload: PlaybackResultsPayload { results },
                                    };
                                    if let Some(msg) = msg.to_message() {
                                        let _ = sender.send(msg).await;
                                    }
                                } else {
                                    // No active stream for this connection
                                    let msg = WsOutgoing::PlaybackError {
                                        payload: PlaybackErrorPayload {
                                            message: "No active stream on this connection".into(),
                                        },
                                    };
                                    if let Some(msg) = msg.to_message() {
                                        let _ = sender.send(msg).await;
                                    }
                                }
                            }
                            Err(_) => {} // Unknown message type, ignore
                        }
                    }
                    Some(Ok(Message::Binary(data))) => {
                        if let Some(ref guard) = stream_guard {
                            let is_first_frame = handle_binary_data(&state, guard.id(), data);

                            // Send STREAM_READY on first frame
                            if is_first_frame {
                                if let Some(stream) = state.services.stream_coordinator.get_stream(guard.id()) {
                                    let msg = WsOutgoing::StreamReady {
                                        payload: StreamReadyPayload {
                                            buffer_size: stream.buffer_len(),
                                        },
                                    };
                                    if let Some(msg) = msg.to_message() {
                                        let _ = sender.send(msg).await;
                                    }
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
            // Handle broadcasted events (GENA, etc.)
            Ok(event) = broadcast_rx.recv() => {
                if let Ok(json) = serde_json::to_string(&event) {
                    if sender.send(Message::Text(json)).await.is_err() {
                        break;
                    }
                }
            }
            // Heartbeat timeout check
            _ = tokio::time::sleep(Duration::from_secs(WS_HEARTBEAT_CHECK_INTERVAL_SECS)) => {
                if last_activity.elapsed() > Duration::from_secs(WS_HEARTBEAT_TIMEOUT_SECS) {
                    log::warn!("[WS] Heartbeat timeout");
                    break;
                }
            }
        }
    }

    // Graceful cleanup: stop speakers before stream removal.
    // StreamGuard::drop() will be a no-op since remove_stream is idempotent.
    if let Some(ref guard) = stream_guard {
        // Stop latency monitoring for this stream
        state.services.latency_monitor.stop_stream(guard.id()).await;

        state
            .services
            .stream_coordinator
            .remove_stream_async(guard.id())
            .await;
    }

    // StreamGuard and ConnectionGuard Drop impls handle any remaining cleanup
}
