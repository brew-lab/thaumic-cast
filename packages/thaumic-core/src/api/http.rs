//! HTTP route handlers.
//!
//! All handlers are thin - they delegate to services for business logic.

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

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
    create_wav_header, create_wav_stream_with_cadence, lagged_error, AudioCodec,
    IcyMetadataInjector, LoggingStreamGuard, TaggedFrame,
};
use crate::utils::validate_speaker_ip;

/// Boxed stream type for audio data with ICY metadata support.
type AudioStream = Pin<Box<dyn futures::Stream<Item = Result<Bytes, std::io::Error>> + Send>>;

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

/// Gets the current volume for a speaker.
///
/// For speakers in sync sessions (x-rincon joined), returns per-speaker volume.
/// Otherwise returns group volume.
async fn get_volume(
    Path(ip): Path<String>,
    State(state): State<AppState>,
) -> ThaumicResult<impl IntoResponse> {
    let volume = state
        .stream_coordinator
        .get_volume_routed(&*state.sonos, &ip)
        .await?;
    Ok(api_success(json!({ "ip": ip, "volume": volume })))
}

/// Sets the volume for a speaker.
///
/// For speakers in sync sessions (x-rincon joined), uses per-speaker volume
/// to allow independent room control. Otherwise uses group volume which
/// preserves stereo pair/sub proportional behavior.
async fn set_volume(
    Path(ip): Path<String>,
    State(state): State<AppState>,
    Json(payload): Json<VolumeRequest>,
) -> ThaumicResult<impl IntoResponse> {
    state
        .stream_coordinator
        .set_volume_routed(&*state.sonos, &ip, payload.volume)
        .await?;
    Ok(api_success(json!({ "ip": ip, "volume": payload.volume })))
}

/// Gets the current mute state for a speaker.
///
/// For speakers in sync sessions (x-rincon joined), returns per-speaker mute state.
/// Otherwise returns group mute state.
async fn get_mute(
    Path(ip): Path<String>,
    State(state): State<AppState>,
) -> ThaumicResult<impl IntoResponse> {
    let mute = state
        .stream_coordinator
        .get_mute_routed(&*state.sonos, &ip)
        .await?;
    Ok(api_success(json!({ "ip": ip, "mute": mute })))
}

/// Sets the mute state for a speaker.
///
/// For speakers in sync sessions (x-rincon joined), uses per-speaker mute
/// to allow independent room control. Otherwise uses group mute.
async fn set_mute(
    Path(ip): Path<String>,
    State(state): State<AppState>,
    Json(payload): Json<MuteRequest>,
) -> ThaumicResult<impl IntoResponse> {
    state
        .stream_coordinator
        .set_mute_routed(&*state.sonos, &ip, payload.mute)
        .await?;
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

    let range_header = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    if let Some(ref range) = range_header {
        log::debug!(
            "[Stream] Range request: client={}, stream={}, codec={:?}, range='{}'",
            remote_ip,
            id,
            stream_state.codec,
            range
        );
    } else {
        log::info!(
            "[Stream] New connection: client={}, stream={}, codec={:?}",
            remote_ip,
            id,
            stream_state.codec
        );
    }

    // Detect resume: this specific IP had a previous HTTP connection.
    // Uses per-IP epoch tracking (not global counter) to avoid misclassifying
    // new speakers as resumes after the first speaker connects.
    let is_resume = stream_state.timing.current_epoch_for(remote_ip).is_some();

    // Upfront buffering delay for PCM streams BEFORE subscribing.
    // This lets the ring buffer accumulate more frames. Subscribing after
    // ensures the broadcast receiver doesn't fill up during the delay.
    // Delay matches streaming_buffer_ms so cadence queue starts full.
    //
    // SKIP on resume: Sonos closes the connection within milliseconds if we delay.
    // The buffer already has frames from before the pause, so no delay is needed.
    let prefill_delay_ms = stream_state.streaming_buffer_ms;
    if stream_state.codec == AudioCodec::Pcm && prefill_delay_ms > 0 && !is_resume {
        log::debug!(
            "[Stream] Applying {}ms prefill delay for PCM stream",
            prefill_delay_ms
        );
        tokio::time::sleep(Duration::from_millis(prefill_delay_ms)).await;
    } else if is_resume && stream_state.codec == AudioCodec::Pcm {
        log::info!(
            "[Stream] Skipping {}ms prefill delay on resume for {}",
            prefill_delay_ms,
            remote_ip
        );

        // Delegate playback control to coordinator (SoC: HTTP serves audio, coordinator controls playback).
        // Fire-and-forget: spawn so we don't block the HTTP response.
        let coordinator = Arc::clone(&state.stream_coordinator);
        let ip = remote_ip.to_string();
        tokio::spawn(async move {
            coordinator.on_http_resume(&ip).await;
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

    // Create logging guard early so we can pass it to the cadence stream for internal tracking.
    // Uses Arc so it can be shared between cadence stream and final frame recording.
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

    // Unwrap TaggedFrame to Bytes (silence tracking handled inside cadence stream)
    let unwrapped_stream = tracked_stream.map(|res| res.map(TaggedFrame::into_bytes));

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
