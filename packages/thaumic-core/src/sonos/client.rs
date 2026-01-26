//! High-level Sonos client commands.
//!
//! This module provides the public API for controlling Sonos speakers,
//! including playback control, volume/mute, and zone group topology.

use async_trait::async_trait;
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use reqwest::Client;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use crate::error::{DiscoveryResult, SoapResult};
use crate::protocol_constants::APP_NAME;
use crate::sonos::discovery::{DiscoveryConfig, DiscoveryCoordinator, Speaker};
use crate::sonos::services::SonosService;
use crate::sonos::soap::{SoapError, SoapRequestBuilder};
use crate::sonos::traits::{SonosDiscovery, SonosPlayback, SonosTopology, SonosVolumeControl};
use crate::sonos::types::{PositionInfo, ZoneGroup, ZoneGroupMember};
use crate::sonos::utils::{
    build_sonos_stream_uri, escape_xml, extract_ip_from_location, extract_model_from_icon,
    extract_xml_text, get_channel_role, get_xml_attr,
};
use crate::stream::{AudioCodec, AudioFormat, StreamMetadata};

// ─────────────────────────────────────────────────────────────────────────────
// Zone Groups
// ─────────────────────────────────────────────────────────────────────────────

/// Parses ZoneGroupState XML into a vector of ZoneGroup structures.
///
/// This function is shared between SOAP response parsing and GENA event handling
/// to avoid code duplication. It expects the raw ZoneGroupState XML (already unescaped).
///
/// # Filtering
/// - Zone Bridges (BOOST devices with `IsZoneBridge="1"`) are filtered out
///   as they cannot play audio.
/// - Groups containing only Zone Bridges are excluded entirely.
///
/// # Member Details
/// Each member includes:
/// - `uuid`: Unique identifier (RINCON_xxx format)
/// - `ip`: Local IP address
/// - `zone_name`: User-configured room name
/// - `model`: Device model or channel role (for home theater setups)
pub fn parse_zone_group_xml(xml: &str) -> Vec<ZoneGroup> {
    let mut groups = Vec::new();
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();

    // State for current group being parsed
    let mut current_coordinator_uuid: Option<String> = None;
    let mut current_group_id = String::new();
    let mut current_members: Vec<ZoneGroupMember> = Vec::new();
    let mut coordinator_ip: Option<String> = None;
    let mut coordinator_zone_name: Option<String> = None;
    let mut ht_sat_chan_map: Option<String> = None;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                match e.name().as_ref() {
                    b"ZoneGroup" => {
                        // Start of a new zone group - reset state
                        current_group_id = get_xml_attr(e, b"ID").unwrap_or_default();
                        current_coordinator_uuid = get_xml_attr(e, b"Coordinator");
                        current_members.clear();
                        coordinator_ip = None;
                        coordinator_zone_name = None;
                        ht_sat_chan_map = None;
                    }
                    b"ZoneGroupMember" | b"Satellite" => {
                        // Skip Zone Bridges - they can't play audio
                        if get_xml_attr(e, b"IsZoneBridge").as_deref() == Some("1") {
                            continue;
                        }

                        // Extract required attributes
                        let uuid = match get_xml_attr(e, b"UUID") {
                            Some(u) => u,
                            None => continue,
                        };

                        let location = match get_xml_attr(e, b"Location") {
                            Some(l) => l,
                            None => continue,
                        };

                        let ip = match extract_ip_from_location(&location) {
                            Some(i) => i,
                            None => continue,
                        };

                        let zone_name = match get_xml_attr(e, b"ZoneName") {
                            Some(z) => z,
                            None => continue,
                        };

                        // Check if this is the coordinator
                        let is_coordinator = current_coordinator_uuid.as_ref() == Some(&uuid);
                        if is_coordinator {
                            coordinator_ip = Some(ip.clone());
                            coordinator_zone_name = Some(zone_name.clone());
                            // Get HTSatChanMapSet from coordinator for channel roles
                            ht_sat_chan_map = get_xml_attr(e, b"HTSatChanMapSet");
                        }

                        // Determine model: prefer channel role, then icon, then fallback
                        let model = ht_sat_chan_map
                            .as_ref()
                            .and_then(|map| get_channel_role(map, &uuid))
                            .or_else(|| {
                                get_xml_attr(e, b"Icon")
                                    .map(|i| extract_model_from_icon(&i))
                                    .filter(|m| m != "unknown")
                            })
                            .unwrap_or_else(|| "Speaker".to_string());

                        current_members.push(ZoneGroupMember {
                            uuid,
                            ip,
                            zone_name,
                            model,
                        });
                    }
                    _ => {}
                }
            }
            Ok(Event::End(ref e)) if e.name().as_ref() == b"ZoneGroup" => {
                // End of zone group - finalize if we have valid data
                if let (Some(coord_uuid), Some(coord_ip)) =
                    (current_coordinator_uuid.take(), coordinator_ip.take())
                {
                    if !current_members.is_empty() {
                        // Use coordinator's zone name, or build from unique member names
                        let group_name = coordinator_zone_name.take().unwrap_or_else(|| {
                            let mut unique_names: Vec<&str> = Vec::new();
                            for m in &current_members {
                                if !unique_names.contains(&m.zone_name.as_str()) {
                                    unique_names.push(&m.zone_name);
                                }
                            }
                            unique_names.join(" + ")
                        });

                        groups.push(ZoneGroup {
                            id: current_group_id.clone(),
                            name: group_name,
                            coordinator_uuid: coord_uuid,
                            coordinator_ip: coord_ip,
                            members: std::mem::take(&mut current_members),
                        });
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                log::warn!("[Sonos] XML parse error in zone groups: {}", e);
                break;
            }
            _ => {}
        }
        buf.clear();
    }

    groups
}

/// Fetches the current zone groups from a Sonos speaker and parses the topology.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `ip` - IP address of any Sonos speaker on the network
///
/// # Returns
/// A vector of `ZoneGroup` representing the current topology
pub async fn get_zone_groups(client: &Client, ip: &str) -> SoapResult<Vec<ZoneGroup>> {
    let response = SoapRequestBuilder::new(client, ip)
        .service(SonosService::ZoneGroupTopology)
        .action("GetZoneGroupState")
        .send()
        .await?;

    // Extract and decode ZoneGroupState from SOAP response
    let Some(decoded_xml) = extract_xml_text(&response, "ZoneGroupState") else {
        return Ok(vec![]);
    };

    Ok(parse_zone_group_xml(&decoded_xml))
}

// ─────────────────────────────────────────────────────────────────────────────
// DIDL-Lite Metadata Formatting
// ─────────────────────────────────────────────────────────────────────────────

/// Formats DIDL-Lite metadata XML for Sonos display.
///
/// This creates the metadata structure that Sonos uses to display
/// track information (title, artist, album art) on the speaker's UI.
///
/// # Metadata Strategy
///
/// Since DIDL-Lite is only sent once at playback start (via SetAVTransportURI)
/// and ICY metadata only supports StreamTitle, we use static values for
/// album and artwork to prevent stale data:
///
/// - **Title**: Source name (e.g., "YouTube Music") - static, branded
/// - **Artist**: APP_NAME constant - static branding
/// - **Album**: "{source} • {APP_NAME}" for additional branding
/// - **Artwork**: Static app icon
///
/// The actual track info ("Artist - Title") comes from ICY StreamTitle which updates.
///
/// # Audio Format Attributes
///
/// The `<res>` element includes audio format attributes to help Sonos configure
/// playback correctly:
/// - `sampleFrequency`: Sample rate in Hz (e.g., 48000)
/// - `nrAudioChannels`: Number of channels (e.g., 2 for stereo)
/// - `bitsPerSample`: Bit depth (e.g., 16)
/// - `protocolInfo`: MIME type based on codec (audio/wav, audio/aac, etc.)
fn format_didl_lite(
    stream_url: &str,
    codec: AudioCodec,
    audio_format: &AudioFormat,
    metadata: Option<&StreamMetadata>,
    artwork_url: &str,
) -> String {
    // [DIAG] Log incoming metadata for debugging
    log::info!(
        "[DIDL] Incoming metadata: {:?}, codec={}, format={:?}",
        metadata.map(|m| format!(
            "title={:?}, artist={:?}, album={:?}, source={:?}",
            m.title, m.artist, m.album, m.source
        )),
        codec.as_str(),
        audio_format
    );

    // IMPORTANT: DIDL-Lite is sent once and never updates. ICY StreamTitle handles
    // dynamic track info ("Artist - Title"). To avoid duplication on Sonos display,
    // we use STATIC branded values here:
    //
    // Sonos displays:
    //   Line 1: ICY StreamTitle (dynamic, updates with each track)
    //   Line 2: DIDL-Lite dc:title (static, set once at playback start)
    //
    // So we set dc:title to "{source} • {APP_NAME}", not the song title.
    let title = match metadata.and_then(|m| m.source.as_deref()) {
        Some(source) => format!("{} • {}", source, APP_NAME),
        None => APP_NAME.to_string(),
    };
    let artist = APP_NAME;

    // Album also shows "{source} • {APP_NAME}" for consistency
    let album = title.clone();

    let mime_type = codec.mime_type();

    // [DIAG] Log what we're sending to Sonos
    log::info!(
        "[DIDL] Sending to Sonos: title={:?}, artist={:?}, album={:?}, mime={}, icon={:?}",
        title,
        artist,
        album,
        mime_type,
        artwork_url
    );

    let mut didl = String::from(
        r#"<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">"#,
    );
    didl.push_str(r#"<item id="0" parentID="-1" restricted="true">"#);
    didl.push_str(&format!("<dc:title>{}</dc:title>", escape_xml(&title)));
    didl.push_str(&format!("<dc:creator>{}</dc:creator>", escape_xml(artist)));

    // Always set album for consistent branding
    didl.push_str(&format!("<upnp:album>{}</upnp:album>", escape_xml(&album)));

    // Album art URL for Sonos display. Note: Android Sonos app requires HTTPS,
    // iOS works with HTTP. See: https://github.com/amp64/sonosbugtracker/issues/33
    didl.push_str(&format!(
        "<upnp:albumArtURI>{}</upnp:albumArtURI>",
        escape_xml(artwork_url)
    ));

    didl.push_str("<upnp:class>object.item.audioItem.audioBroadcast</upnp:class>");

    // Build <res> element with audio format attributes for proper Sonos configuration
    didl.push_str(&format!(
        r#"<res protocolInfo="http-get:*:{}:*" sampleFrequency="{}" nrAudioChannels="{}" bitsPerSample="{}">{}</res>"#,
        mime_type,
        audio_format.sample_rate,
        audio_format.channels,
        audio_format.bits_per_sample,
        escape_xml(stream_url)
    ));
    didl.push_str("</item>");
    didl.push_str("</DIDL-Lite>");

    didl
}

// ─────────────────────────────────────────────────────────────────────────────
// Playback Control
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Group Coordination
// ─────────────────────────────────────────────────────────────────────────────

/// Joins a speaker to a coordinator for synchronized playback.
///
/// This sets the speaker's AVTransport URI to point to the coordinator using
/// the x-rincon protocol, then sends a Play command to start playback. The
/// speaker becomes a "slave" that syncs its playback timing to the coordinator,
/// enabling synchronized multi-room audio.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `ip` - IP address of the speaker to join (will become a slave)
/// * `coordinator_uuid` - UUID of the coordinator speaker (RINCON_xxx format)
///
/// # Note
/// This creates a temporary group for streaming purposes and does not modify
/// the user's permanent Sonos group configuration.
pub async fn join_group(client: &Client, ip: &str, coordinator_uuid: &str) -> SoapResult<()> {
    let group_uri = format!("x-rincon:{}", coordinator_uuid);

    log::info!(
        "[Sonos] Joining {} to coordinator {} (uri: {})",
        ip,
        coordinator_uuid,
        group_uri
    );

    with_retry("SetAVTransportURI", || {
        SoapRequestBuilder::new(client, ip)
            .service(SonosService::AVTransport)
            .action("SetAVTransportURI")
            .instance_id()
            .arg("CurrentURI", &group_uri)
            .arg("CurrentURIMetaData", "")
            .send()
    })
    .await?;

    log::debug!(
        "[Sonos] SetAVTransportURI succeeded for {}, sending Play",
        ip
    );

    with_retry("Play", || {
        SoapRequestBuilder::new(client, ip)
            .service(SonosService::AVTransport)
            .action("Play")
            .instance_id()
            .arg("Speed", "1")
            .send()
    })
    .await?;

    log::debug!("[Sonos] Join group succeeded for {}", ip);

    Ok(())
}

/// Makes a speaker leave its current group and become standalone.
///
/// Uses the BecomeCoordinatorOfStandaloneGroup action to cleanly unjoin
/// the speaker from any group it's currently part of. After this call,
/// the speaker will be its own coordinator with no slaves.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `ip` - IP address of the speaker to unjoin
///
/// # Note
/// This is safe to call on speakers that are already standalone - the
/// action is idempotent.
pub async fn leave_group(client: &Client, ip: &str) -> SoapResult<()> {
    log::info!("[Sonos] Speaker {} leaving group (becoming standalone)", ip);

    SoapRequestBuilder::new(client, ip)
        .service(SonosService::AVTransport)
        .action("BecomeCoordinatorOfStandaloneGroup")
        .instance_id()
        .send()
        .await?;

    log::debug!("[Sonos] Leave group succeeded for {}", ip);

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Volume Control
// ─────────────────────────────────────────────────────────────────────────────

/// Gets the current group volume from the coordinator (0-100).
///
/// This returns the combined volume for all speakers in the group.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `coordinator_ip` - IP address of the group coordinator
pub async fn get_group_volume(client: &Client, coordinator_ip: &str) -> SoapResult<u8> {
    let response = SoapRequestBuilder::new(client, coordinator_ip)
        .service(SonosService::GroupRenderingControl)
        .action("GetGroupVolume")
        .instance_id()
        .send()
        .await?;

    let volume_str =
        extract_xml_text(&response, "CurrentVolume").ok_or_else(|| SoapError::Parse)?;

    volume_str.parse().map_err(|_| SoapError::Parse)
}

/// Sets the group volume on the coordinator (0-100).
///
/// This adjusts volume proportionally across all speakers in the group.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `coordinator_ip` - IP address of the group coordinator
/// * `volume` - Desired volume level (0-100, values > 100 are clamped)
pub async fn set_group_volume(client: &Client, coordinator_ip: &str, volume: u8) -> SoapResult<()> {
    let clamped = volume.min(100);

    SoapRequestBuilder::new(client, coordinator_ip)
        .service(SonosService::GroupRenderingControl)
        .action("SetGroupVolume")
        .instance_id()
        .arg("DesiredVolume", clamped.to_string())
        .send()
        .await?;

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Mute Control
// ─────────────────────────────────────────────────────────────────────────────

/// Gets the current group mute state from the coordinator.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `coordinator_ip` - IP address of the group coordinator
///
/// # Returns
/// `true` if the group is muted, `false` otherwise
pub async fn get_group_mute(client: &Client, coordinator_ip: &str) -> SoapResult<bool> {
    let response = SoapRequestBuilder::new(client, coordinator_ip)
        .service(SonosService::GroupRenderingControl)
        .action("GetGroupMute")
        .instance_id()
        .send()
        .await?;

    let mute_str = extract_xml_text(&response, "CurrentMute").ok_or_else(|| SoapError::Parse)?;

    Ok(mute_str == "1")
}

/// Sets the group mute state on the coordinator.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `coordinator_ip` - IP address of the group coordinator
/// * `mute` - `true` to mute, `false` to unmute
pub async fn set_group_mute(client: &Client, coordinator_ip: &str, mute: bool) -> SoapResult<()> {
    SoapRequestBuilder::new(client, coordinator_ip)
        .service(SonosService::GroupRenderingControl)
        .action("SetGroupMute")
        .instance_id()
        .arg("DesiredMute", if mute { "1" } else { "0" })
        .send()
        .await?;

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-Speaker Volume Control
// ─────────────────────────────────────────────────────────────────────────────

/// Gets the current volume from an individual speaker (0-100).
///
/// Uses the RenderingControl service to query a single speaker's volume,
/// independent of its group membership. This enables per-original-group
/// volume control during multi-group streaming.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `speaker_ip` - IP address of the speaker
pub async fn get_speaker_volume(client: &Client, speaker_ip: &str) -> SoapResult<u8> {
    let response = SoapRequestBuilder::new(client, speaker_ip)
        .service(SonosService::RenderingControl)
        .action("GetVolume")
        .instance_id()
        .arg("Channel", "Master")
        .send()
        .await?;

    let volume_str =
        extract_xml_text(&response, "CurrentVolume").ok_or_else(|| SoapError::Parse)?;

    volume_str.parse().map_err(|_| SoapError::Parse)
}

/// Sets the volume on an individual speaker (0-100).
///
/// Uses the RenderingControl service to control a single speaker's volume,
/// independent of its group membership. This enables per-original-group
/// volume control during multi-group streaming.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `speaker_ip` - IP address of the speaker
/// * `volume` - Desired volume level (0-100, values > 100 are clamped)
pub async fn set_speaker_volume(client: &Client, speaker_ip: &str, volume: u8) -> SoapResult<()> {
    let clamped = volume.min(100);

    SoapRequestBuilder::new(client, speaker_ip)
        .service(SonosService::RenderingControl)
        .action("SetVolume")
        .instance_id()
        .arg("Channel", "Master")
        .arg("DesiredVolume", clamped.to_string())
        .send()
        .await?;

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Position Info (for Latency Monitoring)
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Trait Implementation
// ─────────────────────────────────────────────────────────────────────────────

/// Concrete implementation of Sonos client traits.
///
/// This struct wraps the free functions in this module to provide
/// a testable, injectable interface for Sonos operations.
pub struct SonosClientImpl {
    /// HTTP client for Sonos communication.
    client: Client,
    /// Discovery coordinator (lazily initialized).
    discovery_coordinator: OnceLock<Arc<DiscoveryCoordinator>>,
    /// Discovery configuration.
    discovery_config: DiscoveryConfig,
}

impl std::fmt::Debug for SonosClientImpl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SonosClientImpl")
            .field("client", &"Client")
            .field("discovery_config", &self.discovery_config)
            .finish()
    }
}

impl Clone for SonosClientImpl {
    fn clone(&self) -> Self {
        Self {
            client: self.client.clone(),
            discovery_coordinator: OnceLock::new(),
            discovery_config: self.discovery_config.clone(),
        }
    }
}

impl SonosClientImpl {
    /// Creates a new SonosClientImpl with the given HTTP client.
    ///
    /// # Arguments
    /// * `client` - The HTTP client to use for all Sonos communication
    #[must_use]
    pub fn new(client: Client) -> Self {
        Self {
            client,
            discovery_coordinator: OnceLock::new(),
            discovery_config: DiscoveryConfig::default(),
        }
    }

    /// Creates a new SonosClientImpl with custom discovery configuration.
    ///
    /// # Arguments
    /// * `client` - The HTTP client to use for all Sonos communication
    /// * `discovery_config` - Configuration for discovery methods
    #[must_use]
    #[allow(dead_code)]
    pub fn with_discovery_config(client: Client, discovery_config: DiscoveryConfig) -> Self {
        Self {
            client,
            discovery_coordinator: OnceLock::new(),
            discovery_config,
        }
    }

    /// Gets or creates the discovery coordinator.
    fn get_discovery_coordinator(&self) -> &Arc<DiscoveryCoordinator> {
        self.discovery_coordinator
            .get_or_init(|| Arc::new(DiscoveryCoordinator::new(self.discovery_config.clone())))
    }
}

#[async_trait]
impl SonosPlayback for SonosClientImpl {
    async fn play_uri(
        &self,
        ip: &str,
        uri: &str,
        codec: AudioCodec,
        audio_format: &AudioFormat,
        metadata: Option<&StreamMetadata>,
        artwork_url: &str,
    ) -> SoapResult<()> {
        play_uri(
            &self.client,
            ip,
            uri,
            codec,
            audio_format,
            metadata,
            artwork_url,
        )
        .await
    }

    async fn play(&self, ip: &str) -> SoapResult<()> {
        play(&self.client, ip).await
    }

    async fn stop(&self, ip: &str) -> SoapResult<()> {
        stop(&self.client, ip).await
    }

    async fn switch_to_queue(&self, ip: &str, coordinator_uuid: &str) -> SoapResult<()> {
        switch_to_queue(&self.client, ip, coordinator_uuid).await
    }

    async fn get_position_info(&self, ip: &str) -> SoapResult<PositionInfo> {
        get_position_info(&self.client, ip).await
    }

    async fn join_group(&self, ip: &str, coordinator_uuid: &str) -> SoapResult<()> {
        join_group(&self.client, ip, coordinator_uuid).await
    }

    async fn leave_group(&self, ip: &str) -> SoapResult<()> {
        leave_group(&self.client, ip).await
    }
}

#[async_trait]
impl SonosTopology for SonosClientImpl {
    async fn get_zone_groups(&self, ip: &str) -> SoapResult<Vec<ZoneGroup>> {
        get_zone_groups(&self.client, ip).await
    }
}

#[async_trait]
impl SonosVolumeControl for SonosClientImpl {
    async fn get_group_volume(&self, coordinator_ip: &str) -> SoapResult<u8> {
        get_group_volume(&self.client, coordinator_ip).await
    }

    async fn set_group_volume(&self, coordinator_ip: &str, volume: u8) -> SoapResult<()> {
        set_group_volume(&self.client, coordinator_ip, volume).await
    }

    async fn get_group_mute(&self, coordinator_ip: &str) -> SoapResult<bool> {
        get_group_mute(&self.client, coordinator_ip).await
    }

    async fn set_group_mute(&self, coordinator_ip: &str, mute: bool) -> SoapResult<()> {
        set_group_mute(&self.client, coordinator_ip, mute).await
    }

    async fn get_speaker_volume(&self, speaker_ip: &str) -> SoapResult<u8> {
        get_speaker_volume(&self.client, speaker_ip).await
    }

    async fn set_speaker_volume(&self, speaker_ip: &str, volume: u8) -> SoapResult<()> {
        set_speaker_volume(&self.client, speaker_ip, volume).await
    }
}

#[async_trait]
impl SonosDiscovery for SonosClientImpl {
    async fn discover_speakers(&self) -> DiscoveryResult<Vec<Speaker>> {
        self.get_discovery_coordinator().discover_speakers().await
    }
}
