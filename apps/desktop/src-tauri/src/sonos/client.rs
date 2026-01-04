//! High-level Sonos client commands.
//!
//! This module provides the public API for controlling Sonos speakers,
//! including playback control, volume/mute, and zone group topology.

use async_trait::async_trait;
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use reqwest::Client;

use crate::error::SoapResult;
use crate::sonos::services::SonosService;
use crate::sonos::soap::{SoapError, SoapRequestBuilder};
use crate::sonos::traits::{SonosPlayback, SonosTopology, SonosVolumeControl};
use crate::sonos::types::{ZoneGroup, ZoneGroupMember};
use crate::sonos::utils::{
    escape_xml, extract_ip_from_location, extract_model_from_icon, extract_xml_text,
    get_channel_role, get_xml_attr, normalize_sonos_uri,
};
use crate::stream::StreamMetadata;

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
/// - **Title/Artist**: From MediaSession (updates via ICY StreamTitle)
/// - **Album**: Formatted as "{source} • Thaumic Cast" for branding
/// - **Artwork**: Static app icon (ICY doesn't support artwork updates)
fn format_didl_lite(stream_url: &str, metadata: Option<&StreamMetadata>, icon_url: &str) -> String {
    // [DIAG] Log incoming metadata for debugging
    log::info!(
        "[DIDL] Incoming metadata: {:?}",
        metadata.map(|m| format!(
            "title={:?}, artist={:?}, album={:?}, source={:?}",
            m.title, m.artist, m.album, m.source
        ))
    );

    let title = metadata
        .and_then(|m| m.title.as_deref())
        .unwrap_or("Browser Audio");
    let artist = metadata
        .and_then(|m| m.artist.as_deref())
        .unwrap_or("Thaumic Cast");

    // Format album as "{source} • Thaumic Cast" or just "Thaumic Cast"
    // We intentionally ignore metadata.album as it gets stuck after first stream
    let album = match metadata.and_then(|m| m.source.as_deref()) {
        Some(source) => format!("{} • Thaumic Cast", source),
        None => "Thaumic Cast".to_string(),
    };

    // [DIAG] Log what we're sending to Sonos
    log::info!(
        "[DIDL] Sending to Sonos: title={:?}, artist={:?}, album={:?}, icon={:?}",
        title,
        artist,
        album,
        icon_url
    );

    let mut didl = String::from(
        r#"<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">"#,
    );
    didl.push_str(r#"<item id="0" parentID="-1" restricted="true">"#);
    didl.push_str(&format!("<dc:title>{}</dc:title>", escape_xml(title)));
    didl.push_str(&format!("<dc:creator>{}</dc:creator>", escape_xml(artist)));

    // Always set album for consistent branding
    didl.push_str(&format!("<upnp:album>{}</upnp:album>", escape_xml(&album)));

    // Always use static icon URL (ICY metadata doesn't support artwork updates)
    didl.push_str(&format!(
        "<upnp:albumArtURI>{}</upnp:albumArtURI>",
        escape_xml(icon_url)
    ));

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

// ─────────────────────────────────────────────────────────────────────────────
// Playback Control
// ─────────────────────────────────────────────────────────────────────────────

/// Commands a Sonos speaker to play a specific audio URI.
///
/// Optionally includes metadata for display on the Sonos UI.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `ip` - IP address of the Sonos speaker (coordinator for grouped speakers)
/// * `uri` - The audio stream URL to play
/// * `metadata` - Optional stream metadata for display (title, artist, source)
/// * `icon_url` - URL to the static app icon for album art display
pub async fn play_uri(
    client: &Client,
    ip: &str,
    uri: &str,
    metadata: Option<&StreamMetadata>,
    icon_url: &str,
) -> SoapResult<()> {
    // Convert http:// to x-rincon-mp3radio:// for Sonos compatibility
    let sonos_uri = normalize_sonos_uri(uri);
    let didl_metadata = format_didl_lite(uri, metadata, icon_url);

    log::info!("[Sonos] SetAVTransportURI: ip={}, uri={}", ip, sonos_uri);

    SoapRequestBuilder::new(client, ip)
        .service(SonosService::AVTransport)
        .action("SetAVTransportURI")
        .instance_id()
        .arg("CurrentURI", &sonos_uri)
        .arg("CurrentURIMetaData", &didl_metadata)
        .send()
        .await?;

    log::info!("[Sonos] SetAVTransportURI succeeded, sending Play command");

    SoapRequestBuilder::new(client, ip)
        .service(SonosService::AVTransport)
        .action("Play")
        .instance_id()
        .arg("Speed", "1")
        .send()
        .await?;

    log::info!("[Sonos] Play command succeeded");

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
// Trait Implementation
// ─────────────────────────────────────────────────────────────────────────────

/// Concrete implementation of Sonos client traits.
///
/// This struct wraps the free functions in this module to provide
/// a testable, injectable interface for Sonos operations.
#[derive(Debug, Clone)]
pub struct SonosClientImpl {
    /// HTTP client for Sonos communication.
    client: Client,
}

impl SonosClientImpl {
    /// Creates a new SonosClientImpl with the given HTTP client.
    ///
    /// # Arguments
    /// * `client` - The HTTP client to use for all Sonos communication
    #[must_use]
    pub fn new(client: Client) -> Self {
        Self { client }
    }
}

#[async_trait]
impl SonosPlayback for SonosClientImpl {
    async fn play_uri(
        &self,
        ip: &str,
        uri: &str,
        metadata: Option<&StreamMetadata>,
        icon_url: &str,
    ) -> SoapResult<()> {
        play_uri(&self.client, ip, uri, metadata, icon_url).await
    }

    async fn stop(&self, ip: &str) -> SoapResult<()> {
        stop(&self.client, ip).await
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
}
