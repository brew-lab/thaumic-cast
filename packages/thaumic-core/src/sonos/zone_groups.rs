//! Zone group topology parsing and retrieval.
//!
//! Handles parsing ZoneGroupState XML into structured `ZoneGroup` data
//! and fetching topology from Sonos speakers via SOAP.

use quick_xml::events::Event;
use quick_xml::reader::Reader;
use reqwest::Client;

use crate::error::SoapResult;
use crate::sonos::services::SonosService;
use crate::sonos::soap::soap_request;
use crate::sonos::types::{ZoneGroup, ZoneGroupMember};
use crate::sonos::utils::{
    extract_ip_from_location, extract_model_from_icon, extract_xml_text, get_channel_role,
    get_xml_attr,
};

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
                        // Build group name from member zone names:
                        // - Single room / stereo pair / HT: use coordinator's name
                        // - Multi-room (x-rincon join): combine unique zone names
                        let group_name = coordinator_zone_name.take().map_or_else(
                            || {
                                let mut unique_names: Vec<&str> = Vec::new();
                                for m in &current_members {
                                    if !unique_names.contains(&m.zone_name.as_str()) {
                                        unique_names.push(&m.zone_name);
                                    }
                                }
                                unique_names.join(", ")
                            },
                            |coord_name| {
                                let mut other_names: Vec<&str> = Vec::new();
                                for m in &current_members {
                                    let name = m.zone_name.as_str();
                                    if name != coord_name.as_str() && !other_names.contains(&name) {
                                        other_names.push(name);
                                    }
                                }
                                if other_names.is_empty() {
                                    coord_name
                                } else {
                                    format!("{}, {}", coord_name, other_names.join(", "))
                                }
                            },
                        );

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
    let response = soap_request(
        client,
        ip,
        SonosService::ZoneGroupTopology,
        "GetZoneGroupState",
        &[],
    )
    .await?;

    // Extract and decode ZoneGroupState from SOAP response
    let Some(decoded_xml) = extract_xml_text(&response, "ZoneGroupState") else {
        return Ok(vec![]);
    };

    Ok(parse_zone_group_xml(&decoded_xml))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper to build a ZoneGroupMember XML element.
    fn member_xml(uuid: &str, ip: &str, zone_name: &str) -> String {
        format!(
            r#"<ZoneGroupMember UUID="{uuid}" Location="http://{ip}:1400/xml/device_description.xml" ZoneName="{zone_name}" Icon="x-rincon-roomicon:living" />"#
        )
    }

    /// Helper to wrap members into a ZoneGroup XML element.
    fn group_xml(id: &str, coordinator_uuid: &str, members: &[String]) -> String {
        format!(
            r#"<ZoneGroup Coordinator="{coordinator_uuid}" ID="{id}">{}</ZoneGroup>"#,
            members.join("")
        )
    }

    /// Helper to wrap groups into a ZoneGroups root element.
    fn zone_groups_xml(groups: &[String]) -> String {
        format!("<ZoneGroups>{}</ZoneGroups>", groups.join(""))
    }

    #[test]
    fn single_speaker_uses_zone_name() {
        let xml = zone_groups_xml(&[group_xml(
            "G1",
            "RINCON_KITCHEN",
            &[member_xml("RINCON_KITCHEN", "192.168.1.10", "Kitchen")],
        )]);

        let groups = parse_zone_group_xml(&xml);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].name, "Kitchen");
    }

    #[test]
    fn stereo_pair_uses_coordinator_name() {
        // Stereo pair: two speakers, same zone name
        let xml = zone_groups_xml(&[group_xml(
            "G1",
            "RINCON_LEFT",
            &[
                member_xml("RINCON_LEFT", "192.168.1.10", "Living Room"),
                member_xml("RINCON_RIGHT", "192.168.1.11", "Living Room"),
            ],
        )]);

        let groups = parse_zone_group_xml(&xml);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].name, "Living Room");
    }

    #[test]
    fn multi_room_join_combines_zone_names() {
        // x-rincon join: two speakers from different rooms
        let xml = zone_groups_xml(&[group_xml(
            "G1",
            "RINCON_KITCHEN",
            &[
                member_xml("RINCON_KITCHEN", "192.168.1.10", "Kitchen"),
                member_xml("RINCON_OFFICE", "192.168.1.20", "Office"),
            ],
        )]);

        let groups = parse_zone_group_xml(&xml);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].name, "Kitchen, Office");
    }

    #[test]
    fn multi_room_join_coordinator_name_first() {
        // Coordinator name should come first even if not first in XML
        let xml = zone_groups_xml(&[group_xml(
            "G1",
            "RINCON_OFFICE",
            &[
                member_xml("RINCON_KITCHEN", "192.168.1.10", "Kitchen"),
                member_xml("RINCON_OFFICE", "192.168.1.20", "Office"),
            ],
        )]);

        let groups = parse_zone_group_xml(&xml);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].name, "Office, Kitchen");
    }

    #[test]
    fn three_room_join_combines_all_names() {
        let xml = zone_groups_xml(&[group_xml(
            "G1",
            "RINCON_KITCHEN",
            &[
                member_xml("RINCON_KITCHEN", "192.168.1.10", "Kitchen"),
                member_xml("RINCON_OFFICE", "192.168.1.20", "Office"),
                member_xml("RINCON_BEDROOM", "192.168.1.30", "Bedroom"),
            ],
        )]);

        let groups = parse_zone_group_xml(&xml);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].name, "Kitchen, Office, Bedroom");
    }

    #[test]
    fn home_theater_same_zone_names_not_duplicated() {
        // Home theater: soundbar + sub + surrounds, all same zone name
        let xml = zone_groups_xml(&[group_xml(
            "G1",
            "RINCON_BAR",
            &[
                member_xml("RINCON_BAR", "192.168.1.10", "Living Room"),
                member_xml("RINCON_SUB", "192.168.1.11", "Living Room"),
                member_xml("RINCON_LEFT", "192.168.1.12", "Living Room"),
                member_xml("RINCON_RIGHT", "192.168.1.13", "Living Room"),
            ],
        )]);

        let groups = parse_zone_group_xml(&xml);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].name, "Living Room");
    }
}
