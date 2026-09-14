//! Event system for real-time client communication.
//!
//! This module provides:
//! - [`EventEmitter`] trait for domain services to emit events
//! - [`BroadcastEventBridge`] for WebSocket transport
//! - Event types for various domains (streams, network, etc.)
//!
//! The `SonosEvent` type is defined in [`crate::sonos::gena`] and re-exported here.

mod bridge;
mod emitter;

pub use bridge::BroadcastEventBridge;
pub use emitter::EventEmitter;

// Re-export SonosEvent from sonos::gena for convenience
pub use crate::sonos::gena::SonosEvent;

use serde::{Deserialize, Serialize};

/// Reasons for removing a speaker from an active cast session.
///
/// - `SourceChanged`: User switched Sonos to another source (Spotify, AirPlay, etc.)
/// - `PlaybackStopped`: Playback stopped on the speaker (system/network issue)
/// - `SpeakerStopped`: Speaker stopped unexpectedly (e.g., stream killed due to underflow)
/// - `UserRemoved`: User explicitly removed the speaker via UI
/// - `SpeakerTakenOver`: Another cast client started its own stream on this speaker
///
/// Wire strings are snake_case and are part of the client protocol: never
/// rename an existing variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeakerRemovalReason {
    SourceChanged,
    PlaybackStopped,
    SpeakerStopped,
    UserRemoved,
    SpeakerTakenOver,
}

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
        /// Reason for stopping (optional for backward compat).
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<SpeakerRemovalReason>,
        /// Unix timestamp in milliseconds.
        timestamp: u64,
    },
    /// Failed to stop playback on a speaker.
    PlaybackStopFailed {
        /// The stream ID that failed to stop.
        #[serde(rename = "streamId")]
        stream_id: String,
        /// The speaker IP address that failed to stop.
        #[serde(rename = "speakerIp")]
        speaker_ip: String,
        /// Error message describing the failure.
        error: String,
        /// Reason for the attempted stop (optional for backward compat).
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<SpeakerRemovalReason>,
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

/// Quality of the network path between this machine and one speaker, judged
/// from the round trips of our own position polls to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkQuality {
    /// No latency spikes in the last minute.
    Good,
    /// A few spikes: short dropouts are possible on a small jitter buffer.
    Degraded,
    /// Repeated spikes or failed round trips: audio will stutter unless the
    /// jitter buffer is large enough to ride them out.
    Poor,
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
    /// The network path to a playing speaker changed quality.
    ///
    /// Sent on transitions only. Names no stream, so it reaches every client;
    /// the path to a speaker is shared by everyone casting to it.
    SpeakerLinkQuality {
        /// The speaker the path leads to.
        #[serde(rename = "speakerIp")]
        speaker_ip: String,
        /// The judged quality.
        quality: LinkQuality,
        /// Median round trip over the last minute, in milliseconds.
        #[serde(rename = "rttMedianMs")]
        rtt_median_ms: u32,
        /// Worst round trip over the last minute, in milliseconds.
        #[serde(rename = "rttMaxMs")]
        rtt_max_ms: u32,
        /// Round trips over the spike threshold in the last minute.
        #[serde(rename = "spikesPerMinute")]
        spikes_per_minute: u32,
        /// Round trips that failed outright in the last minute.
        #[serde(rename = "failuresPerMinute")]
        failures_per_minute: u32,
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
        /// The discovered zone groups.
        groups: Vec<crate::sonos::types::ZoneGroup>,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire strings are protocol, shared with the extension's event
    /// handling — a rename here silently breaks the client.
    #[test]
    fn speaker_removal_reason_wire_strings() {
        let wire = |r: SpeakerRemovalReason| serde_json::to_string(&r).unwrap();

        assert_eq!(
            wire(SpeakerRemovalReason::SourceChanged),
            "\"source_changed\""
        );
        assert_eq!(
            wire(SpeakerRemovalReason::PlaybackStopped),
            "\"playback_stopped\""
        );
        assert_eq!(
            wire(SpeakerRemovalReason::SpeakerStopped),
            "\"speaker_stopped\""
        );
        assert_eq!(wire(SpeakerRemovalReason::UserRemoved), "\"user_removed\"");
        assert_eq!(
            wire(SpeakerRemovalReason::SpeakerTakenOver),
            "\"speaker_taken_over\""
        );
    }
}
