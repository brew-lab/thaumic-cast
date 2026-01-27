//! GENA event building functions.
//!
//! Transforms parsed GENA notification data into typed `SonosEvent` variants.
//! Separated from subscription lifecycle management for single responsibility.

use crate::sonos::gena::SonosEvent;
use crate::sonos::gena_parser::{
    is_matching_stream_url, parse_av_transport, parse_group_rendering_control,
    parse_rendering_control, parse_zone_group_topology,
};
use crate::utils::now_millis;

/// Builds events from an AVTransport GENA notification.
///
/// # Arguments
/// * `ip` - The speaker IP address
/// * `body` - The raw XML notification body
/// * `get_expected_stream` - Optional callback to get the expected stream URL for source change detection
///
/// # Returns
/// A vector of events (may contain `TransportState` and/or `SourceChanged`)
pub fn build_av_transport_events<F>(
    ip: &str,
    body: &str,
    get_expected_stream: Option<F>,
) -> Vec<SonosEvent>
where
    F: Fn(&str) -> Option<String>,
{
    let mut events = Vec::new();
    let timestamp = now_millis();
    let data = parse_av_transport(body);

    // Emit transport state event
    if let Some(state) = data.transport_state {
        events.push(SonosEvent::TransportState {
            speaker_ip: ip.to_string(),
            state,
            current_uri: data.current_uri.clone(),
            timestamp,
        });
    }

    // Check for source change (only if callback provided)
    if let (Some(ref uri), Some(ref get_expected)) = (&data.current_uri, &get_expected_stream) {
        if let Some(expected) = get_expected(ip) {
            if !is_matching_stream_url(uri, &expected) {
                log::info!(
                    "[GENA] Source changed on {}: expected={}, current={}",
                    ip,
                    expected,
                    uri
                );
                events.push(SonosEvent::SourceChanged {
                    speaker_ip: ip.to_string(),
                    current_uri: uri.clone(),
                    expected_uri: Some(expected),
                    timestamp,
                });
            }
        }
    }

    events
}

/// Builds events from a GroupRenderingControl GENA notification.
///
/// # Arguments
/// * `ip` - The speaker IP address
/// * `body` - The raw XML notification body
///
/// # Returns
/// A vector of events (may contain `GroupVolume` and/or `GroupMute`)
pub fn build_group_rendering_events(ip: &str, body: &str) -> Vec<SonosEvent> {
    let mut events = Vec::new();
    let timestamp = now_millis();
    let data = parse_group_rendering_control(body);

    if let Some(volume) = data.volume {
        events.push(SonosEvent::GroupVolume {
            speaker_ip: ip.to_string(),
            volume,
            fixed: data.output_fixed,
            timestamp,
        });
    }

    if let Some(muted) = data.muted {
        events.push(SonosEvent::GroupMute {
            speaker_ip: ip.to_string(),
            muted,
            timestamp,
        });
    }

    events
}

/// Builds events from a RenderingControl GENA notification.
///
/// Reuses GroupVolume/GroupMute event types since the payload is identical
/// and the extension already handles these events.
///
/// # Arguments
/// * `ip` - The speaker IP address
/// * `body` - The raw XML notification body
///
/// # Returns
/// A vector of events (may contain `GroupVolume` and/or `GroupMute`)
pub fn build_rendering_control_events(ip: &str, body: &str) -> Vec<SonosEvent> {
    let mut events = Vec::new();
    let timestamp = now_millis();
    let data = parse_rendering_control(body);

    if let Some(volume) = data.volume {
        events.push(SonosEvent::GroupVolume {
            speaker_ip: ip.to_string(),
            volume,
            fixed: None, // RenderingControl doesn't report OutputFixed
            timestamp,
        });
    }

    if let Some(muted) = data.muted {
        events.push(SonosEvent::GroupMute {
            speaker_ip: ip.to_string(),
            muted,
            timestamp,
        });
    }

    events
}

/// Builds events from a ZoneGroupTopology GENA notification.
///
/// # Arguments
/// * `body` - The raw XML notification body
///
/// # Returns
/// A vector containing a single `ZoneGroupsUpdated` event (or empty if no groups parsed)
pub fn build_zone_topology_events(body: &str) -> Vec<SonosEvent> {
    let timestamp = now_millis();
    let groups = parse_zone_group_topology(body);

    if groups.is_empty() {
        return vec![];
    }

    log::info!("[GENA] Zone topology updated: {} group(s)", groups.len());

    vec![SonosEvent::ZoneGroupsUpdated { groups, timestamp }]
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─────────────────────────────────────────────────────────────────────────────
    // build_rendering_control_events tests
    // ─────────────────────────────────────────────────────────────────────────────

    use super::super::test_fixtures::{
        RENDERING_CONTROL_NOTIFY_FULL, RENDERING_CONTROL_NOTIFY_MUTED,
        RENDERING_CONTROL_NOTIFY_VOLUME_ONLY,
    };

    #[test]
    fn build_rendering_control_events_emits_volume_and_mute() {
        let events = build_rendering_control_events("192.168.1.100", RENDERING_CONTROL_NOTIFY_FULL);

        assert_eq!(events.len(), 2);

        // Check volume event
        match &events[0] {
            SonosEvent::GroupVolume {
                speaker_ip,
                volume,
                fixed,
                ..
            } => {
                assert_eq!(speaker_ip, "192.168.1.100");
                assert_eq!(*volume, 42);
                assert_eq!(*fixed, None); // RenderingControl doesn't report OutputFixed
            }
            _ => panic!("Expected GroupVolume event"),
        }

        // Check mute event
        match &events[1] {
            SonosEvent::GroupMute {
                speaker_ip, muted, ..
            } => {
                assert_eq!(speaker_ip, "192.168.1.100");
                assert!(!*muted);
            }
            _ => panic!("Expected GroupMute event"),
        }
    }

    #[test]
    fn build_rendering_control_events_emits_muted_true() {
        let events =
            build_rendering_control_events("192.168.1.101", RENDERING_CONTROL_NOTIFY_MUTED);

        assert_eq!(events.len(), 2);

        // Check mute event has muted=true
        match &events[1] {
            SonosEvent::GroupMute { muted, .. } => {
                assert!(*muted);
            }
            _ => panic!("Expected GroupMute event"),
        }
    }

    #[test]
    fn build_rendering_control_events_volume_only() {
        let events =
            build_rendering_control_events("192.168.1.102", RENDERING_CONTROL_NOTIFY_VOLUME_ONLY);

        assert_eq!(events.len(), 1);

        match &events[0] {
            SonosEvent::GroupVolume {
                speaker_ip, volume, ..
            } => {
                assert_eq!(speaker_ip, "192.168.1.102");
                assert_eq!(*volume, 100);
            }
            _ => panic!("Expected GroupVolume event"),
        }
    }

    #[test]
    fn build_rendering_control_events_empty_for_invalid_body() {
        let events = build_rendering_control_events("192.168.1.103", "invalid xml");

        assert!(events.is_empty());
    }

    #[test]
    fn build_rendering_control_events_empty_for_empty_body() {
        let events = build_rendering_control_events("192.168.1.104", "");

        assert!(events.is_empty());
    }

    #[test]
    fn build_rendering_control_events_uses_correct_speaker_ip() {
        let events =
            build_rendering_control_events("10.0.0.50", RENDERING_CONTROL_NOTIFY_VOLUME_ONLY);

        assert_eq!(events.len(), 1);
        match &events[0] {
            SonosEvent::GroupVolume { speaker_ip, .. } => {
                assert_eq!(speaker_ip, "10.0.0.50");
            }
            _ => panic!("Expected GroupVolume event"),
        }
    }

    #[test]
    fn build_rendering_control_events_sets_fixed_to_none() {
        // RenderingControl (per-speaker) doesn't have OutputFixed like GroupRenderingControl
        let events = build_rendering_control_events("192.168.1.100", RENDERING_CONTROL_NOTIFY_FULL);

        match &events[0] {
            SonosEvent::GroupVolume { fixed, .. } => {
                assert!(fixed.is_none());
            }
            _ => panic!("Expected GroupVolume event"),
        }
    }
}
