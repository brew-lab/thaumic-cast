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

    /// Events related to latency measurement.
    Latency(LatencyEvent),
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum NetworkHealth {
    /// All systems operational.
    #[default]
    Ok,
    /// Speakers discovered but communication is failing.
    Degraded,
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

/// Events related to audio latency measurement.
///
/// These events report measured latency between audio source and Sonos playback,
/// enabling video synchronization and delay compensation.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LatencyEvent {
    /// Latency measurement updated for a speaker.
    Updated {
        /// The stream ID being measured.
        #[serde(rename = "streamId")]
        stream_id: String,
        /// The speaker IP address where latency was measured.
        #[serde(rename = "speakerIp")]
        speaker_ip: String,
        /// The playback epoch ID (increments on Sonos reconnect).
        /// Extension can detect epoch changes to trigger re-lock.
        #[serde(rename = "epochId")]
        epoch_id: u64,
        /// Measured latency in milliseconds (smoothed EMA).
        #[serde(rename = "latencyMs")]
        latency_ms: u64,
        /// Measurement jitter in milliseconds (standard deviation).
        /// Useful for extension to determine when estimates are stable.
        #[serde(rename = "jitterMs")]
        jitter_ms: u64,
        /// Confidence score for the measurement (0.0 - 1.0).
        confidence: f32,
        /// Unix timestamp in milliseconds.
        timestamp: u64,
    },
    /// Latency measurement has gone stale (no valid position data).
    ///
    /// Emitted when we stop receiving valid position info from Sonos for this
    /// stream (e.g., speaker switched tracks, network issues, playback stopped).
    /// The extension should freeze its correction loop and optionally show UI.
    Stale {
        /// The stream ID that went stale.
        #[serde(rename = "streamId")]
        stream_id: String,
        /// The speaker IP address that went stale.
        #[serde(rename = "speakerIp")]
        speaker_ip: String,
        /// The epoch ID that went stale (helps detect reconnects).
        #[serde(rename = "epochId")]
        epoch_id: u64,
        /// Unix timestamp in milliseconds.
        timestamp: u64,
    },
}

impl From<LatencyEvent> for BroadcastEvent {
    fn from(event: LatencyEvent) -> Self {
        BroadcastEvent::Latency(event)
    }
}
