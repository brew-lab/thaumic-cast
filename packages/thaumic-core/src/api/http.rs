//! HTTP route handlers.
//!
//! All handlers are thin - they delegate to services for business logic.
//! The latency-critical streaming handler lives in [`super::stream`].

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

use axum::{
    body::Body,
    extract::{connect_info::ConnectInfo, Path, State},
    http::{header, HeaderMap, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;

use super::stream::stream_audio;
use crate::api::response::{api_error, api_ok, api_success};
use crate::api::ws::ws_handler;
use crate::api::AppState;
use crate::error::{ErrorCode, ThaumicError, ThaumicResult};
use crate::protocol_constants::{MAX_GENA_BODY_SIZE, SERVICE_ID};
use crate::sonos::discovery::probe_speaker_by_ip;
use crate::state::ManualSpeakerConfig;
use crate::utils::validate_speaker_ip;

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
