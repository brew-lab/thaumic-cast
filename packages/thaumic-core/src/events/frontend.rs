//! The events the desktop app's frontend hears, and their payloads.
//!
//! The desktop frontend listens for a handful of named events, each with its
//! own camelCase payload. The mapping from [`BroadcastEvent`] lives here, not
//! in the desktop crate, so that everything that relays events to that
//! frontend (the Tauri emitter, and the test bridge that runs the built
//! frontend against the fake household) sends the same names and payloads.

use serde_json::{json, Value};

use super::{BroadcastEvent, NetworkEvent, SonosEvent, StreamEvent, TopologyEvent};

/// The frontend event for `event`: its name and its JSON payload, or `None`
/// when the frontend is not told about it.
///
/// Late audio from a browser is the casting extension's to show, the
/// frontend knows its own settings, household changes are for the log and
/// the extension, and latency is only sent to the extension.
#[must_use]
pub fn frontend_event(event: &BroadcastEvent) -> Option<(&'static str, Value)> {
    match event {
        BroadcastEvent::Stream(event) => stream_event(event),
        BroadcastEvent::Sonos(SonosEvent::TransportState {
            speaker_ip, state, ..
        }) => Some((
            "transport-state-changed",
            json!({ "speakerIp": speaker_ip, "state": state.to_string() }),
        )),
        BroadcastEvent::Sonos(_) | BroadcastEvent::Latency(_) => None,
        BroadcastEvent::Network(NetworkEvent::HealthChanged { health, reason, .. }) => Some((
            "network-health-changed",
            json!({
                "health": format!("{health:?}").to_lowercase(),
                "reason": reason,
            }),
        )),
        // Relayed as the wire event itself (camelCase fields and its `type`
        // tag): the frontend reads it as the extension does, and a field
        // added to the event needs no change here.
        BroadcastEvent::Network(event @ NetworkEvent::SpeakerHealth { .. }) => {
            serde_json::to_value(event)
                .ok()
                .map(|payload| ("speaker-health", payload))
        }
        BroadcastEvent::Topology(TopologyEvent::GroupsDiscovered { groups, .. }) => {
            Some(("discovery-complete", json!({ "groupCount": groups.len() })))
        }
        BroadcastEvent::Topology(TopologyEvent::MemberChanged { .. }) => None,
    }
}

/// The frontend event for a stream event, if it has one.
fn stream_event(event: &StreamEvent) -> Option<(&'static str, Value)> {
    match event {
        StreamEvent::Created { stream_id, .. } => {
            Some(("stream-created", json!({ "streamId": stream_id })))
        }
        StreamEvent::Ended { stream_id, .. } => {
            Some(("stream-ended", json!({ "streamId": stream_id })))
        }
        StreamEvent::PlaybackStarted {
            stream_id,
            speaker_ip,
            ..
        } => Some((
            "playback-started",
            json!({ "streamId": stream_id, "speakerIp": speaker_ip }),
        )),
        StreamEvent::PlaybackStopped {
            stream_id,
            speaker_ip,
            reason,
            ..
        } => {
            let mut payload = json!({ "streamId": stream_id, "speakerIp": speaker_ip });
            if let Some(reason) = reason {
                payload["reason"] = json!(reason);
            }
            Some(("playback-stopped", payload))
        }
        StreamEvent::PlaybackStopFailed {
            stream_id,
            speaker_ip,
            error,
            reason,
            ..
        } => {
            let mut payload =
                json!({ "streamId": stream_id, "speakerIp": speaker_ip, "error": error });
            if let Some(reason) = reason {
                payload["reason"] = json!(reason);
            }
            Some(("playback-stop-failed", payload))
        }
        StreamEvent::IngestGaps { .. } | StreamEvent::CompanionAudioChanged { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{NetworkHealth, SpeakerRemovalReason};

    #[test]
    fn a_stream_event_names_its_stream() {
        let event = BroadcastEvent::Stream(StreamEvent::Created {
            stream_id: "s1".into(),
            timestamp: 1,
        });
        assert_eq!(
            frontend_event(&event),
            Some(("stream-created", json!({ "streamId": "s1" })))
        );
    }

    #[test]
    fn a_stop_carries_its_reason_only_when_it_has_one() {
        let stopped = |reason| {
            frontend_event(&BroadcastEvent::Stream(StreamEvent::PlaybackStopped {
                stream_id: "s1".into(),
                speaker_ip: "192.168.1.31".into(),
                reason,
                timestamp: 1,
            }))
        };
        assert_eq!(
            stopped(None),
            Some((
                "playback-stopped",
                json!({ "streamId": "s1", "speakerIp": "192.168.1.31" })
            ))
        );
        assert_eq!(
            stopped(Some(SpeakerRemovalReason::SourceChanged)),
            Some((
                "playback-stopped",
                json!({
                    "streamId": "s1",
                    "speakerIp": "192.168.1.31",
                    "reason": "source_changed",
                })
            ))
        );
    }

    #[test]
    fn health_is_lower_case_with_its_reason() {
        let event = BroadcastEvent::Network(NetworkEvent::HealthChanged {
            health: NetworkHealth::Degraded,
            reason: Some("speakers_unreachable".into()),
            timestamp: 1,
        });
        assert_eq!(
            frontend_event(&event),
            Some((
                "network-health-changed",
                json!({ "health": "degraded", "reason": "speakers_unreachable" })
            ))
        );
        let ok = BroadcastEvent::Network(NetworkEvent::HealthChanged {
            health: NetworkHealth::Ok,
            reason: None,
            timestamp: 1,
        });
        assert_eq!(
            frontend_event(&ok),
            Some((
                "network-health-changed",
                json!({ "health": "ok", "reason": null })
            ))
        );
    }

    #[test]
    fn discovery_counts_the_groups() {
        let event = BroadcastEvent::Topology(TopologyEvent::GroupsDiscovered {
            groups: Vec::new(),
            timestamp: 1,
        });
        assert_eq!(
            frontend_event(&event),
            Some(("discovery-complete", json!({ "groupCount": 0 })))
        );
    }

    #[test]
    fn what_the_frontend_does_not_show_is_not_sent() {
        let event = BroadcastEvent::Stream(StreamEvent::IngestGaps {
            stream_id: "s1".into(),
            gaps_last_minute: 1,
            worst_gap_ms: 20,
            smoothing_ms: 200,
            suggested_smoothing_ms: None,
            timestamp: 1,
        });
        assert_eq!(frontend_event(&event), None);
    }
}
