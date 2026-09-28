//! What changed in the household between two zone topology snapshots.
//!
//! The topology monitor compares each `GetZoneGroupState` answer with the
//! one before it. Satellites dropping off a home theatre, devices rebooting,
//! radios changing channel or mode and devices vanishing are all invisible in
//! the flattened groups shown to users, yet each one can explain a stutter
//! that the speaker's buffer does not. [`diff`] names them; [`TopologyDiff`]
//! keeps the previous snapshot and times how long satellites stay missing.
//!
//! Only SOAP answers are compared. GENA topology bodies can carry stale
//! membership (still showing a group after an unjoin), which would read as
//! satellites flapping.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::sonos::types::{HouseholdDevice, HouseholdTopology, RadioInfo};

/// One of the radio attributes Sonos reports per device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RadioField {
    /// `ChannelFreq`.
    ChannelFreq,
    /// `WirelessMode`.
    WirelessMode,
    /// `BehindWifiExtender`.
    BehindWifiExtender,
    /// `EthLink`.
    EthLink,
}

impl RadioField {
    /// Every field, in the order changes are reported.
    pub const ALL: [RadioField; 4] = [
        RadioField::ChannelFreq,
        RadioField::WirelessMode,
        RadioField::BehindWifiExtender,
        RadioField::EthLink,
    ];

    /// This field's value in `radio`.
    fn read(self, radio: &RadioInfo) -> Option<u32> {
        match self {
            RadioField::ChannelFreq => radio.channel_freq,
            RadioField::WirelessMode => radio.wireless_mode,
            RadioField::BehindWifiExtender => radio.behind_wifi_extender,
            RadioField::EthLink => radio.eth_link,
        }
    }
}

impl fmt::Display for RadioField {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            RadioField::ChannelFreq => "ChannelFreq",
            RadioField::WirelessMode => "WirelessMode",
            RadioField::BehindWifiExtender => "BehindWifiExtender",
            RadioField::EthLink => "EthLink",
        })
    }
}

/// One change between two household snapshots.
///
/// Serialized into [`crate::events::TopologyEvent::MemberChanged`], tagged by
/// `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MemberChange {
    /// A satellite the home theatre's channel map names is no longer listed
    /// under it: it has dropped off, and its channels are silent.
    SatelliteMissing {
        /// The home-theatre primary the satellite is bonded to.
        #[serde(rename = "primaryUuid")]
        primary_uuid: String,
        /// The satellite.
        uuid: String,
        /// Its channels in the map (`SW`, `LR`, `RR`).
        role: String,
    },
    /// A satellite reported missing is listed again.
    SatelliteReturned {
        /// The home-theatre primary the satellite is bonded to.
        #[serde(rename = "primaryUuid")]
        primary_uuid: String,
        /// The satellite.
        uuid: String,
        /// Its channels in the map.
        role: String,
        /// How long it was missing, when the drop was seen.
        #[serde(rename = "afterMs", skip_serializing_if = "Option::is_none")]
        after_ms: Option<u64>,
    },
    /// A device's `BootSeq` went up: it restarted.
    DeviceRebooted {
        /// The device.
        uuid: String,
        /// `BootSeq` before.
        from: u32,
        /// `BootSeq` now.
        to: u32,
    },
    /// One of a device's radio attributes changed.
    RadioChanged {
        /// The device.
        uuid: String,
        /// Which attribute.
        field: RadioField,
        /// Its value before, if reported.
        #[serde(skip_serializing_if = "Option::is_none")]
        from: Option<u32>,
        /// Its value now, if reported.
        #[serde(skip_serializing_if = "Option::is_none")]
        to: Option<u32>,
    },
    /// A device newly appears under `VanishedDevices`.
    Vanished {
        /// The device.
        uuid: String,
        /// Why Sonos considers it gone, when given.
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// Members joined or left a group whose coordinator led a group before
    /// too.
    MembersChanged {
        /// The group's coordinator.
        #[serde(rename = "coordinatorUuid")]
        coordinator_uuid: String,
        /// Members that were not in the group before.
        joined: Vec<String>,
        /// Members that were in the group before and are not now.
        left: Vec<String>,
    },
}

impl MemberChange {
    /// Short name of the kind of change, for summaries.
    pub fn kind(&self) -> &'static str {
        match self {
            MemberChange::SatelliteMissing { .. } => "satellite_missing",
            MemberChange::SatelliteReturned { .. } => "satellite_returned",
            MemberChange::DeviceRebooted { .. } => "rebooted",
            MemberChange::RadioChanged { .. } => "radio_changed",
            MemberChange::Vanished { .. } => "vanished",
            MemberChange::MembersChanged { .. } => "members_changed",
        }
    }

    /// The device the change is about: the satellite, the rebooted or
    /// vanished device, or the group's coordinator.
    pub fn subject_uuid(&self) -> &str {
        match self {
            MemberChange::SatelliteMissing { uuid, .. }
            | MemberChange::SatelliteReturned { uuid, .. }
            | MemberChange::DeviceRebooted { uuid, .. }
            | MemberChange::RadioChanged { uuid, .. }
            | MemberChange::Vanished { uuid, .. } => uuid,
            MemberChange::MembersChanged {
                coordinator_uuid, ..
            } => coordinator_uuid,
        }
    }

    /// Whether the change points at trouble (a satellite dropping, a reboot,
    /// a radio change, a device vanishing) rather than at a recovery or a
    /// deliberate regrouping.
    pub fn is_warning(&self) -> bool {
        !matches!(
            self,
            MemberChange::SatelliteReturned { .. } | MemberChange::MembersChanged { .. }
        )
    }
}

impl fmt::Display for MemberChange {
    /// A compact description naming devices by UUID, for per-speaker log
    /// lines (the topology monitor writes the fuller line with addresses).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MemberChange::SatelliteMissing { uuid, role, .. } => {
                write!(f, "satellite {uuid} ({role}) missing")
            }
            MemberChange::SatelliteReturned {
                uuid,
                role,
                after_ms,
                ..
            } => {
                write!(f, "satellite {uuid} ({role}) returned")?;
                if let Some(ms) = after_ms {
                    write!(f, " after {}s", ms / 1000)?;
                }
                Ok(())
            }
            MemberChange::DeviceRebooted { uuid, from, to } => {
                write!(f, "{uuid} rebooted (BootSeq {from}->{to})")
            }
            MemberChange::RadioChanged {
                uuid,
                field,
                from,
                to,
            } => {
                let v = |v: &Option<u32>| v.map_or_else(|| "?".to_string(), |v| v.to_string());
                write!(f, "{uuid} {field} {}->{}", v(from), v(to))
            }
            MemberChange::Vanished { uuid, reason } => {
                write!(f, "{uuid} vanished")?;
                if let Some(reason) = reason {
                    write!(f, " ({reason})")?;
                }
                Ok(())
            }
            MemberChange::MembersChanged {
                coordinator_uuid,
                joined,
                left,
            } => write!(
                f,
                "group {coordinator_uuid}: joined [{}] left [{}]",
                joined.join(","),
                left.join(",")
            ),
        }
    }
}

/// Satellites a snapshot reports missing, by satellite UUID, with the
/// primary and channels.
fn missing_satellites(household: &HouseholdTopology) -> HashMap<String, (String, String)> {
    household
        .members()
        .flat_map(|m| {
            m.missing_satellites()
                .into_iter()
                .map(move |(uuid, role)| (uuid, (m.device.uuid.clone(), role)))
        })
        .collect()
}

/// Each primary's satellites as its channel map names them, by satellite
/// UUID.
fn mapped_satellites(household: &HouseholdTopology) -> HashMap<String, (String, String)> {
    household
        .members()
        .filter_map(|m| m.ht_sat_chan_map.as_ref().map(|map| (m, map)))
        .flat_map(|(m, map)| {
            map.split(';')
                .filter_map(|entry| entry.split_once(':'))
                .filter(|(uuid, _)| *uuid != m.device.uuid)
                .map(|(uuid, role)| (uuid.to_string(), (m.device.uuid.clone(), role.to_string())))
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Every device by UUID.
fn devices_by_uuid(household: &HouseholdTopology) -> HashMap<&str, &HouseholdDevice> {
    household.devices().map(|d| (d.uuid.as_str(), d)).collect()
}

/// The changes from `prev` to `next`, in the order `next` lists its devices.
///
/// - A satellite is reported missing when `next`'s channel map names it but
///   no `<Satellite>` element lists it, and `prev` did not already report it
///   missing. Against an empty `prev` (the first snapshot) every missing
///   satellite is reported, which is what a user starting a cast wants to
///   know.
/// - It is reported returned when `prev` had it missing and `next` lists it
///   under the same primary.
/// - Reboots and radio changes are reported for devices in both snapshots.
///   A `BootSeq` that went down is not a reboot (the device was replaced or
///   reset), and a field that one snapshot omits is not a change.
/// - A device is reported vanished when it is listed under `VanishedDevices`
///   in `next` and was not in `prev`.
/// - Joins and leaves are reported only for groups whose coordinator also
///   led a group in `prev`: a group that has just formed says nothing its
///   members' old groups do not already say.
pub fn diff(prev: &HouseholdTopology, next: &HouseholdTopology) -> Vec<MemberChange> {
    let mut changes = Vec::new();

    let prev_missing = missing_satellites(prev);
    let next_missing = missing_satellites(next);
    for member in next.members() {
        for (uuid, role) in member.missing_satellites() {
            if !prev_missing.contains_key(&uuid) {
                changes.push(MemberChange::SatelliteMissing {
                    primary_uuid: member.device.uuid.clone(),
                    uuid,
                    role,
                });
            }
        }
    }
    let next_mapped = mapped_satellites(next);
    for member in next.members() {
        for satellite in &member.satellites {
            let uuid = &satellite.device.uuid;
            let Some((primary, _)) = prev_missing.get(uuid) else {
                continue;
            };
            if *primary != member.device.uuid || next_missing.contains_key(uuid) {
                continue;
            }
            let role = next_mapped
                .get(uuid)
                .map(|(_, role)| role.clone())
                .or_else(|| satellite.role.clone())
                .unwrap_or_default();
            changes.push(MemberChange::SatelliteReturned {
                primary_uuid: member.device.uuid.clone(),
                uuid: uuid.clone(),
                role,
                after_ms: None,
            });
        }
    }

    let prev_devices = devices_by_uuid(prev);
    for device in next.devices() {
        let Some(before) = prev_devices.get(device.uuid.as_str()) else {
            continue;
        };
        if let (Some(from), Some(to)) = (before.boot_seq, device.boot_seq) {
            if to > from {
                changes.push(MemberChange::DeviceRebooted {
                    uuid: device.uuid.clone(),
                    from,
                    to,
                });
            }
        }
        for field in RadioField::ALL {
            let (from, to) = (field.read(&before.radio), field.read(&device.radio));
            if from.is_some() && to.is_some() && from != to {
                changes.push(MemberChange::RadioChanged {
                    uuid: device.uuid.clone(),
                    field,
                    from,
                    to,
                });
            }
        }
    }

    let prev_vanished: HashSet<&str> = prev.vanished.iter().map(|v| v.uuid.as_str()).collect();
    for vanished in &next.vanished {
        if !prev_vanished.contains(vanished.uuid.as_str()) {
            changes.push(MemberChange::Vanished {
                uuid: vanished.uuid.clone(),
                reason: vanished.reason.clone(),
            });
        }
    }

    let members_of = |household: &HouseholdTopology| -> HashMap<String, Vec<String>> {
        household
            .groups
            .iter()
            .map(|g| {
                let members = g
                    .members
                    .iter()
                    .map(|m| m.device.uuid.clone())
                    .filter(|uuid| *uuid != g.coordinator_uuid)
                    .collect();
                (g.coordinator_uuid.clone(), members)
            })
            .collect()
    };
    let prev_groups = members_of(prev);
    let next_groups = members_of(next);
    let mut coordinators: Vec<&String> = next
        .groups
        .iter()
        .map(|g| &g.coordinator_uuid)
        .chain(prev.groups.iter().map(|g| &g.coordinator_uuid))
        .collect();
    let mut seen = HashSet::new();
    coordinators.retain(|c| seen.insert(*c));
    for coordinator in coordinators {
        let Some(before) = prev_groups.get(coordinator) else {
            continue;
        };
        let now = next_groups.get(coordinator).cloned().unwrap_or_default();
        let joined: Vec<String> = now
            .iter()
            .filter(|u| !before.contains(u))
            .cloned()
            .collect();
        let left: Vec<String> = before
            .iter()
            .filter(|u| !now.contains(u))
            .cloned()
            .collect();
        if !joined.is_empty() || !left.is_empty() {
            changes.push(MemberChange::MembersChanged {
                coordinator_uuid: coordinator.clone(),
                joined,
                left,
            });
        }
    }

    changes
}

/// A one-line summary of a set of changes: `unchanged`, or the count of
/// each kind (`2 change(s): satellite_missing=1 rebooted=1`).
pub fn summarize(changes: &[MemberChange]) -> String {
    if changes.is_empty() {
        return "unchanged".to_string();
    }
    let mut counts: Vec<(&'static str, usize)> = Vec::new();
    for change in changes {
        match counts.iter_mut().find(|(kind, _)| *kind == change.kind()) {
            Some((_, n)) => *n += 1,
            None => counts.push((change.kind(), 1)),
        }
    }
    let parts: Vec<String> = counts.iter().map(|(k, n)| format!("{k}={n}")).collect();
    format!("{} change(s): {}", changes.len(), parts.join(" "))
}

/// Compares each household snapshot with the one before it.
///
/// Holds the previous snapshot and when each missing satellite was first
/// seen missing, so a return can say how long the satellite was gone.
#[derive(Debug, Default)]
pub struct TopologyDiff {
    prev: Option<HouseholdTopology>,
    missing_since: HashMap<String, Instant>,
}

impl TopologyDiff {
    /// Creates a diff with no snapshot yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// The last snapshot observed.
    pub fn current(&self) -> Option<&HouseholdTopology> {
        self.prev.as_ref()
    }

    /// Compares `next` with the previous snapshot (an empty household the
    /// first time), keeps it for the next call, and returns the changes.
    ///
    /// A snapshot with no groups at all is ignored and returns nothing: it
    /// is a failed or empty answer, not every device leaving at once.
    pub fn observe(&mut self, next: HouseholdTopology, now: Instant) -> Vec<MemberChange> {
        if next.groups.is_empty() {
            return Vec::new();
        }
        let empty = HouseholdTopology::default();
        let mut changes = diff(self.prev.as_ref().unwrap_or(&empty), &next);
        for change in &mut changes {
            match change {
                MemberChange::SatelliteMissing { uuid, .. } => {
                    self.missing_since.entry(uuid.clone()).or_insert(now);
                }
                MemberChange::SatelliteReturned { uuid, after_ms, .. } => {
                    *after_ms = self
                        .missing_since
                        .remove(uuid)
                        .map(|since| duration_ms(now.saturating_duration_since(since)));
                }
                _ => {}
            }
        }
        // A satellite that is neither missing nor listed any more (unbonded
        // while missing) stops being timed.
        let still_missing = missing_satellites(&next);
        self.missing_since
            .retain(|uuid, _| still_missing.contains_key(uuid));
        self.prev = Some(next);
        changes
    }
}

/// Whole milliseconds in `d`, saturating.
fn duration_ms(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sonos::test_fixtures::{
        with_device_attr, HT_HOUSEHOLD, HT_HOUSEHOLD_KITCHEN_VANISHED, HT_HOUSEHOLD_LR_MISSING,
        HT_LR_UUID, HT_PRIMARY_UUID, HT_SUB_UUID, KITCHEN_UUID,
    };
    use crate::sonos::zone_groups::parse_household_topology;

    fn household(xml: &str) -> HouseholdTopology {
        parse_household_topology(xml)
    }

    #[test]
    fn an_unchanged_household_has_no_changes() {
        assert!(diff(&household(HT_HOUSEHOLD), &household(HT_HOUSEHOLD)).is_empty());
        assert_eq!(summarize(&[]), "unchanged");
    }

    #[test]
    fn a_dropped_surround_is_reported_missing() {
        let changes = diff(
            &household(HT_HOUSEHOLD),
            &household(HT_HOUSEHOLD_LR_MISSING),
        );

        assert_eq!(
            changes,
            vec![MemberChange::SatelliteMissing {
                primary_uuid: HT_PRIMARY_UUID.to_string(),
                uuid: HT_LR_UUID.to_string(),
                role: "LR".to_string(),
            }]
        );
    }

    #[test]
    fn a_satellite_still_missing_is_not_reported_again() {
        let missing = household(HT_HOUSEHOLD_LR_MISSING);
        assert!(diff(&missing, &missing).is_empty());
    }

    #[test]
    fn a_returning_surround_is_reported_returned() {
        let changes = diff(
            &household(HT_HOUSEHOLD_LR_MISSING),
            &household(HT_HOUSEHOLD),
        );

        assert_eq!(
            changes,
            vec![MemberChange::SatelliteReturned {
                primary_uuid: HT_PRIMARY_UUID.to_string(),
                uuid: HT_LR_UUID.to_string(),
                role: "LR".to_string(),
                after_ms: None,
            }]
        );
    }

    #[test]
    fn a_bootseq_bump_is_reported_as_a_reboot() {
        let rebooted = with_device_attr(HT_HOUSEHOLD, HT_SUB_UUID, "BootSeq", "32");

        let changes = diff(&household(HT_HOUSEHOLD), &household(&rebooted));

        assert_eq!(
            changes,
            vec![MemberChange::DeviceRebooted {
                uuid: HT_SUB_UUID.to_string(),
                from: 31,
                to: 32,
            }]
        );
    }

    #[test]
    fn a_bootseq_that_goes_down_is_not_a_reboot() {
        let reset = with_device_attr(HT_HOUSEHOLD, HT_SUB_UUID, "BootSeq", "1");
        assert!(diff(&household(HT_HOUSEHOLD), &household(&reset)).is_empty());
    }

    #[test]
    fn a_vanished_device_is_reported_once() {
        let prev = household(HT_HOUSEHOLD);
        let next = household(HT_HOUSEHOLD_KITCHEN_VANISHED);

        // The Kitchen's own single-member group disappearing is not a leave:
        // nothing but its coordinator was ever in it.
        assert_eq!(
            diff(&prev, &next),
            vec![MemberChange::Vanished {
                uuid: KITCHEN_UUID.to_string(),
                reason: Some("powered off".to_string()),
            }]
        );
        assert!(diff(&next, &next).is_empty());
    }

    #[test]
    fn a_wireless_mode_change_is_reported_as_a_radio_change() {
        let changed = with_device_attr(HT_HOUSEHOLD, HT_LR_UUID, "WirelessMode", "1");

        let changes = diff(&household(HT_HOUSEHOLD), &household(&changed));

        assert_eq!(
            changes,
            vec![MemberChange::RadioChanged {
                uuid: HT_LR_UUID.to_string(),
                field: RadioField::WirelessMode,
                from: Some(0),
                to: Some(1),
            }]
        );
    }

    #[test]
    fn a_field_one_snapshot_omits_is_not_a_change() {
        let omitted = HT_HOUSEHOLD.replacen(r#" ChannelFreq="2437""#, "", 1);
        let prev = household(HT_HOUSEHOLD);
        let next = household(&omitted);
        assert_eq!(
            next.device(HT_PRIMARY_UUID).unwrap().radio.channel_freq,
            None
        );

        assert!(diff(&prev, &next).is_empty());
    }

    #[test]
    fn joining_a_group_is_reported_on_the_group_joined() {
        // The Kitchen joins the Living Room: its own group goes, and it is
        // listed as a member of the home theatre's group.
        let kitchen_member = format!(
            r#"<ZoneGroupMember UUID="{KITCHEN_UUID}" Location="http://192.168.2.210:1400/xml/device_description.xml" ZoneName="Kitchen" BootSeq="57"/>"#
        );
        let joined = HT_HOUSEHOLD_KITCHEN_VANISHED
            .replace(
                "</ZoneGroupMember></ZoneGroup>",
                &format!("</ZoneGroupMember>{kitchen_member}</ZoneGroup>"),
            )
            .replace(
                r#"<VanishedDevices><Device UUID="RINCON_48A6B8CCCCCC01400" ZoneName="Kitchen" Reason="powered off"/></VanishedDevices>"#,
                "<VanishedDevices></VanishedDevices>",
            );

        let changes = diff(&household(HT_HOUSEHOLD), &household(&joined));

        assert_eq!(
            changes,
            vec![MemberChange::MembersChanged {
                coordinator_uuid: HT_PRIMARY_UUID.to_string(),
                joined: vec![KITCHEN_UUID.to_string()],
                left: vec![],
            }]
        );
    }

    #[test]
    fn the_first_snapshot_reports_satellites_already_missing() {
        let mut topology = TopologyDiff::new();
        let changes = topology.observe(household(HT_HOUSEHOLD_LR_MISSING), Instant::now());

        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind(), "satellite_missing");
    }

    #[test]
    fn a_return_says_how_long_the_satellite_was_missing() {
        let start = Instant::now();
        let mut topology = TopologyDiff::new();
        assert!(topology.observe(household(HT_HOUSEHOLD), start).is_empty());
        topology.observe(household(HT_HOUSEHOLD_LR_MISSING), start);
        // Still missing on the next refresh: the clock keeps its first sighting.
        topology.observe(
            household(HT_HOUSEHOLD_LR_MISSING),
            start + Duration::from_secs(30),
        );

        let changes = topology.observe(household(HT_HOUSEHOLD), start + Duration::from_secs(95));

        assert_eq!(
            changes,
            vec![MemberChange::SatelliteReturned {
                primary_uuid: HT_PRIMARY_UUID.to_string(),
                uuid: HT_LR_UUID.to_string(),
                role: "LR".to_string(),
                after_ms: Some(95_000),
            }]
        );
    }

    #[test]
    fn an_empty_answer_is_not_everything_leaving() {
        let mut topology = TopologyDiff::new();
        topology.observe(household(HT_HOUSEHOLD), Instant::now());

        assert!(topology
            .observe(HouseholdTopology::default(), Instant::now())
            .is_empty());
        // And the real snapshot is still the one compared against.
        assert!(topology
            .observe(household(HT_HOUSEHOLD), Instant::now())
            .is_empty());
    }

    #[test]
    fn a_summary_counts_each_kind() {
        let changes = diff(
            &household(HT_HOUSEHOLD),
            &household(&with_device_attr(
                HT_HOUSEHOLD_LR_MISSING,
                HT_SUB_UUID,
                "BootSeq",
                "32",
            )),
        );

        assert_eq!(
            summarize(&changes),
            "2 change(s): satellite_missing=1 rebooted=1"
        );
    }

    #[test]
    fn a_change_serializes_with_its_kind() {
        let change = MemberChange::SatelliteMissing {
            primary_uuid: HT_PRIMARY_UUID.to_string(),
            uuid: HT_LR_UUID.to_string(),
            role: "LR".to_string(),
        };

        assert_eq!(
            serde_json::to_value(&change).unwrap(),
            serde_json::json!({
                "kind": "satelliteMissing",
                "primaryUuid": HT_PRIMARY_UUID,
                "uuid": HT_LR_UUID,
                "role": "LR",
            })
        );
    }
}
