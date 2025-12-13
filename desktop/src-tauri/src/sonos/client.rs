use super::soap::{extract_soap_value, send_soap_request, unescape_xml, SoapError};
use super::ssdp::{discover as ssdp_discover, DiscoveredSpeaker, SsdpError};
use parking_lot::RwLock;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use thiserror::Error;

// Service URNs
const ZONE_GROUP_TOPOLOGY: &str = "urn:schemas-upnp-org:service:ZoneGroupTopology:1";
const AV_TRANSPORT: &str = "urn:schemas-upnp-org:service:AVTransport:1";
const RENDERING_CONTROL: &str = "urn:schemas-upnp-org:service:RenderingControl:1";

// Control URLs
const ZONE_GROUP_CONTROL: &str = "/ZoneGroupTopology/Control";
const AV_TRANSPORT_CONTROL: &str = "/MediaRenderer/AVTransport/Control";
const RENDERING_CONTROL_URL: &str = "/MediaRenderer/RenderingControl/Control";

// Cache settings
const CACHE_TTL: Duration = Duration::from_secs(60);

#[derive(Debug, Error)]
pub enum SonosError {
    #[error("SSDP discovery error: {0}")]
    Ssdp(#[from] SsdpError),
    #[error("SOAP error: {0}")]
    Soap(#[from] SoapError),
    #[error("No speakers found on network")]
    NoSpeakersFound,
    #[error("Failed to parse response: {0}")]
    ParseError(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct Speaker {
    pub uuid: String,
    pub ip: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalSpeaker {
    pub uuid: String,
    pub ip: String,
    #[serde(rename = "zoneName")]
    pub zone_name: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalGroup {
    pub id: String,
    pub name: String,
    #[serde(rename = "coordinatorUuid")]
    pub coordinator_uuid: String,
    #[serde(rename = "coordinatorIp")]
    pub coordinator_ip: String,
    pub members: Vec<LocalSpeaker>,
}

/// Stream metadata for Sonos display
#[derive(Debug, Clone, Default, Deserialize)]
pub struct StreamMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub artwork: Option<String>,
}

/// Escape XML special characters
fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Format DIDL-Lite metadata for Sonos display
fn format_didl_lite(stream_url: &str, metadata: Option<&StreamMetadata>) -> String {
    let title = metadata
        .and_then(|m| m.title.as_deref())
        .unwrap_or("Browser Audio");
    let artist = metadata
        .and_then(|m| m.artist.as_deref())
        .unwrap_or("Thaumic Cast");
    let album = metadata.and_then(|m| m.album.as_deref());
    let artwork = metadata.and_then(|m| m.artwork.as_deref());

    let mut didl = String::from(r#"<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">"#);
    didl.push_str(r#"<item id="0" parentID="-1" restricted="true">"#);
    didl.push_str(&format!("<dc:title>{}</dc:title>", escape_xml(title)));
    didl.push_str(&format!("<dc:creator>{}</dc:creator>", escape_xml(artist)));
    if let Some(album) = album {
        didl.push_str(&format!("<upnp:album>{}</upnp:album>", escape_xml(album)));
    }
    if let Some(artwork) = artwork {
        didl.push_str(&format!(
            "<upnp:albumArtURI>{}</upnp:albumArtURI>",
            escape_xml(artwork)
        ));
    }
    didl.push_str("<upnp:class>object.item.audioItem.audioBroadcast</upnp:class>");
    // Use audio/* to allow Sonos to auto-detect format (supports MP3, AAC-LC, HE-AAC)
    didl.push_str(&format!(
        r#"<res protocolInfo="http-get:*:audio/*:*">{}</res>"#,
        escape_xml(stream_url)
    ));
    didl.push_str("</item>");
    didl.push_str("</DIDL-Lite>");

    didl
}

// Cached speakers
struct SpeakerCache {
    speakers: Vec<DiscoveredSpeaker>,
    last_update: Instant,
}

static SPEAKER_CACHE: OnceLock<RwLock<Option<SpeakerCache>>> = OnceLock::new();
static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

fn get_cache() -> &'static RwLock<Option<SpeakerCache>> {
    SPEAKER_CACHE.get_or_init(|| RwLock::new(None))
}

fn get_client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("Failed to create HTTP client")
    })
}

/// Discover Sonos speakers with caching
pub async fn discover_speakers(force_refresh: bool) -> Result<Vec<Speaker>, SonosError> {
    let cache = get_cache();

    // Check cache (unless force refresh)
    if !force_refresh {
        let cache_read = cache.read();
        if let Some(ref cached) = *cache_read {
            if cached.last_update.elapsed() < CACHE_TTL {
                tracing::debug!("Using cached speakers");
                return Ok(cached
                    .speakers
                    .iter()
                    .map(|s| Speaker {
                        uuid: s.uuid.clone(),
                        ip: s.ip.clone(),
                    })
                    .collect());
            }
        }
    }

    // Run discovery in blocking task (uses UDP)
    tracing::info!("Running SSDP discovery...");
    let speakers = tokio::task::spawn_blocking(|| ssdp_discover(3000)).await.unwrap()?;

    tracing::info!("Found {} speakers", speakers.len());

    // Update cache
    {
        let mut cache_write = cache.write();
        *cache_write = Some(SpeakerCache {
            speakers: speakers.clone(),
            last_update: Instant::now(),
        });
    }

    Ok(speakers
        .into_iter()
        .map(|s| Speaker {
            uuid: s.uuid,
            ip: s.ip,
        })
        .collect())
}

/// Parse ZoneGroupState XML to extract groups and members
fn parse_zone_group_state(xml: &str) -> Vec<LocalGroup> {
    let mut groups = Vec::new();
    let unescaped_xml = unescape_xml(xml);

    // Match ZoneGroup elements
    let group_re =
        regex_lite::Regex::new(r#"<ZoneGroup\s+Coordinator="([^"]+)"[^>]*>([\s\S]*?)</ZoneGroup>"#)
            .unwrap();

    for group_cap in group_re.captures_iter(&unescaped_xml) {
        let coordinator_uuid = group_cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let group_content = group_cap.get(2).map(|m| m.as_str()).unwrap_or("");

        if coordinator_uuid.is_empty() || group_content.is_empty() {
            continue;
        }

        // Match ZoneGroupMember elements - capture the opening tag with all attributes
        // Handles both self-closing and elements with nested content (like Satellites)
        let member_re = regex_lite::Regex::new(
            r#"<ZoneGroupMember\s+([^>]+)>"#
        ).unwrap();

        let mut members = Vec::new();
        let mut coordinator_ip = String::new();

        for member_cap in member_re.captures_iter(group_content) {
            let attrs = member_cap.get(1).map(|m| m.as_str()).unwrap_or("");

            // Skip zone bridges (BOOST devices) - they can't play audio
            if attrs.contains("IsZoneBridge=\"1\"") {
                continue;
            }

            // Skip invisible devices that aren't the coordinator
            // (satellites are invisible but we still want the main speaker)

            // Extract attributes using individual regex
            let uuid = regex_lite::Regex::new(r#"UUID="([^"]+)""#)
                .ok()
                .and_then(|re| re.captures(attrs))
                .and_then(|c| c.get(1))
                .map(|m| m.as_str())
                .unwrap_or("");

            let ip = regex_lite::Regex::new(r#"Location="http://([^:]+):\d+"#)
                .ok()
                .and_then(|re| re.captures(attrs))
                .and_then(|c| c.get(1))
                .map(|m| m.as_str())
                .unwrap_or("");

            let zone_name = regex_lite::Regex::new(r#"ZoneName="([^"]+)""#)
                .ok()
                .and_then(|re| re.captures(attrs))
                .and_then(|c| c.get(1))
                .map(|m| m.as_str())
                .unwrap_or("");

            let model = regex_lite::Regex::new(r#"Icon="[^"]*sonos-([^-"]+)"#)
                .ok()
                .and_then(|re| re.captures(attrs))
                .and_then(|c| c.get(1))
                .map(|m| m.as_str())
                .unwrap_or("Unknown");

            if uuid.is_empty() || ip.is_empty() || zone_name.is_empty() {
                continue;
            }

            members.push(LocalSpeaker {
                uuid: uuid.to_string(),
                ip: ip.to_string(),
                zone_name: zone_name.to_string(),
                model: model.to_string(),
            });

            if uuid == coordinator_uuid {
                coordinator_ip = ip.to_string();
            }
        }

        if !members.is_empty() && !coordinator_ip.is_empty() {
            let group_name = members
                .iter()
                .map(|m| m.zone_name.as_str())
                .collect::<Vec<_>>()
                .join(" + ");

            groups.push(LocalGroup {
                id: coordinator_uuid.to_string(),
                name: group_name,
                coordinator_uuid: coordinator_uuid.to_string(),
                coordinator_ip,
                members,
            });
        }
    }

    groups
}

/// Get zone groups from a Sonos speaker
pub async fn get_zone_groups(speaker_ip: Option<&str>) -> Result<Vec<LocalGroup>, SonosError> {
    let ip = match speaker_ip {
        Some(ip) => ip.to_string(),
        None => {
            // Use cached speakers if available
            let speakers = discover_speakers(false).await?;
            speakers
                .first()
                .ok_or(SonosError::NoSpeakersFound)?
                .ip
                .clone()
        }
    };

    let params = HashMap::new();
    let response = send_soap_request(
        get_client(),
        &ip,
        ZONE_GROUP_CONTROL,
        ZONE_GROUP_TOPOLOGY,
        "GetZoneGroupState",
        params,
    )
    .await?;

    let zone_group_state = extract_soap_value(&response, "ZoneGroupState")
        .ok_or_else(|| SonosError::ParseError("Failed to get ZoneGroupState".to_string()))?;

    Ok(parse_zone_group_state(&zone_group_state))
}

/// Set the audio stream URL on a Sonos group coordinator
pub async fn set_av_transport_uri(
    coordinator_ip: &str,
    stream_url: &str,
    metadata: Option<&StreamMetadata>,
) -> Result<(), SonosError> {
    // Convert http:// to x-rincon-mp3radio:// for Sonos compatibility
    let sonos_url = if stream_url.starts_with("https://") {
        stream_url.replace("https://", "x-rincon-mp3radio://")
    } else {
        stream_url.replace("http://", "x-rincon-mp3radio://")
    };

    // Format DIDL-Lite metadata for Sonos display
    let didl_metadata = format_didl_lite(stream_url, metadata);

    tracing::info!("SetAVTransportURI: {}", sonos_url);

    let mut params = HashMap::new();
    params.insert("InstanceID".to_string(), "0".to_string());
    params.insert("CurrentURI".to_string(), sonos_url);
    params.insert("CurrentURIMetaData".to_string(), didl_metadata);

    send_soap_request(
        get_client(),
        coordinator_ip,
        AV_TRANSPORT_CONTROL,
        AV_TRANSPORT,
        "SetAVTransportURI",
        params,
    )
    .await?;

    Ok(())
}

/// Start playback on a Sonos group
pub async fn play(coordinator_ip: &str) -> Result<(), SonosError> {
    tracing::info!("Play on {}", coordinator_ip);

    let mut params = HashMap::new();
    params.insert("InstanceID".to_string(), "0".to_string());
    params.insert("Speed".to_string(), "1".to_string());

    send_soap_request(
        get_client(),
        coordinator_ip,
        AV_TRANSPORT_CONTROL,
        AV_TRANSPORT,
        "Play",
        params,
    )
    .await?;

    Ok(())
}

/// Stop playback on a Sonos group
pub async fn stop(coordinator_ip: &str) -> Result<(), SonosError> {
    tracing::info!("Stop on {}", coordinator_ip);

    let mut params = HashMap::new();
    params.insert("InstanceID".to_string(), "0".to_string());

    // Ignore error 701 (already stopped)
    match send_soap_request(
        get_client(),
        coordinator_ip,
        AV_TRANSPORT_CONTROL,
        AV_TRANSPORT,
        "Stop",
        params,
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(SoapError::SoapFault(msg)) if msg.contains("500") => {
            tracing::debug!("Stop: Speaker may already be stopped (ignoring error)");
            Ok(())
        }
        Err(e) => Err(e.into()),
    }
}

/// Get current volume of a speaker (0-100)
pub async fn get_volume(speaker_ip: &str) -> Result<u8, SonosError> {
    let mut params = HashMap::new();
    params.insert("InstanceID".to_string(), "0".to_string());
    params.insert("Channel".to_string(), "Master".to_string());

    let response = send_soap_request(
        get_client(),
        speaker_ip,
        RENDERING_CONTROL_URL,
        RENDERING_CONTROL,
        "GetVolume",
        params,
    )
    .await?;

    let volume_str = extract_soap_value(&response, "CurrentVolume")
        .ok_or_else(|| SonosError::ParseError("Failed to get CurrentVolume".to_string()))?;

    volume_str.parse().map_err(|_| {
        SonosError::ParseError(format!("Invalid volume value: {}", volume_str))
    })
}

/// Set volume of a speaker (0-100)
pub async fn set_volume(speaker_ip: &str, volume: u8) -> Result<(), SonosError> {
    let clamped_volume = volume.min(100);

    tracing::info!("SetVolume {} on {}", clamped_volume, speaker_ip);

    let mut params = HashMap::new();
    params.insert("InstanceID".to_string(), "0".to_string());
    params.insert("Channel".to_string(), "Master".to_string());
    params.insert("DesiredVolume".to_string(), clamped_volume.to_string());

    send_soap_request(
        get_client(),
        speaker_ip,
        RENDERING_CONTROL_URL,
        RENDERING_CONTROL,
        "SetVolume",
        params,
    )
    .await?;

    Ok(())
}

/// Load a stream URL and start playback in one call
pub async fn play_stream(
    coordinator_ip: &str,
    stream_url: &str,
    metadata: Option<&StreamMetadata>,
) -> Result<(), SonosError> {
    set_av_transport_uri(coordinator_ip, stream_url, metadata).await?;
    play(coordinator_ip).await
}
