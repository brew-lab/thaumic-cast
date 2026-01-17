//! GENA event building functions.
//!
//! Transforms parsed GENA notification data into typed `SonosEvent` variants.
//! Separated from subscription lifecycle management for single responsibility.

use crate::sonos::gena::SonosEvent;
use crate::sonos::gena_parser::{
    is_matching_stream_url, parse_av_transport, parse_group_rendering_control,
    parse_zone_group_topology,
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
