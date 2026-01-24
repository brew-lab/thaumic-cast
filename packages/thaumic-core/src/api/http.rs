//! HTTP route handlers.
//!
//! All handlers are thin - they delegate to services for business logic.

use std::collections::VecDeque;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_stream::stream;
use axum::{
    body::Body,
    extract::{connect_info::ConnectInfo, Path, State},
    http::{header, HeaderMap, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Json, Router,
};
use bytes::Bytes;
use futures::stream::{Stream, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::broadcast;
use tokio::time::{interval, Instant as TokioInstant, MissedTickBehavior};
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use tokio_stream::wrappers::BroadcastStream;

use crate::api::response::{api_error, api_ok, api_success};
use crate::api::ws::ws_handler;
use crate::api::AppState;
use crate::error::{ErrorCode, ThaumicError, ThaumicResult};
use crate::protocol_constants::{
    APP_NAME, ICY_METAINT, MAX_CADENCE_QUEUE_SIZE, MAX_GENA_BODY_SIZE, SERVICE_ID,
    WAV_STREAM_SIZE_MAX,
};
use crate::sonos::discovery::probe_speaker_by_ip;
use crate::state::ManualSpeakerConfig;
use crate::stream::{
    apply_fade_in, create_fade_out_frame, create_wav_header, crossfade_samples,
    extract_last_sample_pair, is_crossfade_compatible, AudioCodec, AudioFormat,
    IcyMetadataInjector, TaggedFrame,
};
use crate::utils::validate_speaker_ip;

/// Boxed stream type for audio data with ICY metadata support.
type AudioStream = Pin<Box<dyn futures::Stream<Item = Result<Bytes, std::io::Error>> + Send>>;

/// Threshold for counting delivery gaps (100ms).
/// PCM at 48kHz stereo 16-bit = 192KB/s, so 100ms = ~19KB of audio.
const DELIVERY_GAP_THRESHOLD_MS: u64 = 100;

/// Only log gaps exceeding this threshold to avoid log spam (500ms).
const DELIVERY_GAP_LOG_THRESHOLD_MS: u64 = 500;

/// Creates an IO error for broadcast channel lag.
///
/// Logs a warning and returns a formatted error. Centralizes the handling
/// of `BroadcastStreamRecvError::Lagged` to avoid duplication.
fn lagged_error(frames: u64) -> std::io::Error {
    log::warn!(
        "[Stream] Broadcast receiver lagged by {} frames - possible CPU contention",
        frames
    );
    std::io::Error::other(format!("lagged by {} frames", frames))
}

/// Creates a WAV audio stream with fixed-cadence output and crossfade on silence transitions.
///
/// Maintains real-time cadence regardless of input timing:
/// - Incoming frames are queued (bounded to `queue_size`)
/// - Metronome ticks every `frame_duration_ms`
/// - On each tick: send queued frame if available, else send silence
///
/// Crossfade on silence transitions:
/// - When entering silence: emits a fade-out frame from the last audio sample to zero
/// - When exiting silence: applies fade-in to the first audio frame
///
/// This ensures Sonos always receives continuous data with smooth transitions,
/// eliminating pops from abrupt audio/silence boundaries.
fn create_wav_stream_with_cadence(
    mut rx: broadcast::Receiver<Bytes>,
    silence_frame: Bytes,
    guard: Arc<LoggingStreamGuard>,
    queue_size: usize,
    frame_duration_ms: u32,
    audio_format: AudioFormat,
    prefill_frames: Vec<Bytes>,
) -> impl Stream<Item = Result<TaggedFrame, std::io::Error>> {
    stream! {
        let cadence_duration = Duration::from_millis(frame_duration_ms as u64);

        // Pre-populate queue with prefill frames to eliminate handoff gap.
        // This ensures the first tick immediately yields audio.
        let mut queue: VecDeque<Bytes> = VecDeque::with_capacity(queue_size.max(prefill_frames.len()));
        for frame in prefill_frames {
            queue.push_back(frame);
        }

        // Fire first tick immediately to get audio flowing before Sonos times out.
        // On resume, Sonos closes the connection within milliseconds if no audio arrives.
        let mut metronome = interval(cadence_duration);
        metronome.set_missed_tick_behavior(MissedTickBehavior::Burst);

        let mut rx_closed = false;
        let mut in_silence = false;
        let mut silence_start: Option<TokioInstant> = None;

        // Crossfade is only supported for 16-bit PCM. The handshake enforces this
        // for PCM streams, but we guard here defensively in case the invariant breaks.
        let crossfade_enabled = is_crossfade_compatible(&audio_format);
        if !crossfade_enabled {
            log::warn!(
                "[Stream] Crossfade disabled: requires 16-bit PCM, got {}-bit",
                audio_format.bits_per_sample
            );
        }

        // Crossfade state: track last sample pair for fade-out generation
        let fade_samples = crossfade_samples(audio_format.sample_rate);
        let samples_per_frame = audio_format.frame_samples(frame_duration_ms);
        let mut last_sample_pair: Option<(i16, i16)> = None;

        // Rate-limit lagged warnings (max once per second)
        let mut last_lagged_log: Option<TokioInstant> = None;

        loop {
            // Exit when channel closed AND queue drained
            if rx_closed && queue.is_empty() {
                break;
            }

            tokio::select! {
                biased;

                // PRIORITY 1: Metronome tick - MUST emit something every frame_duration_ms
                _ = metronome.tick() => {
                    if let Some(frame) = queue.pop_front() {
                        // Real audio available
                        let was_in_silence = in_silence;
                        if in_silence {
                            if let Some(start) = silence_start.take() {
                                log::info!(
                                    "[Stream] Exiting silence (cadence) after {:.1}s",
                                    start.elapsed().as_secs_f32()
                                );
                            }
                            in_silence = false;
                        }

                        // Track last sample pair for potential future fade-out
                        if crossfade_enabled {
                            last_sample_pair = extract_last_sample_pair(&frame, audio_format.channels);
                        }

                        // Apply fade-in if we just exited silence (and crossfade is enabled)
                        if was_in_silence && crossfade_enabled {
                            let mut faded = frame.to_vec();
                            apply_fade_in(&mut faded, audio_format.channels, fade_samples);
                            yield Ok(TaggedFrame::Audio(Bytes::from(faded)));
                        } else {
                            yield Ok(TaggedFrame::Audio(frame));
                        }
                    } else if !rx_closed {
                        // No frame available, emit silence
                        let entering_silence = !in_silence;
                        if entering_silence {
                            log::info!("[Stream] Entering silence (cadence) - queue empty");
                            in_silence = true;
                            silence_start = Some(TokioInstant::now());

                            // Generate fade-out frame if crossfade is enabled and we have last sample values
                            if crossfade_enabled {
                                if let Some((left, right)) = last_sample_pair.take() {
                                    let fade_out = create_fade_out_frame(
                                        left,
                                        right,
                                        audio_format.channels,
                                        fade_samples,
                                        samples_per_frame,
                                    );
                                    yield Ok(TaggedFrame::Silence(fade_out));
                                } else {
                                    yield Ok(TaggedFrame::Silence(silence_frame.clone()));
                                }
                            } else {
                                yield Ok(TaggedFrame::Silence(silence_frame.clone()));
                            }
                        } else {
                            yield Ok(TaggedFrame::Silence(silence_frame.clone()));
                        }
                    }
                    // If rx_closed and queue empty, don't yield - loop will break

                    // Drain any pending frames from rx into queue after emitting.
                    // This prevents starvation: with biased select, ticks always win,
                    // so without this drain, frames could pile up in rx while we
                    // emit silence (especially during recovery from underflow).
                    if !rx_closed {
                        loop {
                            match rx.try_recv() {
                                Ok(frame) => {
                                    if queue.len() >= queue_size {
                                        queue.pop_front();
                                        guard.record_frame_dropped();
                                    }
                                    queue.push_back(frame);
                                }
                                Err(broadcast::error::TryRecvError::Empty) => break,
                                Err(broadcast::error::TryRecvError::Lagged(n)) => {
                                    let now = TokioInstant::now();
                                    if last_lagged_log.map_or(true, |t| now.duration_since(t).as_secs() >= 1) {
                                        log::warn!("[Stream] Lagged by {n} frames (during drain)");
                                        last_lagged_log = Some(now);
                                    }
                                    // Continue draining - next try_recv will get latest
                                }
                                Err(broadcast::error::TryRecvError::Closed) => {
                                    rx_closed = true;
                                    log::debug!("[Stream] Channel closed, draining {} queued frames", queue.len());
                                    break;
                                }
                            }
                        }
                    }
                }

                // PRIORITY 2: Receive frames into queue (when channel open and tick not ready)
                result = rx.recv(), if !rx_closed => {
                    match result {
                        Ok(frame) => {
                            if queue.len() >= queue_size {
                                // Queue full - drop oldest to maintain bounded latency
                                queue.pop_front();
                                guard.record_frame_dropped();
                                log::trace!("[Stream] Queue full, dropped oldest frame");
                            }
                            queue.push_back(frame);
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            let now = TokioInstant::now();
                            if last_lagged_log.map_or(true, |t| now.duration_since(t).as_secs() >= 1) {
                                log::warn!("[Stream] Lagged by {n} frames");
                                last_lagged_log = Some(now);
                            }
                            // Continue - next recv will get latest
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            rx_closed = true;
                            log::debug!("[Stream] Channel closed, draining {} queued frames", queue.len());
                        }
                    }
                }
            }
        }
    }
}

/// Wrapper that logs HTTP audio stream lifecycle and tracks delivery timing.
///
/// Logs when the stream starts and ends, and tracks gaps in frame delivery
/// to help diagnose issues where Sonos stops receiving audio unexpectedly.
struct LoggingStreamGuard {
    stream_id: String,
    client_ip: IpAddr,
    frames_sent: AtomicU64,
    first_error: parking_lot::Mutex<Option<String>>,
    /// Tracks delivery timing to detect gaps
    delivery_stats: parking_lot::Mutex<DeliveryStats>,
}

/// Tracks frame delivery timing statistics.
struct DeliveryStats {
    last_delivery: Option<Instant>,
    max_gap_ms: u64,
    gaps_over_threshold: u64,
    /// Number of times silence mode was entered
    silence_events: u64,
    /// Total silence frames injected
    silence_frames: u64,
    /// Frames dropped due to cadence queue overflow
    frames_dropped: u64,
}

impl LoggingStreamGuard {
    fn new(stream_id: String, client_ip: IpAddr) -> Self {
        log::info!(
            "[Stream] HTTP stream started: stream={}, client={}",
            stream_id,
            client_ip
        );
        Self {
            stream_id,
            client_ip,
            frames_sent: AtomicU64::new(0),
            first_error: parking_lot::Mutex::new(None),
            delivery_stats: parking_lot::Mutex::new(DeliveryStats {
                last_delivery: None,
                max_gap_ms: 0,
                gaps_over_threshold: 0,
                silence_events: 0,
                silence_frames: 0,
                frames_dropped: 0,
            }),
        }
    }

    /// Records that silence mode was entered.
    fn record_silence_event(&self) {
        self.delivery_stats.lock().silence_events += 1;
    }

    /// Records a silence frame being sent.
    fn record_silence_frame(&self) {
        self.delivery_stats.lock().silence_frames += 1;
    }

    /// Records a frame being dropped due to queue overflow.
    fn record_frame_dropped(&self) {
        self.delivery_stats.lock().frames_dropped += 1;
    }

    fn record_frame(&self) {
        self.frames_sent.fetch_add(1, Ordering::Relaxed);

        let now = Instant::now();
        let mut stats = self.delivery_stats.lock();

        if let Some(last) = stats.last_delivery {
            let gap_ms = now.duration_since(last).as_millis() as u64;

            if gap_ms > stats.max_gap_ms {
                stats.max_gap_ms = gap_ms;
            }

            if gap_ms > DELIVERY_GAP_THRESHOLD_MS {
                stats.gaps_over_threshold += 1;
                // Only log significant gaps to avoid spam; summary captures total count
                if gap_ms > DELIVERY_GAP_LOG_THRESHOLD_MS {
                    log::warn!(
                        "[Stream] Delivery gap detected: stream={}, client={}, gap={}ms",
                        self.stream_id,
                        self.client_ip,
                        gap_ms
                    );
                }
            }
        }

        stats.last_delivery = Some(now);
    }

    fn record_error(&self, err: &str) {
        let mut first = self.first_error.lock();
        if first.is_none() {
            *first = Some(err.to_string());
        }
    }
}

impl Drop for LoggingStreamGuard {
    fn drop(&mut self) {
        let frames = self.frames_sent.load(Ordering::Relaxed);
        let first_error = self.first_error.get_mut();
        let stats = self.delivery_stats.get_mut();

        // Calculate time since last frame delivery
        let final_gap_ms = stats
            .last_delivery
            .map(|t| t.elapsed().as_millis() as u64)
            .unwrap_or(0);
        let stalled_suffix = if final_gap_ms > DELIVERY_GAP_LOG_THRESHOLD_MS {
            " (stalled)"
        } else {
            ""
        };

        // Build silence stats string if any silence was injected
        let silence_info = if stats.silence_events > 0 {
            format!(
                ", silence_events={}, silence_frames={}",
                stats.silence_events, stats.silence_frames
            )
        } else {
            String::new()
        };

        // Build dropped frames string if any frames were dropped
        let dropped_info = if stats.frames_dropped > 0 {
            format!(", frames_dropped={}", stats.frames_dropped)
        } else {
            String::new()
        };

        if let Some(ref err) = *first_error {
            log::warn!(
                "[Stream] HTTP stream ended with error{}: stream={}, client={}, frames_sent={}, \
                 max_gap={}ms, gaps_over_{}ms={}, final_gap={}ms{}{}, error={}",
                stalled_suffix,
                self.stream_id,
                self.client_ip,
                frames,
                stats.max_gap_ms,
                DELIVERY_GAP_THRESHOLD_MS,
                stats.gaps_over_threshold,
                final_gap_ms,
                silence_info,
                dropped_info,
                err
            );
        } else {
            log::info!(
                "[Stream] HTTP stream ended normally{}: stream={}, client={}, frames_sent={}, \
                 max_gap={}ms, gaps_over_{}ms={}, final_gap={}ms{}{}",
                stalled_suffix,
                self.stream_id,
                self.client_ip,
                frames,
                stats.max_gap_ms,
                DELIVERY_GAP_THRESHOLD_MS,
                stats.gaps_over_threshold,
                final_gap_ms,
                silence_info,
                dropped_info
            );
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// GENA Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Validates required GENA headers and extracts SID and SEQ values.
fn validate_gena_headers(headers: &HeaderMap) -> ThaumicResult<(String, String)> {
    // NT header should be "upnp:event"
    let nt = headers.get("NT").and_then(|v| v.to_str().ok());
    if nt != Some("upnp:event") {
        log::warn!("[GENA] NOTIFY missing or invalid NT header: {:?}", nt);
        return Err(ThaumicError::InvalidRequest(
            "Missing or invalid NT header".into(),
        ));
    }

    // NTS header should be "upnp:propchange"
    let nts = headers.get("NTS").and_then(|v| v.to_str().ok());
    if nts != Some("upnp:propchange") {
        log::warn!("[GENA] NOTIFY missing or invalid NTS header: {:?}", nts);
        return Err(ThaumicError::InvalidRequest(
            "Missing or invalid NTS header".into(),
        ));
    }

    // SID is required
    let sid = match headers.get("SID").and_then(|v| v.to_str().ok()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => {
            log::warn!("[GENA] NOTIFY missing SID header");
            return Err(ThaumicError::InvalidRequest("Missing SID header".into()));
        }
    };

    // SEQ header for event ordering (log but don't enforce for now)
    let seq = headers
        .get("SEQ")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("?")
        .to_string();

    Ok((sid, seq))
}

// ─────────────────────────────────────────────────────────────────────────────
// Request Types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct PlaybackRequest {
    ip: String,
    #[serde(rename = "streamId")]
    stream_id: String,
}

#[derive(Deserialize)]
struct VolumeRequest {
    volume: u8,
}

#[derive(Deserialize)]
struct MuteRequest {
    mute: bool,
}

#[derive(Deserialize)]
struct ManualSpeakerRequest {
    ip: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

/// Creates the Axum router with all routes.
pub fn create_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health_check))
        .route("/ready", get(readiness_check))
        .route("/api/speakers", get(list_speakers))
        .route("/api/groups", get(list_groups))
        .route("/api/state", get(get_current_state))
        .route("/api/refresh", post(handle_refresh))
        .route("/api/playback/start", post(handle_start_playback))
        .route(
            "/api/speakers/{ip}/volume",
            get(get_volume).post(set_volume),
        )
        .route("/api/speakers/{ip}/mute", get(get_mute).post(set_mute))
        .route("/api/speakers/manual/probe", post(probe_manual_speaker))
        .route(
            "/api/speakers/manual",
            get(list_manual_speakers).post(add_manual_speaker),
        )
        .route(
            "/api/speakers/manual/{ip}",
            axum::routing::delete(remove_manual_speaker),
        )
        .route("/sonos/gena", any(handle_gena_notify))
        .route("/stream/{id}/live", get(stream_audio))
        .route("/stream/{id}/live.wav", get(stream_audio))
        .route("/stream/{id}/live.flac", get(stream_audio))
        .route("/artwork.jpg", get(serve_artwork))
        .route("/ws", get(ws_handler))
        .with_state(state)
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

/// Liveness probe: "Is the process running?"
///
/// Always returns 200 OK if the server is responding. Use `/ready` for
/// readiness checks that verify the service can handle requests.
async fn health_check(State(state): State<AppState>) -> impl IntoResponse {
    let max_streams = state.config.read().streaming.max_concurrent_streams;
    api_success(json!({
        "status": "ok",
        "service": SERVICE_ID,
        "limits": {
            "maxStreams": max_streams
        }
    }))
}

/// Serves the static artwork for Sonos album art display.
///
/// Returns a JPEG image if artwork bytes are available, or 404 if artwork
/// is configured as an external URL (in which case Sonos fetches directly).
async fn serve_artwork(
    State(state): State<AppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
) -> Response {
    match state.artwork.as_bytes() {
        Some(bytes) => {
            log::info!(
                "[Artwork] Album art requested by {} ({} bytes)",
                remote_addr.ip(),
                bytes.len()
            );
            ([(header::CONTENT_TYPE, "image/jpeg")], bytes.clone()).into_response()
        }
        None => {
            // Artwork is configured as external URL; Sonos fetches directly
            log::debug!("[Artwork] Album art requested but using external URL");
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

/// Readiness probe: "Can the service handle requests?"
///
/// Returns 200 OK only when:
/// - Server port has been assigned (listening)
/// - Local IP has been detected (can build stream URLs)
///
/// Returns 503 Service Unavailable with details when not ready.
async fn readiness_check(State(state): State<AppState>) -> Response {
    let port = state.network.get_port();
    let local_ip = state.network.local_ip.read().clone();
    let has_groups = !state.sonos_state.groups.read().is_empty();

    let port_ready = port > 0;
    let ip_ready = !local_ip.is_empty();
    let ready = port_ready && ip_ready;

    let status = if ready { "ready" } else { "not_ready" };
    let checks = json!({
        "port": { "ready": port_ready, "value": port },
        "localIp": { "ready": ip_ready, "value": if ip_ready { &local_ip } else { "(not detected)" } },
        "discovery": { "ready": has_groups, "info": "optional - speakers discovered" }
    });

    let body = json!({
        "status": status,
        "ready": ready,
        "checks": checks
    });

    if ready {
        api_success(body).into_response()
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, Json(body)).into_response()
    }
}

async fn list_speakers(State(state): State<AppState>) -> Response {
    match state.sonos.discover_speakers().await {
        Ok(speakers) => api_success(json!({ "speakers": speakers })).into_response(),
        Err(e) => {
            api_error(StatusCode::INTERNAL_SERVER_ERROR, "discovery_failed", e).into_response()
        }
    }
}

async fn list_groups(State(state): State<AppState>) -> impl IntoResponse {
    let groups = state.sonos_state.groups.read().clone();
    api_success(json!({ "groups": groups }))
}

/// Returns current system state (groups, transport states, volumes, mute states).
async fn get_current_state(State(state): State<AppState>) -> impl IntoResponse {
    api_success(state.sonos_state.to_json())
}

/// Triggers a manual topology refresh.
async fn handle_refresh(State(state): State<AppState>) -> impl IntoResponse {
    state.discovery_service.trigger_refresh();
    api_ok()
}

async fn handle_start_playback(
    State(state): State<AppState>,
    Json(payload): Json<PlaybackRequest>,
) -> ThaumicResult<impl IntoResponse> {
    let artwork_url = state.artwork_metadata_url();
    state
        .stream_coordinator
        .start_playback(&payload.ip, &payload.stream_id, None, &artwork_url)
        .await?;

    Ok(api_ok())
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual Speaker Handlers
// ─────────────────────────────────────────────────────────────────────────────

/// Returns the app data directory or an error response if not configured.
fn require_data_dir(state: &AppState) -> ThaumicResult<PathBuf> {
    state.discovery_service.get_app_data_dir().ok_or_else(|| {
        ThaumicError::DataDirNotConfigured(
            "Manual speaker persistence requires --data-dir or THAUMIC_DATA_DIR to be set".into(),
        )
    })
}

/// Parses and validates an IP address for use as a Sonos speaker.
///
/// Returns the canonical IPv4 string representation on success.
fn parse_and_validate_ip(ip: &str) -> ThaumicResult<String> {
    let parsed: IpAddr = ip
        .parse()
        .map_err(|_| ThaumicError::InvalidIp("Invalid IP address format".into()))?;

    let ipv4 =
        validate_speaker_ip(&parsed).map_err(|e| ThaumicError::InvalidIp(e.message().into()))?;

    Ok(ipv4.to_string())
}

/// POST /api/speakers/manual/probe
///
/// Validates an IP address and probes it to confirm it's a Sonos speaker.
/// Does not persist the IP - use POST /api/speakers/manual to add after probing.
async fn probe_manual_speaker(
    State(state): State<AppState>,
    Json(payload): Json<ManualSpeakerRequest>,
) -> Response {
    let canonical_ip = match parse_and_validate_ip(&payload.ip) {
        Ok(ip) => ip,
        Err(e) => return e.into_response(),
    };

    match probe_speaker_by_ip(state.discovery_service.http_client(), &canonical_ip).await {
        Ok(speaker) => api_success(json!({ "speaker": speaker })).into_response(),
        Err(e) => {
            // DiscoveryError implements ErrorCode trait with specific codes
            // like "ip_unreachable" and "not_sonos_device"
            api_error(StatusCode::BAD_REQUEST, e.code(), e).into_response()
        }
    }
}

/// POST /api/speakers/manual
///
/// Adds a manually configured speaker IP address.
/// Probes the IP first to verify it's a Sonos speaker before persisting.
/// Triggers a topology refresh after adding.
async fn add_manual_speaker(
    State(state): State<AppState>,
    Json(payload): Json<ManualSpeakerRequest>,
) -> Response {
    let data_dir = match require_data_dir(&state) {
        Ok(dir) => dir,
        Err(e) => return e.into_response(),
    };

    let canonical_ip = match parse_and_validate_ip(&payload.ip) {
        Ok(ip) => ip,
        Err(e) => return e.into_response(),
    };

    // Probe to verify it's actually a Sonos speaker before persisting
    if let Err(e) = probe_speaker_by_ip(state.discovery_service.http_client(), &canonical_ip).await
    {
        return api_error(StatusCode::BAD_REQUEST, e.code(), e).into_response();
    }

    if let Err(e) = ManualSpeakerConfig::add_ip_atomic(&data_dir, canonical_ip) {
        return api_error(StatusCode::INTERNAL_SERVER_ERROR, "save_failed", e).into_response();
    }

    state.discovery_service.trigger_refresh();
    api_ok().into_response()
}

/// DELETE /api/speakers/manual/:ip
///
/// Removes a manually configured speaker IP address.
/// Triggers a topology refresh after removing.
///
/// If the IP can be parsed and validated, uses canonical form for storage matching.
/// If parsing fails (e.g., IPv6, malformed input), falls back to exact string
/// matching to allow removal of legacy/invalid entries from the config file.
async fn remove_manual_speaker(Path(ip): Path<String>, State(state): State<AppState>) -> Response {
    let data_dir = match require_data_dir(&state) {
        Ok(dir) => dir,
        Err(e) => return e.into_response(),
    };

    // Try canonical matching first, fall back to exact string for invalid/legacy entries
    let ip_to_remove = parse_and_validate_ip(&ip).unwrap_or_else(|_| ip.clone());

    if let Err(e) = ManualSpeakerConfig::remove_ip_atomic(&data_dir, &ip_to_remove) {
        return api_error(StatusCode::INTERNAL_SERVER_ERROR, "save_failed", e).into_response();
    }

    state.discovery_service.trigger_refresh();
    api_ok().into_response()
}

/// GET /api/speakers/manual
///
/// Lists manually configured speaker IP addresses.
async fn list_manual_speakers(State(state): State<AppState>) -> Response {
    let data_dir = match require_data_dir(&state) {
        Ok(dir) => dir,
        Err(e) => return e.into_response(),
    };

    let config = ManualSpeakerConfig::load(&data_dir);
    api_success(json!({ "ips": config.speaker_ips })).into_response()
}

// ─────────────────────────────────────────────────────────────────────────────
// Volume/Mute Handlers
// ─────────────────────────────────────────────────────────────────────────────

/// Gets the current group volume for a speaker.
async fn get_volume(
    Path(ip): Path<String>,
    State(state): State<AppState>,
) -> ThaumicResult<impl IntoResponse> {
    let volume = state.sonos.get_group_volume(&ip).await?;
    Ok(api_success(json!({ "ip": ip, "volume": volume })))
}

/// Sets the group volume for a speaker.
async fn set_volume(
    Path(ip): Path<String>,
    State(state): State<AppState>,
    Json(payload): Json<VolumeRequest>,
) -> ThaumicResult<impl IntoResponse> {
    state.sonos.set_group_volume(&ip, payload.volume).await?;
    Ok(api_success(json!({ "ip": ip, "volume": payload.volume })))
}

/// Gets the current group mute state for a speaker.
async fn get_mute(
    Path(ip): Path<String>,
    State(state): State<AppState>,
) -> ThaumicResult<impl IntoResponse> {
    let mute = state.sonos.get_group_mute(&ip).await?;
    Ok(api_success(json!({ "ip": ip, "mute": mute })))
}

/// Sets the group mute state for a speaker.
async fn set_mute(
    Path(ip): Path<String>,
    State(state): State<AppState>,
    Json(payload): Json<MuteRequest>,
) -> ThaumicResult<impl IntoResponse> {
    state.sonos.set_group_mute(&ip, payload.mute).await?;
    Ok(api_success(json!({ "ip": ip, "mute": payload.mute })))
}

async fn handle_gena_notify(
    State(state): State<AppState>,
    req: Request<Body>,
) -> ThaumicResult<impl IntoResponse> {
    let (parts, body) = req.into_parts();

    // Only accept NOTIFY method (used by UPnP/GENA)
    if parts.method.as_str() != "NOTIFY" {
        return Err(ThaumicError::InvalidRequest(format!(
            "Expected NOTIFY method, got {}",
            parts.method
        )));
    }

    let (sid, seq) = validate_gena_headers(&parts.headers)?;

    let body_bytes = axum::body::to_bytes(body, MAX_GENA_BODY_SIZE)
        .await
        .map_err(|e| {
            log::warn!("[GENA] Failed to read NOTIFY body: {}", e);
            ThaumicError::InvalidRequest("Failed to read body".into())
        })?;

    let events = state
        .discovery_service
        .handle_gena_notify(&sid, &String::from_utf8_lossy(&body_bytes));

    if events.is_empty() {
        log::trace!(
            "[GENA] NOTIFY from {} (SEQ: {}) - no parseable events",
            sid,
            seq
        );
    } else {
        log::debug!(
            "[GENA] NOTIFY from {} (SEQ: {}) - {} events",
            sid,
            seq,
            events.len()
        );
    }

    Ok(StatusCode::OK)
}

async fn stream_audio(
    Path(id): Path<String>,
    State(state): State<AppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> ThaumicResult<Response> {
    let stream_state = state
        .stream_coordinator
        .get_stream(&id)
        .ok_or_else(|| ThaumicError::StreamNotFound(id.clone()))?;

    let remote_ip = remote_addr.ip();

    // === Range Header Logging (empirical testing) ===
    // Captures what Sonos sends on pause/resume to inform our handling strategy.
    let range_header = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    if let Some(ref range) = range_header {
        log::warn!(
            "[Stream] RANGE REQUEST: client={}, stream={}, codec={:?}, range='{}'",
            remote_ip,
            id,
            stream_state.codec,
            range
        );
        // Log other potentially relevant headers for context
        if let Some(if_range) = headers.get("if-range").and_then(|v| v.to_str().ok()) {
            log::warn!("[Stream]   If-Range: {}", if_range);
        }
        if let Some(user_agent) = headers
            .get(header::USER_AGENT)
            .and_then(|v| v.to_str().ok())
        {
            log::warn!("[Stream]   User-Agent: {}", user_agent);
        }
    } else {
        log::info!(
            "[Stream] New connection: client={}, stream={}, codec={:?}",
            remote_ip,
            id,
            stream_state.codec
        );
    }

    // Detect resume: epoch >= 1 means there was a previous HTTP connection.
    let is_resume = stream_state.timing.epoch_count() >= 1;

    // Upfront buffering delay for PCM streams BEFORE subscribing.
    // This lets the ring buffer accumulate more frames. Subscribing after
    // ensures the broadcast receiver doesn't fill up during the delay.
    // Delay matches streaming_buffer_ms so cadence queue starts full.
    //
    // SKIP on resume: Sonos closes the connection within milliseconds if we delay.
    // The buffer already has frames from before the pause, so no delay is needed.
    // TEST: Disable prefill delay to see if SOAP latency provides natural buffering
    let prefill_delay_ms = 0; // was: stream_state.streaming_buffer_ms
    if stream_state.codec == AudioCodec::Pcm && prefill_delay_ms > 0 && !is_resume {
        log::debug!(
            "[Stream] Applying {}ms prefill delay for PCM stream",
            prefill_delay_ms
        );
        tokio::time::sleep(Duration::from_millis(prefill_delay_ms)).await;
    } else if is_resume && stream_state.codec == AudioCodec::Pcm {
        log::info!(
            "[Stream] Skipping {}ms prefill delay on resume (epoch={})",
            prefill_delay_ms,
            stream_state.timing.epoch_count()
        );

        // Send Play command to Sonos on resume.
        // When user resumes from Sonos app, Sonos makes a new HTTP request but stays
        // in "paused" transport state. The Play command tells Sonos to start playback.
        // Fire-and-forget: we spawn this so it doesn't block the HTTP response.
        let sonos = Arc::clone(&state.sonos);
        let ip = remote_ip.to_string();
        tokio::spawn(async move {
            if let Err(e) = sonos.play(&ip).await {
                log::warn!("[Stream] Play command on resume failed for {}: {}", ip, e);
            }
        });
    }

    // Capture connected_at AFTER prefill delay so latency metrics
    // reflect actual transport latency, not intentional buffering.
    let connected_at = Instant::now();

    // Subscribe AFTER delay to get fresh prefill snapshot and avoid rx backlog
    let (epoch_candidate, prefill_frames, rx) = stream_state.subscribe();

    log::debug!(
        "[Stream] Client {} connected to stream {}, sending {} prefill frames",
        remote_ip,
        id,
        prefill_frames.len()
    );

    // Type alias for tagged frame stream
    type TaggedStream = Pin<Box<dyn Stream<Item = Result<TaggedFrame, std::io::Error>> + Send>>;

    // Create logging guard early so we can pass it to the cadence stream for drop tracking.
    // Uses Arc so it can be shared between cadence stream, silence tracking, and final frame recording.
    let guard = Arc::new(LoggingStreamGuard::new(id.to_string(), remote_ip));

    // Build combined stream - PCM gets cadence-based streaming, compressed codecs don't.
    //
    // Why PCM-only: Sonos treats PCM/WAV as a "file" requiring continuous data flow.
    // CPU spikes that delay delivery cause Sonos to close the connection.
    // The cadence stream maintains 20ms output cadence, injecting silence when needed.
    //
    // Compressed codecs (AAC, MP3, FLAC) have their own framing and silence
    // representation - raw zeros would corrupt the stream. These codecs also
    // tend to be more resilient to jitter due to their buffering behavior.
    let combined_stream: TaggedStream = if stream_state.codec == AudioCodec::Pcm {
        // PCM: fixed-cadence streaming with queue buffer and silence injection.
        // Prefill frames are pre-populated in the queue to eliminate handoff gap.
        let frame_duration_ms = stream_state.frame_duration_ms;
        let silence_frame = stream_state.audio_format.silence_frame(frame_duration_ms);

        // Calculate queue size from streaming buffer (ceil division)
        // queue_size = ceil(buffer_ms / frame_ms), clamped to [1, MAX_CADENCE_QUEUE_SIZE]
        let queue_size = stream_state
            .streaming_buffer_ms
            .div_ceil(frame_duration_ms as u64) as usize;
        let queue_size = queue_size.clamp(1, MAX_CADENCE_QUEUE_SIZE);

        Box::pin(create_wav_stream_with_cadence(
            rx,
            silence_frame,
            Arc::clone(&guard),
            queue_size,
            frame_duration_ms,
            stream_state.audio_format,
            prefill_frames,
        ))
    } else {
        // Compressed codecs: no silence injection, chain prefill before live
        let prefill_stream = futures::stream::iter(
            prefill_frames
                .into_iter()
                .map(|b| Ok(TaggedFrame::Audio(b))),
        );
        let live_stream = BroadcastStream::new(rx).map(|res| match res {
            Ok(frame) => Ok(TaggedFrame::Audio(frame)),
            Err(BroadcastStreamRecvError::Lagged(n)) => Err(lagged_error(n)),
        });
        Box::pin(futures::StreamExt::chain(prefill_stream, live_stream))
    };

    // === Epoch Hook ===
    // This embeds epoch lifecycle management in the HTTP layer. While this might seem
    // like a separation of concerns violation, it's intentional because:
    //
    // 1. Requires ConnectInfo<SocketAddr> - only available via Axum extractors
    // 2. Must detect actual audio consumption - the stream poll is the only reliable signal
    // 3. HTTP connection lifecycle defines epoch boundary - Sonos reconnects = new epoch
    //
    // The epoch establishes T0 for latency measurement: the timestamp of the oldest
    // audio frame being served when Sonos first polls data from this connection.
    let hook_state = Some((
        Arc::clone(&stream_state),
        epoch_candidate,
        connected_at,
        remote_ip,
    ));

    let tracked_stream = combined_stream.scan(
        hook_state,
        |state, item: Result<TaggedFrame, std::io::Error>| {
            if let Some((stream_state, epoch_candidate, connected_at, remote_ip)) = state.take() {
                // Only fire epoch on REAL, NON-EMPTY audio (not silence or empty buffers)
                if let Ok(ref frame) = item {
                    if frame.is_real_audio() && !frame.as_bytes().is_empty() {
                        let first_audio_polled_at = Instant::now();
                        stream_state.timing.start_new_epoch(
                            epoch_candidate,
                            connected_at,
                            first_audio_polled_at,
                            remote_ip,
                        );
                    } else {
                        // Silence or empty frame - don't burn the hook, wait for real audio
                        *state = Some((stream_state, epoch_candidate, connected_at, remote_ip));
                    }
                } else {
                    // Error - don't burn the hook
                    *state = Some((stream_state, epoch_candidate, connected_at, remote_ip));
                }
            }
            futures::future::ready(Some(item))
        },
    );

    // Content-Type based on output codec
    let content_type = stream_state.codec.mime_type();

    // ICY metadata only supported for MP3/AAC streams (not PCM/FLAC)
    let supports_icy = matches!(stream_state.codec, AudioCodec::Mp3 | AudioCodec::Aac);
    let wants_icy =
        supports_icy && headers.get("icy-metadata").and_then(|v| v.to_str().ok()) == Some("1");

    let mut builder = Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        // DLNA streaming header: indicates real-time playback vs download-first
        .header("TransferMode.dlna.org", "Streaming")
        // Stream identification for renderers that display station name
        .header("icy-name", APP_NAME);

    if wants_icy {
        builder = builder.header("icy-metaint", ICY_METAINT.to_string());
    }

    // PCM: Use fixed Content-Length to avoid chunked transfer encoding.
    // Some renderers (including Sonos) stutter or disconnect with chunked encoding.
    // The stream will end before reaching this length, but it signals "file-like"
    // behavior to the renderer.
    if stream_state.codec == AudioCodec::Pcm {
        builder = builder.header(header::CONTENT_LENGTH, WAV_STREAM_SIZE_MAX.to_string());
    }

    // Unwrap TaggedFrame to Bytes, tracking silence events/frames for the final summary.
    // This must happen before the TaggedFrame type information is lost.
    let guard_for_silence = Arc::clone(&guard);
    let mut silence_event_recorded = false;
    let unwrapped_stream = tracked_stream.map(move |res| {
        if let Ok(ref frame) = res {
            match frame {
                TaggedFrame::Silence(_) => {
                    // Record first silence frame as an "event" (entering silence mode)
                    if !silence_event_recorded {
                        guard_for_silence.record_silence_event();
                        silence_event_recorded = true;
                    }
                    guard_for_silence.record_silence_frame();
                }
                TaggedFrame::Audio(_) => {
                    // Reset so next silence burst counts as new event
                    silence_event_recorded = false;
                }
            }
        }
        res.map(TaggedFrame::into_bytes)
    });

    // Apply ICY injection or PCM/WAV header to the unwrapped stream
    let inner_stream: AudioStream = if wants_icy {
        let stream_ref = Arc::clone(&stream_state);
        let mut injector = IcyMetadataInjector::new();

        Box::pin(unwrapped_stream.map(move |res| {
            let chunk = res?;
            let metadata = stream_ref.metadata.read();
            Ok::<Bytes, std::io::Error>(injector.inject(chunk.as_ref(), &metadata))
        }))
    } else if stream_state.codec == AudioCodec::Pcm {
        // PCM streams need WAV header prepended per-connection (Sonos may reconnect)
        let audio_format = stream_state.audio_format;
        let wav_header = create_wav_header(
            audio_format.sample_rate,
            audio_format.channels,
            audio_format.bits_per_sample,
        );
        Box::pin(futures::StreamExt::chain(
            futures::stream::once(async move { Ok(wav_header) }),
            unwrapped_stream,
        ))
    } else {
        Box::pin(unwrapped_stream)
    };

    // Wrap stream with logging guard to track delivery timing and errors.
    // The guard logs summary stats on drop when the stream ends.
    let guard_for_frames = Arc::clone(&guard);
    let final_stream: AudioStream = Box::pin(inner_stream.map(move |res| {
        match &res {
            Ok(_) => guard_for_frames.record_frame(),
            Err(e) => guard_for_frames.record_error(&e.to_string()),
        }
        res
    }));

    builder
        .body(Body::from_stream(final_stream))
        .map_err(|e| ThaumicError::Internal(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;
    use std::future::poll_fn;
    use std::task::Poll;
    use tokio::time::{self, Duration};

    /// Test silence frame for assertions.
    fn test_silence_frame() -> Bytes {
        Bytes::from_static(&[0u8; 64])
    }

    /// Test audio frame for assertions.
    fn test_audio_frame() -> Bytes {
        Bytes::from_static(&[1u8; 64])
    }

    /// Polls the stream once to register internal timers, then advances time.
    ///
    /// With `start_paused = true`, timers must be polled before `time::advance`
    /// will affect them. This helper ensures the stream's internal select! loop
    /// registers its timers before we manipulate time.
    async fn poll_and_advance<S>(stream: &mut Pin<&mut S>, duration: Duration)
    where
        S: Stream + ?Sized,
    {
        // Poll stream once to register timers (should return Pending since no data/timeout yet)
        poll_fn(|cx| {
            let _ = stream.as_mut().poll_next(cx);
            Poll::Ready(())
        })
        .await;

        time::advance(duration).await;
    }

    mod wav_cadence_streaming {
        use super::*;
        use crate::protocol_constants::SILENCE_FRAME_DURATION_MS;
        use std::net::Ipv4Addr;

        /// Default queue size for tests (10 frames = 200ms at 20ms/frame).
        const TEST_QUEUE_SIZE: usize = 10;

        /// Creates a test guard for cadence stream tests.
        fn test_guard() -> Arc<LoggingStreamGuard> {
            Arc::new(LoggingStreamGuard::new(
                "test-stream".to_string(),
                IpAddr::V4(Ipv4Addr::LOCALHOST),
            ))
        }

        /// Creates a test audio format for cadence stream tests.
        fn test_audio_format() -> AudioFormat {
            AudioFormat::new(48000, 2, 16)
        }

        #[tokio::test(start_paused = true)]
        async fn emits_frames_at_cadence() {
            let (tx, rx) = broadcast::channel::<Bytes>(16);
            let silence = test_silence_frame();
            let audio = test_audio_frame();
            let guard = test_guard();

            let mut stream = Box::pin(create_wav_stream_with_cadence(
                rx,
                silence.clone(),
                guard,
                TEST_QUEUE_SIZE,
                SILENCE_FRAME_DURATION_MS,
                test_audio_format(),
            ));

            // Queue some frames before the first tick
            tx.send(audio.clone()).expect("send should succeed");
            tx.send(audio.clone()).expect("send should succeed");

            // Poll to register metronome, advance one tick (20ms)
            poll_and_advance(
                &mut stream.as_mut(),
                Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
            )
            .await;

            // Should get first audio frame
            let frame = stream.next().await.expect("stream should yield");
            assert!(
                matches!(frame.unwrap(), TaggedFrame::Audio(_)),
                "expected first Audio frame at cadence tick"
            );

            // Advance another tick
            poll_and_advance(
                &mut stream.as_mut(),
                Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
            )
            .await;

            // Should get second audio frame
            let frame = stream.next().await.expect("stream should yield");
            assert!(
                matches!(frame.unwrap(), TaggedFrame::Audio(_)),
                "expected second Audio frame at cadence tick"
            );

            drop(tx);
        }

        #[tokio::test(start_paused = true)]
        async fn fills_gaps_with_silence() {
            let (tx, rx) = broadcast::channel::<Bytes>(16);
            let silence = test_silence_frame();
            let guard = test_guard();

            let mut stream = Box::pin(create_wav_stream_with_cadence(
                rx,
                silence.clone(),
                guard,
                TEST_QUEUE_SIZE,
                SILENCE_FRAME_DURATION_MS,
                test_audio_format(),
            ));

            // Don't send any frames - queue will be empty

            // Poll to register metronome, advance one tick
            poll_and_advance(
                &mut stream.as_mut(),
                Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
            )
            .await;

            // Should get silence frame since queue is empty
            let frame = stream.next().await.expect("stream should yield");
            assert!(
                matches!(frame.unwrap(), TaggedFrame::Silence(_)),
                "expected Silence frame when queue is empty"
            );

            // Another tick should also yield silence
            poll_and_advance(
                &mut stream.as_mut(),
                Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
            )
            .await;

            let frame = stream.next().await.expect("stream should yield");
            assert!(
                matches!(frame.unwrap(), TaggedFrame::Silence(_)),
                "expected Silence frame on continued empty queue"
            );

            drop(tx);
        }

        #[tokio::test(start_paused = true)]
        async fn queue_drains_at_cadence() {
            let (tx, rx) = broadcast::channel::<Bytes>(16);
            let silence = test_silence_frame();
            let guard = test_guard();

            let mut stream = Box::pin(create_wav_stream_with_cadence(
                rx,
                silence.clone(),
                guard,
                TEST_QUEUE_SIZE,
                SILENCE_FRAME_DURATION_MS,
                test_audio_format(),
            ));

            // Queue 3 frames as a burst
            for i in 0..3 {
                tx.send(Bytes::from(vec![i; 64]))
                    .expect("send should succeed");
            }

            // Each tick should drain one frame
            for expected_byte in 0..3u8 {
                poll_and_advance(
                    &mut stream.as_mut(),
                    Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
                )
                .await;

                let frame = stream.next().await.expect("stream should yield");
                let frame = frame.expect("should be Ok");
                if let TaggedFrame::Audio(bytes) = frame {
                    assert_eq!(
                        bytes[0], expected_byte,
                        "frames should drain in order at cadence"
                    );
                } else {
                    panic!("expected Audio frame, got Silence");
                }
            }

            // Queue is now empty, next tick should yield silence
            poll_and_advance(
                &mut stream.as_mut(),
                Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
            )
            .await;

            let frame = stream.next().await.expect("stream should yield");
            assert!(
                matches!(frame.unwrap(), TaggedFrame::Silence(_)),
                "expected Silence after queue drained"
            );

            drop(tx);
        }

        #[tokio::test(start_paused = true)]
        async fn drops_oldest_on_overflow() {
            let (tx, rx) = broadcast::channel::<Bytes>(32);
            let silence = test_silence_frame();
            let guard = test_guard();

            let mut stream = Box::pin(create_wav_stream_with_cadence(
                rx,
                silence.clone(),
                guard,
                TEST_QUEUE_SIZE,
                SILENCE_FRAME_DURATION_MS,
                test_audio_format(),
            ));

            // Fill the queue to capacity + 2 (should drop 2 oldest)
            // Each frame is marked with its index so we can verify order
            for i in 0..(TEST_QUEUE_SIZE + 2) as u8 {
                tx.send(Bytes::from(vec![i; 64]))
                    .expect("send should succeed");
            }

            // Give time for frames to be received into queue
            poll_and_advance(
                &mut stream.as_mut(),
                Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
            )
            .await;

            // First frame should be the 3rd one (index 2), since 0 and 1 were dropped
            let frame = stream.next().await.expect("stream should yield");
            let frame = frame.expect("should be Ok");
            if let TaggedFrame::Audio(bytes) = frame {
                assert_eq!(
                    bytes[0], 2,
                    "oldest frames should be dropped, got frame {}",
                    bytes[0]
                );
            } else {
                panic!("expected Audio frame");
            }

            drop(tx);
        }

        #[tokio::test(start_paused = true)]
        async fn tracks_dropped_frames() {
            let (tx, rx) = broadcast::channel::<Bytes>(32);
            let silence = test_silence_frame();
            let guard = test_guard();
            let guard_for_check = Arc::clone(&guard);

            let mut stream = Box::pin(create_wav_stream_with_cadence(
                rx,
                silence.clone(),
                guard,
                TEST_QUEUE_SIZE,
                SILENCE_FRAME_DURATION_MS,
                test_audio_format(),
            ));

            // Overflow queue by TEST_QUEUE_SIZE + 3 frames
            let overflow_count = 3;
            for i in 0..(TEST_QUEUE_SIZE + overflow_count) as u8 {
                tx.send(Bytes::from(vec![i; 64]))
                    .expect("send should succeed");
            }

            // Give time for frames to be received and processed
            poll_and_advance(
                &mut stream.as_mut(),
                Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
            )
            .await;

            // Consume a frame to ensure internal processing has happened
            let _ = stream.next().await;

            // Check the guard counter - should have recorded dropped frames
            let stats = guard_for_check.delivery_stats.lock();
            assert_eq!(
                stats.frames_dropped, overflow_count as u64,
                "guard should track {} dropped frames",
                overflow_count
            );

            drop(tx);
        }

        #[tokio::test(start_paused = true)]
        async fn drains_queue_on_channel_close() {
            let (tx, rx) = broadcast::channel::<Bytes>(16);
            let silence = test_silence_frame();
            let guard = test_guard();

            let mut stream = Box::pin(create_wav_stream_with_cadence(
                rx,
                silence.clone(),
                guard,
                TEST_QUEUE_SIZE,
                SILENCE_FRAME_DURATION_MS,
                test_audio_format(),
            ));

            // Queue some frames
            tx.send(Bytes::from(vec![1; 64]))
                .expect("send should succeed");
            tx.send(Bytes::from(vec![2; 64]))
                .expect("send should succeed");

            // Give time for frames to be queued
            poll_and_advance(
                &mut stream.as_mut(),
                Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
            )
            .await;
            let _ = stream.next().await; // consume first frame

            // Close the channel
            drop(tx);

            // Advance and drain remaining frame
            poll_and_advance(
                &mut stream.as_mut(),
                Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
            )
            .await;

            // Should still get the queued frame
            let frame = stream
                .next()
                .await
                .expect("stream should yield queued frame");
            let frame = frame.expect("should be Ok");
            if let TaggedFrame::Audio(bytes) = frame {
                assert_eq!(bytes[0], 2, "should drain remaining queued frame");
            } else {
                panic!("expected Audio frame from queue");
            }

            // Now stream should end (channel closed AND queue empty)
            poll_and_advance(
                &mut stream.as_mut(),
                Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
            )
            .await;

            let frame = stream.next().await;
            assert!(
                frame.is_none(),
                "stream should end when channel closed and queue empty"
            );
        }

        #[tokio::test(start_paused = true)]
        async fn exits_silence_when_frames_arrive() {
            let (tx, rx) = broadcast::channel::<Bytes>(16);
            let silence = test_silence_frame();
            let audio = test_audio_frame();
            let guard = test_guard();

            let mut stream = Box::pin(create_wav_stream_with_cadence(
                rx,
                silence.clone(),
                guard,
                TEST_QUEUE_SIZE,
                SILENCE_FRAME_DURATION_MS,
                test_audio_format(),
            ));

            // First tick with empty queue -> silence
            poll_and_advance(
                &mut stream.as_mut(),
                Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
            )
            .await;

            let frame = stream.next().await.expect("stream should yield");
            assert!(
                matches!(frame.unwrap(), TaggedFrame::Silence(_)),
                "expected Silence when queue empty"
            );

            // Queue a frame
            tx.send(audio.clone()).expect("send should succeed");

            // Next tick should yield audio (exit silence)
            poll_and_advance(
                &mut stream.as_mut(),
                Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
            )
            .await;

            let frame = stream.next().await.expect("stream should yield");
            assert!(
                matches!(frame.unwrap(), TaggedFrame::Audio(_)),
                "expected Audio when frame queued after silence"
            );

            drop(tx);
        }
    }

    mod manual_speaker_handlers {
        use super::*;

        #[test]
        fn parse_and_validate_ip_valid_ipv4() {
            let result = parse_and_validate_ip("192.168.1.100");
            assert!(result.is_ok());
            assert_eq!(result.unwrap(), "192.168.1.100");
        }

        #[test]
        fn parse_and_validate_ip_leading_zeros_rejected() {
            // Rust's IpAddr parser rejects leading zeros (ambiguous - could be octal)
            let result = parse_and_validate_ip("192.168.001.100");
            assert!(result.is_err());
        }

        #[test]
        fn parse_and_validate_ip_invalid_format() {
            let result = parse_and_validate_ip("not-an-ip");
            assert!(result.is_err());
        }

        #[test]
        fn parse_and_validate_ip_empty_string() {
            let result = parse_and_validate_ip("");
            assert!(result.is_err());
        }

        #[test]
        fn parse_and_validate_ip_ipv6_rejected() {
            let result = parse_and_validate_ip("::1");
            assert!(result.is_err());

            let result = parse_and_validate_ip("2001:db8::1");
            assert!(result.is_err());
        }

        #[test]
        fn parse_and_validate_ip_loopback_rejected() {
            let result = parse_and_validate_ip("127.0.0.1");
            assert!(result.is_err());
        }

        #[test]
        fn parse_and_validate_ip_broadcast_rejected() {
            let result = parse_and_validate_ip("255.255.255.255");
            assert!(result.is_err());
        }

        #[test]
        fn parse_and_validate_ip_multicast_rejected() {
            let result = parse_and_validate_ip("224.0.0.1");
            assert!(result.is_err());
        }

        #[test]
        fn parse_and_validate_ip_link_local_rejected() {
            let result = parse_and_validate_ip("169.254.1.1");
            assert!(result.is_err());
        }

        #[test]
        fn parse_and_validate_ip_unspecified_rejected() {
            let result = parse_and_validate_ip("0.0.0.0");
            assert!(result.is_err());
        }
    }
}
