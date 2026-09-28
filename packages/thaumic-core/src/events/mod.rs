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
    /// Audio from the casting browser reached this machine late often
    /// enough that every speaker on the stream had gaps: the smoothing
    /// (jitter buffer) ran dry at least twice in a minute.
    ///
    /// Emitted from a PCM connection's cadence, at most once every ten
    /// minutes per stream (see [`crate::stream::ingest_gaps`]). Names its
    /// stream, so it only reaches the client that owns it while it is live.
    IngestGaps {
        /// The stream whose audio arrived late.
        #[serde(rename = "streamId")]
        stream_id: String,
        /// Gaps counted in the last minute.
        #[serde(rename = "gapsLastMinute")]
        gaps_last_minute: u32,
        /// The longest of those gaps in the audio's arrival, in ms: the
        /// smoothing that ran dry plus the silence played after it.
        #[serde(rename = "worstGapMs")]
        worst_gap_ms: u32,
        /// The smoothing the stream runs with, in ms.
        #[serde(rename = "smoothingMs")]
        smoothing_ms: u32,
        /// The smallest smoothing step that would have covered the worst gap
        /// with 50 ms to spare. Absent when no step offered does: the gap is
        /// more than smoothing can cover.
        #[serde(
            rename = "suggestedSmoothingMs",
            skip_serializing_if = "Option::is_none"
        )]
        suggested_smoothing_ms: Option<u32>,
        /// Unix timestamp in milliseconds.
        timestamp: u64,
    },
    /// The companion's speaker-side audio settings changed. Sent to every
    /// client, so what they show about the speaker head start and the
    /// wording of their speaker notices never goes stale. Each setting
    /// applies from a speaker's next connection.
    CompanionAudioChanged {
        /// The settings as they now stand.
        #[serde(flatten)]
        audio: CompanionAudio,
        /// Unix timestamp in milliseconds.
        timestamp: u64,
    },
}

/// The companion's speaker-side audio settings, as clients show them and
/// word their speaker notices by. Owned by the companion: clients only
/// display them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionAudio {
    /// The speaker head start (PCM connect burst) each speaker is sent when
    /// it connects, in ms, after any environment override. `0` is off.
    pub head_start_ms: u32,
    /// Whether an environment variable fixes the head start, so it can only
    /// be changed there.
    pub head_start_fixed: bool,
    /// Whether the speaker monitor, and with it the speaker notices, is on
    /// for new connections.
    pub speaker_monitor: bool,
}

impl CompanionAudio {
    /// The settings new connections get under `config`, with the
    /// environment overrides applied.
    pub fn from_config(config: &crate::state::Config) -> Self {
        use crate::services::latency_monitor::speaker_monitor_enabled;
        use crate::stream::cadence::{pcm_connect_burst_env_override, pcm_connect_burst_ms};
        Self {
            head_start_ms: u32::try_from(pcm_connect_burst_ms(config.pcm_connect_burst_ms))
                .unwrap_or(u32::MAX),
            head_start_fixed: pcm_connect_burst_env_override().is_some(),
            speaker_monitor: speaker_monitor_enabled(config.speaker_monitor),
        }
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

/// Quality of the network path between this machine and one speaker, judged
/// from the TCP counters of the connection the speaker fetches audio over
/// (see [`crate::api::link::LinkJudge`]).
///
/// For the log and as one input to the speaker notices: trouble on the link
/// alone is never a notice, since the speaker head start usually rides it
/// out. The jitter buffer (smoothing) does not help here at all: it only
/// evens out how audio reaches this machine, not how it leaves it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkQuality {
    /// No retransmissions, timeouts or round-trip spikes in the last minute.
    Good,
    /// A few troubled samples in the last minute.
    Degraded,
    /// Repeated trouble or a retransmission timeout in the last minute: the
    /// link stalled for longer than one resend.
    Poor,
}

/// The speaker monitor's verdict on one speaker's buffer.
///
/// Wire strings are part of the client protocol: never rename a variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SpeakerHealthState {
    /// Measuring, but the estimate is not yet precise or settled.
    Locking,
    /// The reserve is measured and healthy.
    Ok,
    /// The speaker plays faster than the audio arrives and its reserve is
    /// projected to reach the low floor within thirty minutes.
    Draining,
    /// The reserve has fallen below the absolute floor sized from the
    /// speaker head start its connection was sent.
    Low,
    /// The speaker is known not to be playing.
    Paused,
    /// The speaker has stopped answering position polls.
    Stale,
    /// The speaker is playing something else.
    Dormant,
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
    /// How much audio a speaker fetching one of our streams holds ahead of
    /// its playhead (its reserve), and how fast that is changing.
    ///
    /// Measured by the speaker monitor from the speaker's reported position
    /// against the audio delivered and acknowledged on its connection. Sent
    /// with each rolled-up report (every 30 s) and whenever the state
    /// changes, while the speaker is monitored. Names its stream, so it only
    /// reaches the client that owns it while the stream is live.
    ///
    /// The low state is judged against `floor_ms`, an absolute floor sized
    /// from the speaker head start the connection was sent; `target_ms` is
    /// the level the reserve settled at once that head start had gone out.
    SpeakerHealth {
        /// The stream the speaker is fetching.
        #[serde(rename = "streamId")]
        stream_id: String,
        /// The speaker fetching it.
        #[serde(rename = "speakerIp")]
        speaker_ip: String,
        /// The playback epoch of the speaker's current connection.
        #[serde(rename = "epochId")]
        epoch_id: u64,
        /// The monitor's verdict.
        state: SpeakerHealthState,
        /// Best estimate of the reserve, in milliseconds of audio delivered.
        #[serde(rename = "reserveMs", skip_serializing_if = "Option::is_none")]
        reserve_ms: Option<i32>,
        /// Half the width of the interval the reserve is known to lie in.
        #[serde(rename = "reservePrecisionMs", skip_serializing_if = "Option::is_none")]
        reserve_precision_ms: Option<u32>,
        /// The lowest the reserve fell to over the last report's window, on
        /// audio the speaker acknowledged where that is measured.
        #[serde(rename = "reserveMinMs", skip_serializing_if = "Option::is_none")]
        reserve_min_ms: Option<i32>,
        /// The level the reserve stayed above nine tenths of the last
        /// report's window, on the same basis as `reserve_min_ms`. The low
        /// state is judged on this, against `floor_ms`.
        #[serde(rename = "reserveP10Ms", skip_serializing_if = "Option::is_none")]
        reserve_p10_ms: Option<i32>,
        /// Whether `reserve_min_ms` and `reserve_p10_ms` are on acknowledged
        /// audio. Where the platform does not report acknowledgements they
        /// are the delivered-count estimate.
        #[serde(rename = "reserveAcked")]
        reserve_acked: bool,
        /// The reserve the speaker settled at on this connection once its
        /// head start had gone out, once learned.
        #[serde(rename = "targetMs", skip_serializing_if = "Option::is_none")]
        target_ms: Option<i32>,
        /// The speaker head start the connection was actually sent, in ms
        /// (PCM only): less than configured when the stream held too little
        /// audio when the speaker connected.
        #[serde(rename = "headStartMs", skip_serializing_if = "Option::is_none")]
        head_start_ms: Option<u32>,
        /// The speaker head start configured when the connection was made,
        /// in ms (PCM only).
        #[serde(
            rename = "headStartConfiguredMs",
            skip_serializing_if = "Option::is_none"
        )]
        head_start_configured_ms: Option<u32>,
        /// The acknowledged reserve below which the speaker is low, in ms,
        /// sized from `head_start_ms` (PCM only).
        #[serde(rename = "floorMs", skip_serializing_if = "Option::is_none")]
        floor_ms: Option<u32>,
        /// How far the worst acknowledgement lag of the last report's window
        /// stood above its median, in ms: the audio a Wi-Fi stall held back,
        /// less what is steadily in flight. Where acknowledgements are
        /// measured.
        #[serde(rename = "stallMs", skip_serializing_if = "Option::is_none")]
        stall_ms: Option<u32>,
        /// How much faster the speaker plays than audio arrives, in parts
        /// per million. Positive drains the reserve.
        #[serde(rename = "clockPpm", skip_serializing_if = "Option::is_none")]
        clock_ppm: Option<f32>,
        /// Standard error of `clock_ppm`.
        #[serde(rename = "clockSePpm", skip_serializing_if = "Option::is_none")]
        clock_se_ppm: Option<f32>,
        /// Seconds until the reserve reaches `floor_ms` at the rate the
        /// speaker drains it, when it is measurably draining it.
        #[serde(rename = "timeToFloorS", skip_serializing_if = "Option::is_none")]
        time_to_floor_s: Option<u32>,
        /// What the user should be told about this speaker, decided here so
        /// every client says the same thing (see
        /// [`crate::services::speaker_monitor::notice`]). Repeated in every
        /// report while it stands, under the same `noticeId`.
        #[serde(skip_serializing_if = "Option::is_none")]
        notice: Option<crate::services::speaker_monitor::SpeakerNotice>,
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
    /// Something changed in the household between two topology refreshes:
    /// a home-theatre satellite dropped off or came back, a device rebooted,
    /// a radio changed, a device vanished, or a group's members changed.
    ///
    /// Compared between SOAP answers only, never GENA bodies (which can be
    /// stale). Names no stream, so it reaches every client; the household is
    /// shared by everyone casting to it.
    MemberChanged {
        /// What changed.
        change: crate::services::speaker_monitor::MemberChange,
        /// Address of the device the change is about, when it is still in
        /// the household.
        #[serde(rename = "speakerIp", skip_serializing_if = "Option::is_none")]
        speaker_ip: Option<String>,
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

    /// The speaker health event's shape is protocol, shared with the
    /// extension's zod schema: field names, state strings and which fields
    /// are left out when unknown.
    #[test]
    fn speaker_health_wire_shape() {
        let event = BroadcastEvent::Network(NetworkEvent::SpeakerHealth {
            stream_id: "s".into(),
            speaker_ip: "192.168.1.31".into(),
            epoch_id: 3,
            state: SpeakerHealthState::Draining,
            reserve_ms: Some(512),
            reserve_precision_ms: Some(34),
            reserve_min_ms: Some(431),
            reserve_p10_ms: Some(470),
            reserve_acked: true,
            target_ms: Some(540),
            head_start_ms: Some(500),
            head_start_configured_ms: Some(500),
            floor_ms: Some(150),
            stall_ms: Some(90),
            clock_ppm: Some(39.75),
            clock_se_ppm: Some(7.25),
            time_to_floor_s: Some(900),
            notice: Some(crate::services::speaker_monitor::SpeakerNotice {
                kind: crate::services::speaker_monitor::SpeakerNoticeKind::DriftUncorrected,
                notice_id: 2,
                stall_ms: None,
                left_ms: None,
                head_start_ms: Some(500),
                suggested_head_start_ms: None,
                minutes: Some(15),
                restart_helps: true,
            }),
            timestamp: 1,
        });
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            serde_json::json!({
                "category": "network",
                "type": "speakerHealth",
                "streamId": "s",
                "speakerIp": "192.168.1.31",
                "epochId": 3,
                "state": "draining",
                "reserveMs": 512,
                "reservePrecisionMs": 34,
                "reserveMinMs": 431,
                "reserveP10Ms": 470,
                "reserveAcked": true,
                "targetMs": 540,
                "headStartMs": 500,
                "headStartConfiguredMs": 500,
                "floorMs": 150,
                "stallMs": 90,
                "clockPpm": 39.75,
                "clockSePpm": 7.25,
                "timeToFloorS": 900,
                "notice": {
                    "kind": "drift_uncorrected",
                    "noticeId": 2,
                    "headStartMs": 500,
                    "minutes": 15,
                    "restartHelps": true,
                },
                "timestamp": 1,
            })
        );

        let locking = BroadcastEvent::Network(NetworkEvent::SpeakerHealth {
            stream_id: "s".into(),
            speaker_ip: "192.168.1.31".into(),
            epoch_id: 3,
            state: SpeakerHealthState::Locking,
            reserve_ms: None,
            reserve_precision_ms: None,
            reserve_min_ms: None,
            reserve_p10_ms: None,
            reserve_acked: false,
            target_ms: None,
            head_start_ms: None,
            head_start_configured_ms: None,
            floor_ms: None,
            stall_ms: None,
            clock_ppm: None,
            clock_se_ppm: None,
            time_to_floor_s: None,
            notice: None,
            timestamp: 1,
        });
        assert_eq!(
            serde_json::to_value(&locking).unwrap(),
            serde_json::json!({
                "category": "network",
                "type": "speakerHealth",
                "streamId": "s",
                "speakerIp": "192.168.1.31",
                "epochId": 3,
                "state": "locking",
                "reserveAcked": false,
                "timestamp": 1,
            })
        );
    }

    #[test]
    fn speaker_health_state_wire_strings() {
        let wire = |s: SpeakerHealthState| serde_json::to_string(&s).unwrap();
        assert_eq!(wire(SpeakerHealthState::Locking), "\"locking\"");
        assert_eq!(wire(SpeakerHealthState::Ok), "\"ok\"");
        assert_eq!(wire(SpeakerHealthState::Draining), "\"draining\"");
        assert_eq!(wire(SpeakerHealthState::Low), "\"low\"");
        assert_eq!(wire(SpeakerHealthState::Paused), "\"paused\"");
        assert_eq!(wire(SpeakerHealthState::Stale), "\"stale\"");
        assert_eq!(wire(SpeakerHealthState::Dormant), "\"dormant\"");
    }

    /// The ingest-gap and companion-audio events ride the stream category;
    /// their shapes are protocol, shared with the extension.
    #[test]
    fn ingest_gaps_and_companion_audio_wire_shapes() {
        let gaps = BroadcastEvent::Stream(StreamEvent::IngestGaps {
            stream_id: "s".into(),
            gaps_last_minute: 3,
            worst_gap_ms: 620,
            smoothing_ms: 200,
            suggested_smoothing_ms: None,
            timestamp: 1,
        });
        assert_eq!(
            serde_json::to_value(&gaps).unwrap(),
            serde_json::json!({
                "category": "stream",
                "type": "ingestGaps",
                "streamId": "s",
                "gapsLastMinute": 3,
                "worstGapMs": 620,
                "smoothingMs": 200,
                "timestamp": 1,
            })
        );

        let audio = BroadcastEvent::Stream(StreamEvent::CompanionAudioChanged {
            audio: CompanionAudio {
                head_start_ms: 750,
                head_start_fixed: true,
                speaker_monitor: false,
            },
            timestamp: 2,
        });
        assert_eq!(
            serde_json::to_value(&audio).unwrap(),
            serde_json::json!({
                "category": "stream",
                "type": "companionAudioChanged",
                "headStartMs": 750,
                "headStartFixed": true,
                "speakerMonitor": false,
                "timestamp": 2,
            })
        );
    }

    /// The member change event rides the topology category with its change
    /// nested under `change`, tagged by `kind`.
    #[test]
    fn member_changed_wire_shape() {
        let event = BroadcastEvent::Topology(TopologyEvent::MemberChanged {
            change: crate::services::speaker_monitor::MemberChange::DeviceRebooted {
                uuid: "RINCON_B".into(),
                from: 31,
                to: 32,
            },
            speaker_ip: Some("192.168.2.205".into()),
            timestamp: 7,
        });

        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            serde_json::json!({
                "category": "topology",
                "type": "memberChanged",
                "change": { "kind": "deviceRebooted", "uuid": "RINCON_B", "from": 31, "to": 32 },
                "speakerIp": "192.168.2.205",
                "timestamp": 7,
            })
        );
    }
}
