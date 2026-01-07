//! HTTP route handlers.
//!
//! All handlers are thin - they delegate to services for business logic.

use axum::{
    body::Body,
    extract::{connect_info::ConnectInfo, Path, State},
    http::{header, HeaderMap, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Json, Router,
};
use bytes::Bytes;
use futures::stream::StreamExt;
use serde::Deserialize;
use serde_json::json;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Instant;
use tokio_stream::wrappers::BroadcastStream;

use crate::api::response::{api_error, api_ok, api_success};
use crate::api::ws::ws_handler;
use crate::api::AppState;
use crate::config::{
    DEFAULT_CHANNELS, DEFAULT_SAMPLE_RATE, MAX_CONCURRENT_STREAMS, MAX_GENA_BODY_SIZE,
};
use crate::error::{ThaumicError, ThaumicResult};
use crate::stream::{create_wav_header, AudioCodec, IcyMetadataInjector, ICY_METAINT};

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
        .route("/api/speakers/:ip/volume", get(get_volume).post(set_volume))
        .route("/api/speakers/:ip/mute", get(get_mute).post(set_mute))
        .route("/api/sonos/notify", any(handle_gena_notify))
        .route("/stream/:id/live", get(stream_audio))
        .route("/stream/:id/live.wav", get(stream_audio))
        .route("/stream/:id/live.flac", get(stream_audio))
        .route("/icon.png", get(serve_icon))
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
async fn health_check() -> impl IntoResponse {
    api_success(json!({
        "status": "ok",
        "service": "thaumic-cast-desktop",
        "limits": {
            "maxStreams": MAX_CONCURRENT_STREAMS
        }
    }))
}

/// Serves the static app icon for Sonos album art display.
///
/// Returns a 512x512 PNG image embedded at compile time.
/// Sonos requires at least 480x480 for reliable album art display.
async fn serve_icon() -> Response {
    static ICON: &'static [u8] = include_bytes!("../../icons/icon.png");
    Response::builder()
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::CONTENT_LENGTH, ICON.len())
        .header(header::CACHE_CONTROL, "public, max-age=86400")
        .body(Body::from(ICON))
        .unwrap()
}

/// Readiness probe: "Can the service handle requests?"
///
/// Returns 200 OK only when:
/// - Server port has been assigned (listening)
/// - Local IP has been detected (can build stream URLs)
///
/// Returns 503 Service Unavailable with details when not ready.
async fn readiness_check(State(state): State<AppState>) -> Response {
    let port = state.services.network.get_port();
    let local_ip = state.services.network.local_ip.read().clone();
    let has_groups = !state.services.sonos_state.groups.read().is_empty();

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
    match state.services.sonos.discover_speakers().await {
        Ok(speakers) => api_success(json!({ "speakers": speakers })).into_response(),
        Err(e) => {
            api_error(StatusCode::INTERNAL_SERVER_ERROR, "discovery_failed", e).into_response()
        }
    }
}

async fn list_groups(State(state): State<AppState>) -> impl IntoResponse {
    let groups = state.services.sonos_state.groups.read().clone();
    api_success(json!({ "groups": groups }))
}

/// Returns current system state (groups, transport states, volumes, mute states).
async fn get_current_state(State(state): State<AppState>) -> impl IntoResponse {
    api_success(state.services.sonos_state.to_json())
}

/// Triggers a manual topology refresh.
async fn handle_refresh(State(state): State<AppState>) -> impl IntoResponse {
    state.services.discovery_service.trigger_refresh();
    api_ok()
}

async fn handle_start_playback(
    State(state): State<AppState>,
    Json(payload): Json<PlaybackRequest>,
) -> ThaumicResult<impl IntoResponse> {
    state
        .services
        .stream_coordinator
        .start_playback(&payload.ip, &payload.stream_id, None)
        .await?;

    Ok(api_ok())
}

// ─────────────────────────────────────────────────────────────────────────────
// Volume/Mute Handlers
// ─────────────────────────────────────────────────────────────────────────────

/// Gets the current group volume for a speaker.
async fn get_volume(
    Path(ip): Path<String>,
    State(state): State<AppState>,
) -> ThaumicResult<impl IntoResponse> {
    let volume = state.services.sonos.get_group_volume(&ip).await?;
    Ok(api_success(json!({ "ip": ip, "volume": volume })))
}

/// Sets the group volume for a speaker.
async fn set_volume(
    Path(ip): Path<String>,
    State(state): State<AppState>,
    Json(payload): Json<VolumeRequest>,
) -> ThaumicResult<impl IntoResponse> {
    state
        .services
        .sonos
        .set_group_volume(&ip, payload.volume)
        .await?;
    Ok(api_success(json!({ "ip": ip, "volume": payload.volume })))
}

/// Gets the current group mute state for a speaker.
async fn get_mute(
    Path(ip): Path<String>,
    State(state): State<AppState>,
) -> ThaumicResult<impl IntoResponse> {
    let mute = state.services.sonos.get_group_mute(&ip).await?;
    Ok(api_success(json!({ "ip": ip, "mute": mute })))
}

/// Sets the group mute state for a speaker.
async fn set_mute(
    Path(ip): Path<String>,
    State(state): State<AppState>,
    Json(payload): Json<MuteRequest>,
) -> ThaumicResult<impl IntoResponse> {
    state
        .services
        .sonos
        .set_group_mute(&ip, payload.mute)
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
        .services
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
        .services
        .stream_coordinator
        .get_stream(&id)
        .ok_or_else(|| ThaumicError::StreamNotFound(id.clone()))?;

    // For WAV streams, ignore Range requests and restart from current live position.
    // When Sonos pauses and resumes a WAV "track", it sends a Range header expecting
    // to resume from the paused byte position. Since we're streaming live audio,
    // we ignore the Range and return 200 with fresh audio (effectively a restart).
    // This is valid HTTP behavior - servers that don't support Range can respond 200.
    // See: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests
    if stream_state.codec == AudioCodec::Wav {
        if let Some(range) = headers.get(header::RANGE) {
            log::info!(
                "[Stream] Ignoring Range request for WAV stream {} (live stream, restarting): {:?}",
                id,
                range
            );
        }
    }

    let connected_at = Instant::now();
    let remote_ip = remote_addr.ip();

    // Subscribe to get epoch candidate, prefill frames, and live receiver
    let (epoch_candidate, prefill_frames, rx) = stream_state.subscribe();

    log::debug!(
        "[Stream] Client {} connected to stream {}, sending {} prefill frames",
        remote_ip,
        id,
        prefill_frames.len()
    );

    // Create streams for prefill and live data
    let prefill_stream =
        futures::stream::iter(prefill_frames.into_iter().map(Ok::<Bytes, std::io::Error>));
    let live_stream =
        BroadcastStream::new(rx).map(|res| res.map_err(|e| std::io::Error::other(e.to_string())));

    // Chain prefill frames before live stream
    let combined_stream = prefill_stream.chain(live_stream);

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

    let tracked_stream = combined_stream.scan(hook_state, |state, item| {
        if let Some((stream_state, epoch_candidate, connected_at, remote_ip)) = state.take() {
            // Only fire on a real, non-empty audio chunk
            if let Ok(ref chunk) = item {
                if !chunk.is_empty() {
                    let first_audio_polled_at = Instant::now();
                    stream_state.timing.start_new_epoch(
                        epoch_candidate,
                        connected_at,
                        first_audio_polled_at,
                        remote_ip,
                    );
                } else {
                    // Empty chunk - don't burn the hook, try again
                    *state = Some((stream_state, epoch_candidate, connected_at, remote_ip));
                }
            } else {
                // Error on first item - don't burn the hook, try again
                *state = Some((stream_state, epoch_candidate, connected_at, remote_ip));
            }
        }
        futures::future::ready(Some(item))
    });

    // Content-Type based on output codec
    let content_type = match stream_state.codec {
        AudioCodec::Wav => "audio/wav",
        AudioCodec::Aac => "audio/aac",
        AudioCodec::Mp3 => "audio/mpeg",
        AudioCodec::Flac => "audio/flac",
    };

    // ICY metadata only supported for MP3/AAC streams (not WAV/FLAC)
    let supports_icy = matches!(stream_state.codec, AudioCodec::Mp3 | AudioCodec::Aac);
    let wants_icy =
        supports_icy && headers.get("icy-metadata").and_then(|v| v.to_str().ok()) == Some("1");

    let mut builder = Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive");

    // Tell Sonos that WAV streams don't support seeking (live stream)
    if stream_state.codec == AudioCodec::Wav {
        builder = builder.header("Accept-Ranges", "none");
    }

    if wants_icy {
        builder = builder.header("icy-metaint", ICY_METAINT.to_string());
    }

    // Apply ICY injection or WAV header to the tracked stream (after epoch hook)
    let final_stream: AudioStream = if wants_icy {
        let stream_ref = Arc::clone(&stream_state);
        let mut injector = IcyMetadataInjector::new();

        Box::pin(tracked_stream.map(move |res| {
            let chunk = res?;
            let metadata = stream_ref.metadata.read();
            Ok::<Bytes, std::io::Error>(injector.inject(chunk.as_ref(), &metadata))
        }))
    } else if stream_state.codec == AudioCodec::Wav {
        // WAV streams need header prepended per-connection (Sonos may reconnect)
        let wav_header = create_wav_header(DEFAULT_SAMPLE_RATE, DEFAULT_CHANNELS);
        Box::pin(futures::stream::once(async move { Ok(wav_header) }).chain(tracked_stream))
    } else {
        Box::pin(tracked_stream)
    };

    builder
        .body(Body::from_stream(final_stream))
        .map_err(|e| ThaumicError::Internal(e.to_string()))
}
