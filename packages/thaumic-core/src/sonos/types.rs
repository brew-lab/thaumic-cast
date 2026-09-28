//! Sonos domain types for zone groups and speakers.
//!
//! These types represent the logical structure of Sonos zones as discovered
//! via UPnP/SOAP. They are used throughout the application for state management
//! and API responses.

use serde::Serialize;
use thiserror::Error;

// ─────────────────────────────────────────────────────────────────────────────
// Transport State
// ─────────────────────────────────────────────────────────────────────────────

/// Playback transport state of a Sonos speaker.
///
/// Represents the current playback state as reported by the AVTransport service.
/// Serializes to match TypeScript TransportState enum: "Playing", "PAUSED_PLAYBACK", "Stopped", "Transitioning"
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum TransportState {
    Playing,
    #[serde(rename = "PAUSED_PLAYBACK")]
    Paused,
    Stopped,
    Transitioning,
}

impl std::fmt::Display for TransportState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Playing => write!(f, "Playing"),
            Self::Paused => write!(f, "Paused"),
            Self::Stopped => write!(f, "Stopped"),
            Self::Transitioning => write!(f, "Transitioning"),
        }
    }
}

/// Error returned when parsing an unknown transport state string.
#[derive(Debug, Clone, Error)]
#[error("unknown transport state")]
pub struct ParseTransportStateError;

impl std::str::FromStr for TransportState {
    type Err = ParseTransportStateError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "PLAYING" => Ok(Self::Playing),
            "PAUSED_PLAYBACK" | "PAUSED" => Ok(Self::Paused),
            "STOPPED" => Ok(Self::Stopped),
            "TRANSITIONING" => Ok(Self::Transitioning),
            _ => Err(ParseTransportStateError),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Zone Groups
// ─────────────────────────────────────────────────────────────────────────────

/// A speaker within a Sonos zone group.
///
/// Represents an individual Sonos device that is part of a zone group.
/// This includes both primary speakers and satellites (surround speakers, subwoofers).
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ZoneGroupMember {
    /// Unique identifier in RINCON_xxxxx format.
    pub uuid: String,
    /// Local IP address of the speaker.
    pub ip: String,
    /// User-configured room name.
    pub zone_name: String,
    /// Device model or channel role.
    ///
    /// For speakers in a home theater setup, this may be a channel role like
    /// "Soundbar", "Subwoofer", "Surround Left", or "Surround Right".
    /// Otherwise, it's the model name extracted from the device icon (e.g., "one", "arc").
    /// Falls back to "Speaker" if neither is available.
    pub model: String,
}

/// A Sonos zone group (speakers playing in sync).
///
/// Represents a group of Sonos speakers that play audio together.
/// Each group has a coordinator that controls playback for the group.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ZoneGroup {
    /// Zone group identifier.
    pub id: String,
    /// Human-readable name (typically the coordinator's zone name).
    pub name: String,
    /// UUID of the group coordinator.
    pub coordinator_uuid: String,
    /// IP address of the group coordinator.
    pub coordinator_ip: String,
    /// All speakers in this group (including the coordinator).
    ///
    /// Note: Zone Bridges (BOOST devices) are filtered out as they cannot play audio.
    pub members: Vec<ZoneGroupMember>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Household Topology
// ─────────────────────────────────────────────────────────────────────────────

/// Radio and link attributes Sonos reports for one device in `ZoneGroupState`.
///
/// Kept as the raw numbers Sonos sends: only a change matters here, and the
/// meaning of some codes (`WirelessMode` in particular) is undocumented.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RadioInfo {
    /// `ChannelFreq`: the channel frequency the device's radio is on, in MHz.
    pub channel_freq: Option<u32>,
    /// `WirelessMode`: how the device joins the network (SonosNet or the home
    /// Wi-Fi), as Sonos codes it.
    pub wireless_mode: Option<u32>,
    /// `BehindWifiExtender`: non-zero when the device reaches the network
    /// through a Wi-Fi extender.
    pub behind_wifi_extender: Option<u32>,
    /// `EthLink`: non-zero when the device has a wired Ethernet link.
    pub eth_link: Option<u32>,
}

/// One device as `ZoneGroupState` describes it: a group member, a
/// home-theatre satellite or a zone bridge.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HouseholdDevice {
    /// Unique identifier in RINCON_xxxxx format.
    pub uuid: String,
    /// Local IP address.
    pub ip: String,
    /// User-configured room name.
    pub zone_name: String,
    /// `BootSeq`: goes up each time the device boots.
    pub boot_seq: Option<u32>,
    /// `Invisible`: set on devices bonded into another (satellites, the second
    /// speaker of a stereo pair), which the Sonos app does not list as rooms.
    pub invisible: bool,
    /// The device's radio and link.
    pub radio: RadioInfo,
}

/// A home-theatre satellite (subwoofer or surround) bonded to a member.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SatelliteInfo {
    /// The satellite itself.
    pub device: HouseholdDevice,
    /// Its channels in the primary's `HTSatChanMapSet` (`SW`, `LR`, `RR`), if
    /// the map names it.
    pub role: Option<String>,
}

/// A zone group member, with the satellites bonded to it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HouseholdMember {
    /// The member itself.
    pub device: HouseholdDevice,
    /// Whether it is a zone bridge (a BOOST), which plays no audio.
    pub zone_bridge: bool,
    /// `HTSatChanMapSet`: which device plays which channels, when the member
    /// is a home-theatre primary (`RINCON_A:LF,RF;RINCON_B:SW;...`).
    pub ht_sat_chan_map: Option<String>,
    /// The satellites Sonos currently lists under the member.
    pub satellites: Vec<SatelliteInfo>,
}

impl HouseholdMember {
    /// Satellites the member's channel map names that are not listed under
    /// it, as `(uuid, channels)` in map order: the shape Sonos reports while a
    /// bonded satellite has dropped off.
    pub fn missing_satellites(&self) -> Vec<(String, String)> {
        let Some(map) = &self.ht_sat_chan_map else {
            return Vec::new();
        };
        map.split(';')
            .filter_map(|entry| entry.split_once(':'))
            .filter(|(uuid, _)| {
                *uuid != self.device.uuid && !self.satellites.iter().any(|s| s.device.uuid == *uuid)
            })
            .map(|(uuid, channels)| (uuid.to_string(), channels.to_string()))
            .collect()
    }
}

/// A zone group, with its members' satellites kept apart from the members.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HouseholdGroup {
    /// Zone group identifier.
    pub id: String,
    /// UUID of the group coordinator.
    pub coordinator_uuid: String,
    /// Every member, zone bridges included.
    pub members: Vec<HouseholdMember>,
}

/// A device Sonos lists under `VanishedDevices`: known to the household but
/// gone from it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct VanishedDevice {
    /// Unique identifier in RINCON_xxxxx format.
    pub uuid: String,
    /// User-configured room name, when given.
    pub zone_name: Option<String>,
    /// Why Sonos considers it gone (for example `powered off`), when given.
    pub reason: Option<String>,
}

/// The whole household as `ZoneGroupState` describes it.
///
/// Unlike [`ZoneGroup`], which flattens satellites into members and drops
/// zone bridges for display, this keeps the structure and the attributes that
/// say how each device is doing, so two snapshots can be compared.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HouseholdTopology {
    /// Every zone group.
    pub groups: Vec<HouseholdGroup>,
    /// Devices Sonos lists as vanished.
    pub vanished: Vec<VanishedDevice>,
}

impl HouseholdTopology {
    /// Every device: each member, followed by its satellites.
    pub fn devices(&self) -> impl Iterator<Item = &HouseholdDevice> {
        self.groups.iter().flat_map(|g| {
            g.members.iter().flat_map(|m| {
                std::iter::once(&m.device).chain(m.satellites.iter().map(|s| &s.device))
            })
        })
    }

    /// Every member of every group.
    pub fn members(&self) -> impl Iterator<Item = &HouseholdMember> {
        self.groups.iter().flat_map(|g| g.members.iter())
    }

    /// The device with this UUID.
    pub fn device(&self, uuid: &str) -> Option<&HouseholdDevice> {
        self.devices().find(|d| d.uuid == uuid)
    }

    /// The coordinator of the group the device with this UUID plays in,
    /// whether it is a member or a member's satellite.
    pub fn coordinator_of(&self, uuid: &str) -> Option<&HouseholdDevice> {
        let group = self.groups.iter().find(|g| {
            g.members.iter().any(|m| {
                m.device.uuid == uuid || m.satellites.iter().any(|s| s.device.uuid == uuid)
            })
        })?;
        self.device(&group.coordinator_uuid)
    }

    /// Each device's UUID by its IP address.
    pub fn uuid_by_ip(&self) -> std::collections::HashMap<String, String> {
        self.devices()
            .map(|d| (d.ip.clone(), d.uuid.clone()))
            .collect()
    }

    /// How many satellites are listed, and how many channel maps name one
    /// that is not.
    pub fn satellite_counts(&self) -> (usize, usize) {
        self.members().fold((0, 0), |(listed, missing), m| {
            (
                listed + m.satellites.len(),
                missing + m.missing_satellites().len(),
            )
        })
    }
}

/// One `GetZoneGroupState` answer, read two ways: as the groups shown to
/// users, and as the household structure compared between refreshes.
#[derive(Debug, Clone, Default)]
pub struct ZoneGroupSnapshot {
    /// The zone groups, satellites flattened into members and zone bridges
    /// left out.
    pub groups: Vec<ZoneGroup>,
    /// The household with its structure kept.
    pub household: HouseholdTopology,
}

// ─────────────────────────────────────────────────────────────────────────────
// Playback Position
// ─────────────────────────────────────────────────────────────────────────────

/// Playback position information from a Sonos speaker.
///
/// Returned by the AVTransport GetPositionInfo action. Used for latency
/// measurement by comparing stream position against reported playback position.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PositionInfo {
    /// URI of the currently playing track.
    pub track_uri: String,
    /// Relative playback position in milliseconds.
    ///
    /// Parsed from the SOAP `RelTime` field for easier calculations.
    pub rel_time_ms: u64,
}

impl PositionInfo {
    /// Parses a time string in "H:MM:SS" or "HH:MM:SS" format to milliseconds.
    ///
    /// # Arguments
    /// * `time_str` - Time string in format "H:MM:SS" or "HH:MM:SS"
    ///
    /// # Returns
    /// Time in milliseconds, or 0 if parsing fails.
    pub fn parse_time_to_ms(time_str: &str) -> u64 {
        let parts: Vec<&str> = time_str.split(':').collect();
        if parts.len() != 3 {
            return 0;
        }

        let hours: u64 = parts[0].parse().unwrap_or(0);
        let minutes: u64 = parts[1].parse().unwrap_or(0);
        let seconds: u64 = parts[2].parse().unwrap_or(0);

        (hours * 3600 + minutes * 60 + seconds) * 1000
    }
}
