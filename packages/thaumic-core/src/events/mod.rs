//! Event system for real-time client communication.
//!
//! This module provides:
//! - [`EventEmitter`] trait for domain services to emit events
//! - Event types for various domains (streams, Sonos, network, etc.)
//!
//! The actual transport implementation (WebSocket, SSE, etc.) is handled
//! separately in the `api` module using [`BroadcastEventBridge`].

mod emitter;

pub use emitter::{EventEmitter, LoggingEventEmitter, NoopEventEmitter};

use serde::Serialize;

/// Events broadcast to clients.
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

/// Events from Sonos speakers via GENA notifications.
///
/// These events are pushed by Sonos speakers when their state changes.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SonosEvent {
    /// Transport state changed (play, pause, stop).
    TransportChanged {
        /// IP address of the speaker.
        #[serde(rename = "speakerIp")]
        speaker_ip: String,
        /// New transport state.
        state: String,
        /// Unix timestamp in milliseconds.
        timestamp: u64,
    },
    /// Group volume changed.
    VolumeChanged {
        /// IP address of the group coordinator.
        #[serde(rename = "coordinatorIp")]
        coordinator_ip: String,
        /// New volume level (0-100).
        volume: u8,
        /// Unix timestamp in milliseconds.
        timestamp: u64,
    },
    /// Group mute state changed.
    MuteChanged {
        /// IP address of the group coordinator.
        #[serde(rename = "coordinatorIp")]
        coordinator_ip: String,
        /// Whether the group is muted.
        muted: bool,
        /// Unix timestamp in milliseconds.
        timestamp: u64,
    },
    /// Zone topology changed (speakers grouped/ungrouped).
    TopologyChanged {
        /// Unix timestamp in milliseconds.
        timestamp: u64,
    },
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
    /// Playback started on a speaker.
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
    PlaybackStopped {
        /// The stream ID that was stopped.
        #[serde(rename = "streamId")]
        stream_id: String,
        /// The speaker IP address that stopped playback.
        #[serde(rename = "speakerIp")]
        speaker_ip: String,
        /// Unix timestamp in milliseconds.
        timestamp: u64,
    },
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

/// Events from topology discovery operations.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TopologyEvent {
    /// Zone groups discovered or updated.
    GroupsDiscovered {
        /// Number of groups discovered.
        #[serde(rename = "groupCount")]
        group_count: usize,
        /// Unix timestamp in milliseconds.
        timestamp: u64,
    },
}

/// Events related to audio latency measurement.
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
        /// The playback epoch ID.
        #[serde(rename = "epochId")]
        epoch_id: u64,
        /// Measured latency in milliseconds.
        #[serde(rename = "latencyMs")]
        latency_ms: u64,
        /// Measurement jitter in milliseconds.
        #[serde(rename = "jitterMs")]
        jitter_ms: u64,
        /// Confidence score (0.0 - 1.0).
        confidence: f32,
        /// Unix timestamp in milliseconds.
        timestamp: u64,
    },
    /// Latency measurement has gone stale.
    Stale {
        /// The stream ID that went stale.
        #[serde(rename = "streamId")]
        stream_id: String,
        /// The speaker IP address that went stale.
        #[serde(rename = "speakerIp")]
        speaker_ip: String,
        /// The epoch ID that went stale.
        #[serde(rename = "epochId")]
        epoch_id: u64,
        /// Unix timestamp in milliseconds.
        timestamp: u64,
    },
}

// From implementations for converting inner events to BroadcastEvent
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

impl From<NetworkEvent> for BroadcastEvent {
    fn from(event: NetworkEvent) -> Self {
        BroadcastEvent::Network(event)
    }
}

impl From<TopologyEvent> for BroadcastEvent {
    fn from(event: TopologyEvent) -> Self {
        BroadcastEvent::Topology(event)
    }
}

impl From<LatencyEvent> for BroadcastEvent {
    fn from(event: LatencyEvent) -> Self {
        BroadcastEvent::Latency(event)
    }
}
