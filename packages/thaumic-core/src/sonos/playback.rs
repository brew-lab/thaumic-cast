//! Playback control commands for Sonos speakers.
//!
//! Provides play, stop, and transport control via AVTransport SOAP actions,
//! including retry logic for transient SOAP errors.

use reqwest::Client;
use std::time::Duration;

use crate::error::SoapResult;
use crate::sonos::didl::format_didl_lite;
use crate::sonos::services::SonosService;
use crate::sonos::soap::{SoapError, SoapRequestBuilder};
use crate::sonos::types::PositionInfo;
use crate::sonos::utils::{build_sonos_stream_uri, extract_xml_text};
use crate::stream::{AudioCodec, AudioFormat, StreamMetadata};

/// Retry delays for transient SOAP errors (exponential backoff).
const RETRY_DELAYS_MS: [u64; 3] = [200, 500, 1000];

/// Executes a SOAP request with retry logic for transient errors.
///
/// Retries on transient SOAP faults (701, 714, 716) and timeouts with
/// exponential backoff (200ms, 500ms, 1000ms).
///
/// # Arguments
/// * `action` - Action name for logging
/// * `operation` - Closure that performs the SOAP request
async fn with_retry<F, Fut>(action: &str, mut operation: F) -> SoapResult<String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = SoapResult<String>>,
{
    let mut last_error = None;
    for (attempt, &delay_ms) in std::iter::once(&0)
        .chain(RETRY_DELAYS_MS.iter())
        .enumerate()
    {
        if attempt > 0 {
            log::info!(
                "[Sonos] Retrying {} (attempt {}/{}) after {}ms",
                action,
                attempt + 1,
                RETRY_DELAYS_MS.len() + 1,
                delay_ms
            );
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        }

        match operation().await {
            Ok(r) => return Ok(r),
            Err(e) if e.is_transient() => {
                log::warn!("[Sonos] {} transient error: {}", action, e);
                last_error = Some(e);
            }
            Err(e) => return Err(e),
        }
    }

    Err(last_error.expect("retry loop should have set last_error"))
}

/// Commands a Sonos speaker to play a specific audio URI.
///
/// Optionally includes metadata for display on the Sonos UI.
/// Retries transient SOAP faults (701, 714, 716) with exponential backoff.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `ip` - IP address of the Sonos speaker (coordinator for grouped speakers)
/// * `uri` - The audio stream URL to play
/// * `codec` - The audio codec for proper URI formatting and DIDL-Lite metadata
/// * `audio_format` - Audio format configuration (sample rate, channels, bit depth)
/// * `metadata` - Optional stream metadata for display (title, artist, source)
/// * `artwork_url` - URL to the static app icon for album art display
pub async fn play_uri(
    client: &Client,
    ip: &str,
    uri: &str,
    codec: AudioCodec,
    audio_format: &AudioFormat,
    metadata: Option<&StreamMetadata>,
    artwork_url: &str,
) -> SoapResult<()> {
    // Build Sonos-compatible URI with proper scheme and extension for codec
    let sonos_uri = build_sonos_stream_uri(uri, codec);
    let didl_metadata = format_didl_lite(uri, codec, audio_format, metadata, artwork_url);

    log::info!("[Sonos] SetAVTransportURI: ip={}, uri={}", ip, sonos_uri);

    with_retry("SetAVTransportURI", || {
        SoapRequestBuilder::new(client, ip)
            .service(SonosService::AVTransport)
            .action("SetAVTransportURI")
            .instance_id()
            .arg("CurrentURI", &sonos_uri)
            .arg("CurrentURIMetaData", &didl_metadata)
            .send()
    })
    .await?;

    log::info!("[Sonos] SetAVTransportURI succeeded, sending Play command");

    with_retry("Play", || {
        SoapRequestBuilder::new(client, ip)
            .service(SonosService::AVTransport)
            .action("Play")
            .instance_id()
            .arg("Speed", "1")
            .send()
    })
    .await?;

    log::info!("[Sonos] Play command succeeded");

    Ok(())
}

/// Sends a Play command to resume playback on a Sonos speaker.
///
/// Unlike `play_uri`, this does NOT set the URI - it assumes the transport is
/// already configured. Use this to resume a paused stream.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `ip` - IP address of the Sonos speaker (coordinator for grouped speakers)
pub async fn play(client: &Client, ip: &str) -> SoapResult<()> {
    log::info!("[Sonos] Sending Play command to {}", ip);

    with_retry("Play", || {
        SoapRequestBuilder::new(client, ip)
            .service(SonosService::AVTransport)
            .action("Play")
            .instance_id()
            .arg("Speed", "1")
            .send()
    })
    .await?;

    log::info!("[Sonos] Play command succeeded for {}", ip);
    Ok(())
}

/// Stops playback on a Sonos speaker.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `ip` - IP address of the Sonos speaker (coordinator for grouped speakers)
///
/// # Note
/// This function handles the "already stopped" case gracefully by ignoring
/// SOAP faults with error code 701.
pub async fn stop(client: &Client, ip: &str) -> SoapResult<()> {
    let result = SoapRequestBuilder::new(client, ip)
        .service(SonosService::AVTransport)
        .action("Stop")
        .instance_id()
        .send()
        .await;

    match result {
        Ok(_) => Ok(()),
        Err(SoapError::Fault(msg)) if msg.contains("701") => {
            // Error 701 means "transition not available" - speaker is already stopped
            log::debug!(
                "[Sonos] Stop: Speaker {} may already be stopped (ignoring 701)",
                ip
            );
            Ok(())
        }
        Err(e) => Err(e),
    }
}

/// Switches a Sonos speaker's source to its queue.
///
/// This sets the AVTransport URI to the speaker's internal queue, effectively
/// clearing any external stream source. Used after stopping playback to ensure
/// the Sonos app doesn't show a stale stream.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `ip` - IP address of the Sonos speaker (coordinator for grouped speakers)
/// * `coordinator_uuid` - The speaker's RINCON_xxx UUID for building the queue URI
pub async fn switch_to_queue(client: &Client, ip: &str, coordinator_uuid: &str) -> SoapResult<()> {
    let queue_uri = format!("x-rincon-queue:{}#0", coordinator_uuid);

    log::info!(
        "[Sonos] Switching {} to queue (uuid: {})",
        ip,
        coordinator_uuid
    );

    SoapRequestBuilder::new(client, ip)
        .service(SonosService::AVTransport)
        .action("SetAVTransportURI")
        .instance_id()
        .arg("CurrentURI", &queue_uri)
        .arg("CurrentURIMetaData", "")
        .send()
        .await?;

    log::debug!("[Sonos] Switched to queue successfully");

    Ok(())
}

/// Gets the current playback position from a Sonos speaker.
///
/// This queries the AVTransport service for position information, which is
/// used by the latency monitor to calculate the delay between audio source
/// and speaker playback.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `ip` - IP address of the Sonos speaker (coordinator for grouped speakers)
///
/// # Returns
/// Position information including track number, duration, URI, and elapsed time.
///
/// # Note
/// The `RelTime` field is in "H:MM:SS" format with second precision. For streams,
/// this represents elapsed playback time since the stream started.
pub async fn get_position_info(client: &Client, ip: &str) -> SoapResult<PositionInfo> {
    let response = SoapRequestBuilder::new(client, ip)
        .service(SonosService::AVTransport)
        .action("GetPositionInfo")
        .instance_id()
        .send()
        .await?;

    // Extract fields from response
    let track = extract_xml_text(&response, "Track")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let track_duration = extract_xml_text(&response, "TrackDuration").unwrap_or_default();
    let track_uri = extract_xml_text(&response, "TrackURI").unwrap_or_default();
    let rel_time = extract_xml_text(&response, "RelTime").unwrap_or_else(|| "0:00:00".to_string());

    // Parse RelTime to milliseconds
    let rel_time_ms = PositionInfo::parse_time_to_ms(&rel_time);

    Ok(PositionInfo {
        track,
        track_duration,
        track_uri,
        rel_time,
        rel_time_ms,
    })
}
