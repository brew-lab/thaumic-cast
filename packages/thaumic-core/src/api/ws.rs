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
use crate::events::SpeakerRemovalReason;
use crate::protocol_constants::{
    DEFAULT_STREAMING_BUFFER_MS, MAX_FRAME_DURATION_MS, MAX_STREAMING_BUFFER_MS,
    MIN_FRAME_DURATION_MS, MIN_STREAMING_BUFFER_MS, SILENCE_FRAME_DURATION_MS,
    WS_HEARTBEAT_CHECK_INTERVAL_SECS, WS_HEARTBEAT_TIMEOUT_SECS,
};
use crate::services::StreamCoordinator;
use crate::stream::{AudioCodec, AudioFormat, Passthrough, StreamMetadata, Transcoder};

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
    StopPlaybackSpeaker { payload: StopPlaybackSpeakerPayload },
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
    /// Whether to use synchronized group playback (default: false).
    /// When true, uses x-rincon protocol to sync multiple speakers.
    #[serde(default)]
    sync_speakers: bool,
    /// Whether the client has video sync enabled (gates latency monitoring).
    #[serde(default)]
    video_sync_enabled: bool,
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
    /// When true, sets volume for the entire sync group via GroupRenderingControl
    /// on the coordinator. When false (default), uses sync-aware per-speaker routing.
    #[serde(default)]
    group: bool,
}

/// Request payload for mute control via WebSocket.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsMuteRequest {
    ip: String,
    mute: bool,
    /// When true, sets mute for the entire sync group via GroupRenderingControl
    /// on the coordinator. When false (default), uses sync-aware per-speaker routing.
    #[serde(default)]
    group: bool,
}

/// Request payload for speaker queries via WebSocket.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsSpeakerRequest {
    ip: String,
}

/// Request payload for stopping playback on a single speaker.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopPlaybackSpeakerPayload {
    stream_id: String,
    ip: String,
    /// Reason for stopping (optional for backward compat).
    #[serde(default)]
    reason: Option<SpeakerRemovalReason>,
}

/// Encoder configuration from extension.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncoderConfig {
    codec: String,
    #[allow(dead_code)]
    bitrate: Option<u32>,
    sample_rate: Option<u32>,
    channels: Option<u8>,
    /// Bit depth for audio encoding (16 or 24). Only 24-bit is supported for FLAC.
    bits_per_sample: Option<u16>,
    /// Streaming buffer size in milliseconds (100-1000). Only affects PCM codec.
    streaming_buffer_ms: Option<u64>,
    /// Frame size in samples per channel.
    /// Server derives exact duration: duration_ms = samples * 1000 / sample_rate
    frame_size_samples: Option<u32>,
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
    results: Vec<crate::services::PlaybackResult>,
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
        serde_json::to_string(self)
            .ok()
            .map(|s| Message::Text(s.into()))
    }
}

/// Handshake acknowledgment payload.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HandshakePayload {
    stream_id: String,
}

/// Sends a response based on an already-resolved result.
///
/// On success, sends the provided response message. On error, sends an error message.
async fn send_result<T, E, R>(
    sender: &mut futures::stream::SplitSink<WebSocket, Message>,
    result: Result<T, E>,
    response_fn: R,
) where
    E: std::fmt::Display,
    R: FnOnce(T) -> WsOutgoing,
{
    match result {
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
    send_result(sender, fut.await, response_fn).await;
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Message Handlers
// ─────────────────────────────────────────────────────────────────────────────

/// Builds the initial state message for WebSocket clients.
///
/// Includes Sonos state (groups, transport, volume, mute), active playback sessions,
/// and current network health status.
fn build_initial_state(state: &AppState) -> Option<Message> {
    let mut payload = state.sonos_state.to_json();

    // Add sessions to the initial state
    if let serde_json::Value::Object(ref mut map) = payload {
        let sessions = state.stream_coordinator.get_all_sessions();
        let sessions_json = match serde_json::to_value(&sessions) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("[WS] Failed to serialize sessions: {}", e);
                serde_json::Value::Array(vec![])
            }
        };
        map.insert("sessions".to_string(), sessions_json);

        // Add network health to the initial state
        let health_state = state
            .discovery_service
            .topology_monitor()
            .get_network_health();
        let health_json = match serde_json::to_value(health_state.health) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("[WS] Failed to serialize networkHealth: {}", e);
                serde_json::Value::Null
            }
        };
        map.insert("networkHealth".to_string(), health_json);
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
/// For PCM, returns passthrough (WAV header added by HTTP handler for Sonos).
/// For pre-encoded formats, returns passthrough transcoder.
fn resolve_codec(codec_str: Option<&str>) -> (AudioCodec, Arc<dyn Transcoder>) {
    match codec_str {
        // PCM: passthrough, WAV header added per-connection by HTTP handler
        Some("pcm") => {
            log::info!("[WS] PCM codec selected");
            (AudioCodec::Pcm, Arc::new(Passthrough))
        }
        // Pre-encoded formats: passthrough
        Some("aac") | Some("aac-lc") | Some("he-aac") | Some("he-aac-v2") => {
            (AudioCodec::Aac, Arc::new(Passthrough))
        }
        Some("mp3") => (AudioCodec::Mp3, Arc::new(Passthrough)),
        Some("flac") => (AudioCodec::Flac, Arc::new(Passthrough)),
        Some("wav") => (AudioCodec::Pcm, Arc::new(Passthrough)), // Legacy alias
        _ => {
            log::warn!("[WS] Unknown codec {:?}, defaulting to PCM", codec_str);
            (AudioCodec::Pcm, Arc::new(Passthrough))
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

    // Extract audio format from encoder config
    let sample_rate = payload
        .encoder_config
        .as_ref()
        .and_then(|c| c.sample_rate)
        .unwrap_or(48000);
    // Extract and validate channels (1 or 2 only).
    // Multi-channel (>2) is not supported - crossfade utilities assume stereo or mono.
    let requested_channels = payload
        .encoder_config
        .as_ref()
        .and_then(|c| c.channels)
        .unwrap_or(2);

    let channels = match requested_channels {
        1 | 2 => requested_channels,
        other => {
            log::error!(
                "[WS] Invalid channels {}, must be 1 (mono) or 2 (stereo)",
                other
            );
            return HandshakeResult::Error(format!(
                "Invalid channels: {}. Must be 1 (mono) or 2 (stereo).",
                other
            ));
        }
    };

    // Extract streaming buffer with bounds validation
    let streaming_buffer_ms = payload
        .encoder_config
        .as_ref()
        .and_then(|c| c.streaming_buffer_ms)
        .unwrap_or(DEFAULT_STREAMING_BUFFER_MS)
        .clamp(MIN_STREAMING_BUFFER_MS, MAX_STREAMING_BUFFER_MS);

    // Derive frame duration from frame_size_samples.
    // Using samples avoids floating-point rounding errors in the extension.
    // Formula: duration_ms = samples * 1000 / sample_rate
    let frame_duration_ms = payload
        .encoder_config
        .as_ref()
        .and_then(|c| c.frame_size_samples)
        .map(|samples| (samples as u64 * 1000 / sample_rate as u64) as u32)
        .unwrap_or(SILENCE_FRAME_DURATION_MS)
        .clamp(MIN_FRAME_DURATION_MS, MAX_FRAME_DURATION_MS);

    // Extract and validate bit depth (16 or 24), defaulting to 16.
    // 24-bit is only supported for FLAC codec on Sonos S2 speakers.
    let requested_bits = payload
        .encoder_config
        .as_ref()
        .and_then(|c| c.bits_per_sample)
        .unwrap_or(16);

    let bits_per_sample = match requested_bits {
        24 if output_codec == AudioCodec::Flac => 24,
        24 => {
            // Valid request, but 24-bit only supported for FLAC - downgrade gracefully
            log::warn!(
                "[WS] 24-bit audio requested but codec is {:?}, falling back to 16-bit",
                output_codec
            );
            16
        }
        16 => 16,
        other => {
            // Invalid value indicates a bug in the extension - reject handshake
            log::error!("[WS] Invalid bits_per_sample {}, must be 16 or 24", other);
            return HandshakeResult::Error(format!(
                "Invalid bits_per_sample: {}. Must be 16 or 24.",
                other
            ));
        }
    };

    let audio_format = AudioFormat::new(sample_rate, channels as u16, bits_per_sample);

    log::info!(
        "[WS] Creating stream: input={:?}, output={:?}, format={:?}, buffer={}ms, frame={}ms",
        codec_str,
        output_codec,
        audio_format,
        streaming_buffer_ms,
        frame_duration_ms
    );

    match state.stream_coordinator.create_stream(
        output_codec,
        audio_format,
        transcoder,
        streaming_buffer_ms,
        frame_duration_ms,
    ) {
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
        .stream_coordinator
        .update_metadata(stream_id, metadata);
}

/// Handles binary audio data: pushes frame to stream buffer.
///
/// Returns `true` if this was the first frame (stream just became ready),
/// `false` otherwise.
fn handle_binary_data(state: &AppState, stream_id: &str, data: Bytes) -> bool {
    state
        .stream_coordinator
        .push_frame(stream_id, data)
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
    let mut broadcast_rx = state.broadcast_tx.subscribe();
    let mut last_activity = Instant::now();
    let mut latency_monitoring = false;

    // Register connection for tracking and force-close capability
    let conn_guard = state.ws_manager.register();
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

    // Use interval instead of sleep to reduce timer allocations and prevent drift.
    // Delay mode skips missed ticks rather than bursting to catch up.
    let mut heartbeat_interval =
        tokio::time::interval(Duration::from_secs(WS_HEARTBEAT_CHECK_INTERVAL_SECS));
    heartbeat_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

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
                                            Arc::clone(&state.stream_coordinator),
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
                                let sc = &state.stream_coordinator;

                                let result = if payload.group {
                                    sc.set_sync_group_volume(&*state.sonos, &ip, volume)
                                        .await
                                } else {
                                    sc.set_volume_routed(&*state.sonos, &ip, volume).await
                                };
                                send_result(&mut sender, result, |()| {
                                    WsOutgoing::VolumeState {
                                        payload: WsVolumePayload { ip, volume },
                                    }
                                })
                                .await;
                            }
                            Ok(WsIncoming::SetMute { payload }) => {
                                let ip = payload.ip.clone();
                                let mute = payload.mute;
                                let sc = &state.stream_coordinator;

                                let result = if payload.group {
                                    sc.set_sync_group_mute(&*state.sonos, &ip, mute)
                                        .await
                                } else {
                                    sc.set_mute_routed(&*state.sonos, &ip, mute).await
                                };
                                send_result(&mut sender, result, |()| {
                                    WsOutgoing::MuteState {
                                        payload: WsMutePayload { ip, mute },
                                    }
                                })
                                .await;
                            }
                            Ok(WsIncoming::GetVolume { payload }) => {
                                let ip = payload.ip.clone();
                                send_command_response(
                                    &mut sender,
                                    state
                                        .stream_coordinator
                                        .get_volume_routed(&*state.sonos, &payload.ip),
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
                                    state
                                        .stream_coordinator
                                        .get_mute_routed(&*state.sonos, &payload.ip),
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

                                // Sticky: once enabled, stays for the connection lifetime
                                if payload.video_sync_enabled {
                                    latency_monitoring = true;
                                }

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
                                            .stream_coordinator
                                            .update_metadata(&stream_id, metadata.clone());
                                    }

                                    // Start playback on all speakers (multi-group support)
                                    let artwork_url = state.artwork_metadata_url();
                                    let results = state
                                        .stream_coordinator
                                        .start_playback_multi(
                                            &speaker_ips,
                                            &stream_id,
                                            payload.metadata.as_ref(),
                                            &artwork_url,
                                            payload.sync_speakers,
                                        )
                                        .await;

                                    // Only start latency monitoring if video sync is enabled
                                    if latency_monitoring {
                                        for result in &results {
                                            if result.success {
                                                state
                                                    .latency_monitor
                                                    .start_monitoring(&stream_id, &result.speaker_ip)
                                                    .await;
                                            }
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
                            Ok(WsIncoming::StopPlaybackSpeaker { payload }) => {
                                // Stop playback; stop latency monitoring for all stopped speakers
                                // (when stopping a coordinator, this includes all its slaves)
                                let stopped_ips = state
                                    .stream_coordinator
                                    .stop_playback_speaker(
                                        &payload.stream_id,
                                        &payload.ip,
                                        payload.reason,
                                    )
                                    .await;
                                for ip in stopped_ips {
                                    state
                                        .latency_monitor
                                        .stop_speaker(&payload.stream_id, &ip)
                                        .await;
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
                                if let Some(stream) = state.stream_coordinator.get_stream(guard.id()) {
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
                    if sender.send(Message::Text(json.into())).await.is_err() {
                        break;
                    }
                }
            }
            // Heartbeat timeout check
            _ = heartbeat_interval.tick() => {
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
        state.latency_monitor.stop_stream(guard.id()).await;

        state
            .stream_coordinator
            .remove_stream_async(guard.id())
            .await;
    }

    // StreamGuard and ConnectionGuard Drop impls handle any remaining cleanup
}
