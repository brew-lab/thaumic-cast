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
