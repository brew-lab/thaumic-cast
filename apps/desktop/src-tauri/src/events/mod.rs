//! Typed broadcast events for real-time client communication.
//!
//! This module provides:
//! - [`EventEmitter`] trait for domain services to emit events
//! - [`BroadcastEventBridge`] for WebSocket transport
//! - [`BroadcastEvent`] enum for transport serialization

mod bridge;
mod emitter;

pub use bridge::BroadcastEventBridge;
pub use emitter::EventEmitter;

use serde::Serialize;

use crate::sonos::gena::SonosEvent;
use crate::types::ZoneGroup;

/// Events broadcast to WebSocket clients.
///
/// This enum categorizes all real-time events that can be sent to connected
/// clients. Each category has its own inner event type with specific variants.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "category", rename_all = "camelCase")]
pub enum BroadcastEvent {
    /// Events from Sonos speakers (GENA notifications).
    Sonos(SonosEvent),

    /// Events related to audio streaming.
    Stream(StreamEvent),

    /// Events related to network health and connectivity.
    Network(NetworkEvent),

    /// Events from topology discovery.
    Topology(TopologyEvent),
}

/// Events related to audio stream state changes.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    /// A new stream was created.
    Created {
        /// The unique identifier for the stream.
        #[serde(rename = "streamId")]
        stream_id: String,
        /// Unix timestamp in milliseconds.
        timestamp: u64,
    },
    /// A stream was removed/ended.
    Ended {
        /// The unique identifier for the stream.
        #[serde(rename = "streamId")]
        stream_id: String,
        /// Unix timestamp in milliseconds.
        timestamp: u64,
    },
    /// Playback started on a speaker (stream linked to speaker).
    PlaybackStarted {
        /// The stream ID being played.
        #[serde(rename = "streamId")]
        stream_id: String,
        /// The speaker IP address receiving the stream.
        #[serde(rename = "speakerIp")]
        speaker_ip: String,
        /// The full URL the speaker is fetching audio from.
        #[serde(rename = "streamUrl")]
        stream_url: String,
        /// Unix timestamp in milliseconds.
        timestamp: u64,
    },
    /// Playback stopped on a speaker.
    ///
    /// Reserved for future use (partial speaker removal).
    #[allow(dead_code)]
    PlaybackStopped {
        /// The speaker IP address that stopped playback.
        #[serde(rename = "speakerIp")]
        speaker_ip: String,
        /// Unix timestamp in milliseconds.
        timestamp: u64,
    },
}

impl From<SonosEvent> for BroadcastEvent {
    fn from(event: SonosEvent) -> Self {
        BroadcastEvent::Sonos(event)
    }
}

impl From<StreamEvent> for BroadcastEvent {
    fn from(event: StreamEvent) -> Self {
        BroadcastEvent::Stream(event)
    }
}

/// Network health status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NetworkHealth {
    /// All systems operational.
    Ok,
    /// Speakers discovered but communication is failing.
    Degraded,
}

impl Default for NetworkHealth {
    fn default() -> Self {
        Self::Ok
    }
}

/// Events related to network health and speaker reachability.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum NetworkEvent {
    /// Network health status changed.
    HealthChanged {
        /// Current health status.
        health: NetworkHealth,
        /// Human-readable reason for the status (if degraded).
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        /// Unix timestamp in milliseconds.
        timestamp: u64,
    },
}

impl From<NetworkEvent> for BroadcastEvent {
    fn from(event: NetworkEvent) -> Self {
        BroadcastEvent::Network(event)
    }
}

/// Events from topology discovery operations.
///
/// These events represent results from active discovery (SSDP + SOAP),
/// as opposed to push notifications from speakers (GENA).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TopologyEvent {
    /// Zone groups discovered or updated via SOAP query.
    GroupsDiscovered {
        /// The discovered zone groups.
        groups: Vec<ZoneGroup>,
        /// Unix timestamp in milliseconds.
        timestamp: u64,
    },
}

impl From<TopologyEvent> for BroadcastEvent {
    fn from(event: TopologyEvent) -> Self {
        BroadcastEvent::Topology(event)
    }
}
