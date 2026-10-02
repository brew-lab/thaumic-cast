//! One change between two household topology snapshots, as it rides the
//! topology event.

use std::fmt;

use serde::Serialize;

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
