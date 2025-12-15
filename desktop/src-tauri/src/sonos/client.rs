use super::soap::{extract_soap_value, send_soap_request, unescape_xml, SoapError};
use super::ssdp::{discover as ssdp_discover, DiscoveredSpeaker, SsdpError};
use crate::generated::{LocalGroup, LocalSpeaker, Speaker, StreamMetadata};
use parking_lot::RwLock;
use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::Client;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use thiserror::Error;

// Service URNs
const ZONE_GROUP_TOPOLOGY: &str = "urn:schemas-upnp-org:service:ZoneGroupTopology:1";
const AV_TRANSPORT: &str = "urn:schemas-upnp-org:service:AVTransport:1";
const GROUP_RENDERING_CONTROL: &str = "urn:schemas-upnp-org:service:GroupRenderingControl:1";

// Control URLs
const ZONE_GROUP_CONTROL: &str = "/ZoneGroupTopology/Control";
const AV_TRANSPORT_CONTROL: &str = "/MediaRenderer/AVTransport/Control";
const GROUP_RENDERING_CONTROL_URL: &str = "/MediaRenderer/GroupRenderingControl/Control";

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

    let mut didl = String::from(
        r#"<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">"#,
    );
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

/// Get the number of cached speakers (from last discovery)
pub fn get_cached_speaker_count() -> u64 {
    get_cache()
        .read()
        .as_ref()
        .map(|c| c.speakers.len() as u64)
        .unwrap_or(0)
}

/// Get the timestamp of the last successful discovery (as Unix timestamp in seconds)
pub fn get_last_discovery_timestamp() -> Option<u64> {
    get_cache().read().as_ref().map(|c| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            - c.last_update.elapsed().as_secs()
    })
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
                log::debug!("Using cached speakers");
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
    log::info!("Running SSDP discovery...");
    let speakers = tokio::task::spawn_blocking(|| ssdp_discover(3000))
        .await
        .unwrap()?;

    log::info!("Found {} speakers", speakers.len());

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

/// Extract an attribute value from quick-xml Attributes
fn get_attribute(attrs: &quick_xml::events::attributes::Attributes, name: &[u8]) -> Option<String> {
    for attr in attrs.clone().flatten() {
        if attr.key.as_ref() == name {
            return attr.unescape_value().ok().map(|s| s.to_string());
        }
    }
    None
}

/// Extract IP from Location URL like "http://192.168.1.100:1400/xml/..."
fn extract_ip_from_location(location: &str) -> Option<String> {
    // Find the host part after "http://" and before the port ":"
    let stripped = location.strip_prefix("http://")?;
    let host_end = stripped.find(':')?;
    Some(stripped[..host_end].to_string())
}

/// Extract model from Icon URL like "x-rincon-cpicon:sonos-one-g1"
fn extract_model_from_icon(icon: &str) -> String {
    // Look for "sonos-" and extract the next word
    if let Some(pos) = icon.find("sonos-") {
        let rest = &icon[pos + 6..];
        // Take until next dash or end
        if let Some(end) = rest.find('-') {
            return rest[..end].to_string();
        }
        return rest.to_string();
    }
    "Unknown".to_string()
}

/// Parse channel role from HTSatChanMapSet for a given UUID
/// Format: "UUID1:LF,RF;UUID2:SW;UUID3:LR;UUID4:RR"
fn get_channel_role(ht_sat_chan_map: &str, uuid: &str) -> Option<String> {
    for mapping in ht_sat_chan_map.split(';') {
        if let Some((map_uuid, channels)) = mapping.split_once(':') {
            if map_uuid == uuid {
                return Some(match channels {
                    "LF,RF" => "Soundbar",
                    "SW" => "Subwoofer",
                    "LR" => "Surround Left",
                    "RR" => "Surround Right",
                    "LF" => "Left",
                    "RF" => "Right",
                    other => other,
                }
                .to_string());
            }
        }
    }
    None
}

/// Parse ZoneGroupState XML to extract groups and members using quick-xml
fn parse_zone_group_state(xml: &str) -> Vec<LocalGroup> {
    let mut groups = Vec::new();
    let unescaped_xml = unescape_xml(xml);
    let mut reader = Reader::from_str(&unescaped_xml);

    let mut current_coordinator: Option<String> = None;
    let mut current_members: Vec<LocalSpeaker> = Vec::new();
    let mut coordinator_ip: Option<String> = None;
    let mut coordinator_zone_name: Option<String> = None;
    let mut ht_sat_chan_map: Option<String> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                match e.local_name().as_ref() {
                    b"ZoneGroup" => {
                        // Start of a new zone group
                        current_coordinator = get_attribute(&e.attributes(), b"Coordinator");
                        current_members.clear();
                        coordinator_ip = None;
                        coordinator_zone_name = None;
                        ht_sat_chan_map = None;
                    }
                    b"ZoneGroupMember" | b"Satellite" => {
                        let attrs = e.attributes();

                        // Skip zone bridges (BOOST devices) - they can't play audio
                        if get_attribute(&attrs, b"IsZoneBridge")
                            .map(|v| v == "1")
                            .unwrap_or(false)
                        {
                            continue;
                        }

                        let uuid = match get_attribute(&attrs, b"UUID") {
                            Some(u) => u,
                            None => continue,
                        };

                        let location = match get_attribute(&attrs, b"Location") {
                            Some(l) => l,
                            None => continue,
                        };

                        let ip = match extract_ip_from_location(&location) {
                            Some(i) => i,
                            None => continue,
                        };

                        let zone_name = match get_attribute(&attrs, b"ZoneName") {
                            Some(z) => z,
                            None => continue,
                        };

                        // Check if this is the coordinator (main ZoneGroupMember)
                        let is_coordinator = current_coordinator.as_ref() == Some(&uuid);
                        if is_coordinator {
                            coordinator_ip = Some(ip.clone());
                            coordinator_zone_name = Some(zone_name.clone());
                            // Get HTSatChanMapSet from coordinator for channel roles
                            ht_sat_chan_map = get_attribute(&attrs, b"HTSatChanMapSet");
                        }

                        // Determine model: prefer channel role, then Icon, then fallback
                        let model = ht_sat_chan_map
                            .as_ref()
                            .and_then(|map| get_channel_role(map, &uuid))
                            .or_else(|| {
                                get_attribute(&attrs, b"Icon")
                                    .map(|i| extract_model_from_icon(&i))
                                    .filter(|m| m != "Unknown")
                            })
                            .unwrap_or_else(|| "Speaker".to_string());

                        current_members.push(LocalSpeaker {
                            uuid,
                            ip,
                            zone_name,
                            model,
                        });
                    }
                    _ => {}
                }
            }
            Ok(Event::End(e)) if e.local_name().as_ref() == b"ZoneGroup" => {
                // End of zone group - finalize if we have valid data
                if let (Some(coord_uuid), Some(coord_ip)) =
                    (current_coordinator.take(), coordinator_ip.take())
                {
                    if !current_members.is_empty() {
                        // Use coordinator's zone name, or deduplicate for multi-room groups
                        let group_name = coordinator_zone_name.take().unwrap_or_else(|| {
                            let mut unique_names: Vec<&str> = Vec::new();
                            for m in &current_members {
                                if !unique_names.contains(&m.zone_name.as_str()) {
                                    unique_names.push(&m.zone_name);
                                }
                            }
                            unique_names.join(" + ")
                        });

                        groups.push(LocalGroup {
                            id: coord_uuid.clone(),
                            name: group_name,
                            coordinator_uuid: coord_uuid,
                            coordinator_ip: coord_ip,
                            members: std::mem::take(&mut current_members),
                        });
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
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

    log::info!("SetAVTransportURI: {}", sonos_url);

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
    log::info!("Play on {}", coordinator_ip);

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
    log::info!("Stop on {}", coordinator_ip);

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
            log::debug!("Stop: Speaker may already be stopped (ignoring error)");
            Ok(())
        }
        Err(e) => Err(e.into()),
    }
}

/// Get current group volume from the coordinator (0-100)
/// This returns the combined volume for all speakers in the group
pub async fn get_group_volume(coordinator_ip: &str) -> Result<u8, SonosError> {
    let mut params = HashMap::new();
    params.insert("InstanceID".to_string(), "0".to_string());

    let response = send_soap_request(
        get_client(),
        coordinator_ip,
        GROUP_RENDERING_CONTROL_URL,
        GROUP_RENDERING_CONTROL,
        "GetGroupVolume",
        params,
    )
    .await?;

    let volume_str = extract_soap_value(&response, "CurrentVolume")
        .ok_or_else(|| SonosError::ParseError("Failed to get CurrentVolume".to_string()))?;

    volume_str
        .parse()
        .map_err(|_| SonosError::ParseError(format!("Invalid volume value: {}", volume_str)))
}

/// Set group volume on the coordinator (0-100)
/// This adjusts volume proportionally across all speakers in the group
pub async fn set_group_volume(coordinator_ip: &str, volume: u8) -> Result<(), SonosError> {
    let clamped_volume = volume.min(100);

    log::info!("SetGroupVolume {} on {}", clamped_volume, coordinator_ip);

    let mut params = HashMap::new();
    params.insert("InstanceID".to_string(), "0".to_string());
    params.insert("DesiredVolume".to_string(), clamped_volume.to_string());

    send_soap_request(
        get_client(),
        coordinator_ip,
        GROUP_RENDERING_CONTROL_URL,
        GROUP_RENDERING_CONTROL,
        "SetGroupVolume",
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
