//! Zone group topology parsing and retrieval.
//!
//! Handles parsing ZoneGroupState XML into structured `ZoneGroup` data (for
//! display) and into a `HouseholdTopology` (for comparing refreshes), and
//! fetching topology from Sonos speakers via SOAP.

use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;
use reqwest::Client;

use crate::error::SoapResult;
use crate::sonos::services::SonosService;
use crate::sonos::soap::soap_request;
use crate::sonos::types::{
    HouseholdDevice, HouseholdGroup, HouseholdMember, HouseholdTopology, RadioInfo, SatelliteInfo,
    VanishedDevice, ZoneGroup, ZoneGroupMember, ZoneGroupSnapshot,
};
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

/// Reads one device's attributes from a `ZoneGroupMember` or `Satellite`
/// element. `None` without a UUID or a usable `Location`.
fn parse_household_device(e: &BytesStart) -> Option<HouseholdDevice> {
    let uuid = get_xml_attr(e, b"UUID")?;
    let ip = extract_ip_from_location(&get_xml_attr(e, b"Location")?)?;
    let number = |name: &[u8]| get_xml_attr(e, name).and_then(|v| v.trim().parse::<u32>().ok());
    Some(HouseholdDevice {
        uuid,
        ip,
        zone_name: get_xml_attr(e, b"ZoneName").unwrap_or_default(),
        boot_seq: number(b"BootSeq"),
        invisible: get_xml_attr(e, b"Invisible").as_deref() == Some("1"),
        radio: RadioInfo {
            channel_freq: number(b"ChannelFreq"),
            wireless_mode: number(b"WirelessMode"),
            behind_wifi_extender: number(b"BehindWifiExtender"),
            eth_link: number(b"EthLink"),
        },
    })
}

/// Parses ZoneGroupState XML into a [`HouseholdTopology`].
///
/// Where [`parse_zone_group_xml`] flattens satellites into members and drops
/// zone bridges for display, this keeps each member's `<Satellite>` elements
/// under it, keeps zone bridges (flagged), and reads the attributes that say
/// how each device is doing: `BootSeq`, `Invisible`, `HTSatChanMapSet` and the
/// radio fields, plus the `VanishedDevices` list. It expects the same input,
/// the `ZoneGroupState` document already unescaped once.
pub fn parse_household_topology(xml: &str) -> HouseholdTopology {
    let mut household = HouseholdTopology::default();
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut group: Option<HouseholdGroup> = None;
    let mut in_vanished = false;

    loop {
        match reader.read_event_into(&mut buf) {
            // An empty `<VanishedDevices/>` has no children to collect.
            Ok(Event::Start(ref e)) if e.name().as_ref() == b"VanishedDevices" => {
                in_vanished = true;
            }
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => match e.name().as_ref() {
                b"ZoneGroup" => {
                    group = Some(HouseholdGroup {
                        id: get_xml_attr(e, b"ID").unwrap_or_default(),
                        coordinator_uuid: get_xml_attr(e, b"Coordinator").unwrap_or_default(),
                        members: Vec::new(),
                    });
                }
                b"ZoneGroupMember" => {
                    if let (Some(group), Some(device)) = (group.as_mut(), parse_household_device(e))
                    {
                        group.members.push(HouseholdMember {
                            device,
                            zone_bridge: get_xml_attr(e, b"IsZoneBridge").as_deref() == Some("1"),
                            ht_sat_chan_map: get_xml_attr(e, b"HTSatChanMapSet")
                                .filter(|m| !m.is_empty()),
                            satellites: Vec::new(),
                        });
                    }
                }
                b"Satellite" => {
                    // Satellites are children of the member they are bonded to.
                    let member = group.as_mut().and_then(|g| g.members.last_mut());
                    if let (Some(member), Some(device)) = (member, parse_household_device(e)) {
                        let role = member
                            .ht_sat_chan_map
                            .clone()
                            .or_else(|| get_xml_attr(e, b"HTSatChanMapSet"))
                            .and_then(|map| channels_for(&map, &device.uuid));
                        member.satellites.push(SatelliteInfo { device, role });
                    }
                }
                b"Device" if in_vanished => {
                    if let Some(uuid) = get_xml_attr(e, b"UUID") {
                        household.vanished.push(VanishedDevice {
                            uuid,
                            zone_name: get_xml_attr(e, b"ZoneName"),
                            reason: get_xml_attr(e, b"Reason"),
                        });
                    }
                }
                _ => {}
            },
            Ok(Event::End(ref e)) => match e.name().as_ref() {
                b"ZoneGroup" => household.groups.extend(group.take()),
                b"VanishedDevices" => in_vanished = false,
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(e) => {
                log::warn!("[Sonos] XML parse error in household topology: {}", e);
                break;
            }
            _ => {}
        }
        buf.clear();
    }

    household
}

/// The raw channels an `HTSatChanMapSet` gives a UUID (`SW`, `LR`, `LF,RF`).
fn channels_for(map: &str, uuid: &str) -> Option<String> {
    map.split(';')
        .filter_map(|entry| entry.split_once(':'))
        .find(|(u, _)| *u == uuid)
        .map(|(_, channels)| channels.to_string())
}

/// Fetches the current zone group state from a Sonos speaker and parses it,
/// both as display groups and as the household structure.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `ip` - IP address of any Sonos speaker on the network
/// * `port` - TCP port the speaker's UPnP services listen on (1400 on real hardware)
///
/// # Returns
/// The groups and the household read from the same answer; both empty when
/// the answer carries no `ZoneGroupState`.
pub async fn get_zone_group_state(
    client: &Client,
    ip: &str,
    port: u16,
) -> SoapResult<ZoneGroupSnapshot> {
    let response = soap_request(
        client,
        ip,
        port,
        SonosService::ZoneGroupTopology,
        "GetZoneGroupState",
        &[],
    )
    .await?;

    // Extract and decode ZoneGroupState from SOAP response
    let Some(decoded_xml) = extract_xml_text(&response, "ZoneGroupState") else {
        return Ok(ZoneGroupSnapshot::default());
    };

    Ok(ZoneGroupSnapshot {
        groups: parse_zone_group_xml(&decoded_xml),
        household: parse_household_topology(&decoded_xml),
    })
}

#[cfg(test)]
mod tests {
    use super::super::test_fixtures::{
        HT_HOUSEHOLD, HT_HOUSEHOLD_KITCHEN_VANISHED, HT_HOUSEHOLD_LR_MISSING, HT_LR_UUID,
        HT_PRIMARY_UUID, HT_RR_UUID, HT_SUB_UUID, KITCHEN_UUID, ZONE_GROUP_STATE_SOAP_RESPONSE,
    };
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

    #[test]
    fn soap_path_decodes_entity_escaped_zone_names() {
        // Mirrors get_zone_groups: decode the SOAP body once, then parse the
        // attributes of the resulting ZoneGroupState document. Before
        // get_xml_attr unescaped attribute values these came back raw, as
        // "Tom&apos;s Office".
        let state = extract_xml_text(ZONE_GROUP_STATE_SOAP_RESPONSE, "ZoneGroupState")
            .expect("ZoneGroupState element");
        let groups = parse_zone_group_xml(&state);

        assert_eq!(groups.len(), 3);
        assert_eq!(groups[0].name, "Tom's Office");
        assert_eq!(groups[0].members[0].zone_name, "Tom's Office");
        assert_eq!(groups[1].name, "Kitchen & Bar");
        assert_eq!(groups[1].members[0].zone_name, "Kitchen & Bar");
        assert_eq!(groups[2].name, "Tom's \"Den\"");
        assert_eq!(groups[2].members[0].zone_name, "Tom's \"Den\"");
    }

    #[test]
    fn household_keeps_satellites_under_their_primary() {
        let household = parse_household_topology(HT_HOUSEHOLD);

        assert_eq!(household.groups.len(), 3);
        let ht = &household.groups[0];
        assert_eq!(ht.coordinator_uuid, HT_PRIMARY_UUID);
        assert_eq!(ht.members.len(), 1, "satellites are not members");

        let primary = &ht.members[0];
        assert_eq!(primary.device.ip, "192.168.2.204");
        assert_eq!(primary.device.boot_seq, Some(118));
        assert_eq!(primary.device.radio.channel_freq, Some(2437));
        assert!(!primary.device.invisible);
        assert!(primary.ht_sat_chan_map.is_some());

        let satellites: Vec<(&str, Option<&str>)> = primary
            .satellites
            .iter()
            .map(|s| (s.device.uuid.as_str(), s.role.as_deref()))
            .collect();
        assert_eq!(
            satellites,
            vec![
                (HT_SUB_UUID, Some("SW")),
                (HT_LR_UUID, Some("LR")),
                (HT_RR_UUID, Some("RR")),
            ]
        );
        assert!(primary.satellites.iter().all(|s| s.device.invisible));
        assert_eq!(primary.satellites[0].device.radio.channel_freq, Some(5745));
        assert!(primary.missing_satellites().is_empty());
    }

    #[test]
    fn household_keeps_the_zone_bridge_flagged() {
        let household = parse_household_topology(HT_HOUSEHOLD);

        let boost = &household.groups[1].members[0];
        assert!(boost.zone_bridge);
        assert_eq!(boost.device.radio.eth_link, Some(1));
        // The display groups still leave it out, and fold the satellites in.
        let groups = parse_zone_group_xml(HT_HOUSEHOLD);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].members.len(), 4);
    }

    #[test]
    fn a_satellite_in_the_map_but_not_listed_is_missing() {
        let household = parse_household_topology(HT_HOUSEHOLD_LR_MISSING);

        let primary = &household.groups[0].members[0];
        assert_eq!(
            primary.missing_satellites(),
            vec![(HT_LR_UUID.to_string(), "LR".to_string())]
        );
        assert_eq!(household.satellite_counts(), (2, 1));
    }

    #[test]
    fn household_reads_vanished_devices() {
        let household = parse_household_topology(HT_HOUSEHOLD_KITCHEN_VANISHED);

        assert_eq!(
            household.vanished,
            vec![VanishedDevice {
                uuid: KITCHEN_UUID.to_string(),
                zone_name: Some("Kitchen".to_string()),
                reason: Some("powered off".to_string()),
            }]
        );
        assert!(parse_household_topology(HT_HOUSEHOLD).vanished.is_empty());
    }

    #[test]
    fn household_maps_every_device_address_to_its_uuid() {
        let household = parse_household_topology(HT_HOUSEHOLD);

        let uuid_by_ip = household.uuid_by_ip();
        assert_eq!(uuid_by_ip.len(), 6);
        assert_eq!(uuid_by_ip["192.168.2.206"], HT_LR_UUID);
        assert_eq!(
            household.coordinator_of(HT_LR_UUID).map(|d| d.ip.as_str()),
            Some("192.168.2.204")
        );
    }
}
