//! Sonos UPnP service definitions.
//!
//! This module provides a single source of truth for Sonos service URNs,
//! control paths, and event paths used by both SOAP commands and GENA subscriptions.

use serde::Serialize;

/// Sonos UPnP services used for control and event subscriptions.
#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SonosService {
    /// Audio/Video transport control (play, pause, stop, seek).
    AVTransport,
    /// Group volume and mute control (for coordinator speakers).
    GroupRenderingControl,
    /// Individual speaker volume and mute control.
    /// Used for per-room control during synchronized multi-room playback.
    RenderingControl,
    /// Zone group topology and membership information.
    ZoneGroupTopology,
}

impl SonosService {
    /// Returns the UPnP service URN for SOAP requests.
    #[must_use]
    pub fn urn(&self) -> &'static str {
        match self {
            Self::AVTransport => "urn:schemas-upnp-org:service:AVTransport:1",
            Self::GroupRenderingControl => "urn:schemas-upnp-org:service:GroupRenderingControl:1",
            Self::RenderingControl => "urn:schemas-upnp-org:service:RenderingControl:1",
            Self::ZoneGroupTopology => "urn:schemas-upnp-org:service:ZoneGroupTopology:1",
        }
    }

    /// Returns the UPnP control endpoint path for SOAP requests.
    #[must_use]
    pub fn control_path(&self) -> &'static str {
        match self {
            Self::AVTransport => "/MediaRenderer/AVTransport/Control",
            Self::GroupRenderingControl => "/MediaRenderer/GroupRenderingControl/Control",
            Self::RenderingControl => "/MediaRenderer/RenderingControl/Control",
            Self::ZoneGroupTopology => "/ZoneGroupTopology/Control",
        }
    }

    /// Returns the UPnP event endpoint path for GENA subscriptions.
    #[must_use]
    pub fn event_path(&self) -> &'static str {
        match self {
            Self::AVTransport => "/MediaRenderer/AVTransport/Event",
            Self::GroupRenderingControl => "/MediaRenderer/GroupRenderingControl/Event",
            Self::RenderingControl => "/MediaRenderer/RenderingControl/Event",
            Self::ZoneGroupTopology => "/ZoneGroupTopology/Event",
        }
    }

    /// Returns a human-readable name for this service.
    #[must_use]
    pub fn name(&self) -> &'static str {
        match self {
            Self::AVTransport => "AVTransport",
            Self::GroupRenderingControl => "GroupRenderingControl",
            Self::RenderingControl => "RenderingControl",
            Self::ZoneGroupTopology => "ZoneGroupTopology",
        }
    }
}
