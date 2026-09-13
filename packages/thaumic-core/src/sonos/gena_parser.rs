//! GENA event XML parsing and construction.
//!
//! Parses GENA NOTIFY payloads and constructs typed `SonosEvent` variants.
//! Separates XML/event concerns from subscription lifecycle management.

use crate::sonos::gena::SonosEvent;
use crate::sonos::types::TransportState;
use crate::sonos::utils::{
    extract_empty_val_attrs, extract_master_channel_attrs, extract_xml_text,
};
use crate::sonos::zone_groups::parse_zone_group_xml;
use crate::utils::now_millis;

/// Parses an AVTransport NOTIFY event body and builds events.
///
/// Extracts transport state and current track URI from the LastChange element.
/// Optionally detects source changes if a callback is provided.
///
/// # Arguments
/// * `ip` - The speaker IP address
/// * `body` - The raw XML notification body
/// * `get_expected_stream` - Optional callback to get the expected stream URL for source change detection
pub fn parse_av_transport_events<F>(
    ip: &str,
    body: &str,
    get_expected_stream: Option<F>,
) -> Vec<SonosEvent>
where
    F: Fn(&str) -> Option<String>,
{
    let mut events = Vec::new();
    let timestamp = now_millis();

    // Extract LastChange from property set
    let Some(last_change) = extract_xml_text(body, "LastChange") else {
        return events;
    };

    // One decode per layer: `extract_xml_text` decoded the LastChange text and
    // `extract_empty_val_attrs` decodes each `val` attribute. Decoding again
    // here would splice the escaped DIDL-Lite of CurrentTrackMetaData into the
    // document as raw markup, corrupting that attribute (and any later value
    // whose decoded text contains a quote). The two fields read below happen
    // to survive it today, so this is correctness-by-construction rather than
    // a fix for an observed symptom on this path.
    let attrs = extract_empty_val_attrs(&last_change, &["TransportState", "CurrentTrackURI"]);

    let transport_state: Option<TransportState> =
        attrs.get("TransportState").and_then(|val| val.parse().ok());

    let current_uri: Option<String> = attrs
        .get("CurrentTrackURI")
        .filter(|val| !val.is_empty())
        .cloned();

    // Emit transport state event
    if let Some(state) = transport_state {
        events.push(SonosEvent::TransportState {
            speaker_ip: ip.to_string(),
            state,
            current_uri: current_uri.clone(),
            timestamp,
        });
    }

    // Check for source change (only if callback provided)
    if let (Some(ref uri), Some(ref get_expected)) = (&current_uri, &get_expected_stream) {
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

/// Parses a GroupRenderingControl NOTIFY event body and builds events.
///
/// Extracts group volume, mute state, and output-fixed flag.
///
/// # Arguments
/// * `ip` - The speaker IP address
/// * `body` - The raw XML notification body
pub fn parse_group_rendering_events(ip: &str, body: &str) -> Vec<SonosEvent> {
    let mut events = Vec::new();
    let timestamp = now_millis();

    // GroupRenderingControl uses direct element content, not LastChange
    let volume: Option<u8> = extract_xml_text(body, "GroupVolume")
        .and_then(|s| s.parse::<u8>().ok())
        .map(|v| v.min(100));

    let muted: Option<bool> = extract_xml_text(body, "GroupMute").map(|s| s == "1");

    let output_fixed: Option<bool> = extract_xml_text(body, "OutputFixed").map(|s| s == "1");

    if let Some(volume) = volume {
        events.push(SonosEvent::GroupVolume {
            speaker_ip: ip.to_string(),
            volume,
            fixed: output_fixed,
            timestamp,
        });
    }

    if let Some(muted) = muted {
        events.push(SonosEvent::GroupMute {
            speaker_ip: ip.to_string(),
            muted,
            timestamp,
        });
    }

    events
}

/// Parses a RenderingControl NOTIFY event body and builds events.
///
/// RenderingControl uses the LastChange XML format (like AVTransport).
/// Extracts Volume and Mute attributes with `channel="Master"` only,
/// ignoring per-speaker channels like LF/RF from stereo pairs.
///
/// Reuses GroupVolume/GroupMute event types since the payload is identical
/// and the extension already handles these events.
///
/// # Arguments
/// * `ip` - The speaker IP address
/// * `body` - The raw XML notification body
pub fn parse_rendering_control_events(ip: &str, body: &str) -> Vec<SonosEvent> {
    let mut events = Vec::new();
    let timestamp = now_millis();

    // Extract LastChange from property set
    let Some(last_change) = extract_xml_text(body, "LastChange") else {
        return events;
    };

    // Extract Volume and Mute from the InstanceID element, Master channel only.
    // Format: <Volume channel="Master" val="42"/>
    //         <Mute channel="Master" val="0"/>
    // Stereo pairs also send LF/RF channels which we ignore.
    // Already decoded once by `extract_xml_text`; one decode per layer, with
    // `get_xml_attr` decoding each `val`. (Volume and Mute are numeric, so a
    // second decode here was harmless - it is removed for consistency.)
    let attrs = extract_master_channel_attrs(&last_change, &["Volume", "Mute"]);

    let volume: Option<u8> = attrs
        .get("Volume")
        .and_then(|val| val.parse::<u8>().ok())
        .map(|v| v.min(100));

    let muted: Option<bool> = attrs.get("Mute").map(|val| val == "1");

    if let Some(volume) = volume {
        events.push(SonosEvent::GroupVolume {
            speaker_ip: ip.to_string(),
            volume,
            fixed: None, // RenderingControl doesn't report OutputFixed
            timestamp,
        });
    }

    if let Some(muted) = muted {
        events.push(SonosEvent::GroupMute {
            speaker_ip: ip.to_string(),
            muted,
            timestamp,
        });
    }

    events
}

/// Parses a ZoneGroupTopology NOTIFY event body and builds events.
///
/// Extracts and parses the zone group state XML, wrapping the result
/// in a `SonosEvent::ZoneGroupsUpdated`.
///
/// # Arguments
/// * `body` - The raw XML notification body
pub fn parse_zone_topology_events(body: &str) -> Vec<SonosEvent> {
    let timestamp = now_millis();

    // Extract ZoneGroupState from property set
    let Some(zone_state) = extract_xml_text(body, "ZoneGroupState") else {
        return vec![];
    };

    // Already decoded once by `extract_xml_text`; the zone names inside stay
    // escaped until `parse_zone_group_xml` reads them as attributes and
    // `get_xml_attr` decodes them. Decoding again here truncates any room name
    // whose decoded text contains a quote - see
    // `parse_zone_topology_events_decodes_zone_names_like_soap_path`.
    let groups = parse_zone_group_xml(&zone_state);

    if groups.is_empty() {
        return vec![];
    }

    log::info!("[GENA] Zone topology updated: {} group(s)", groups.len());

    vec![SonosEvent::ZoneGroupsUpdated { groups, timestamp }]
}

/// Checks if the current URI matches the expected stream URL.
///
/// Handles various URI schemes used by Sonos (x-rincon-mp3radio://, aac://, etc.)
/// by comparing just the host+path portion.
#[must_use]
pub fn is_matching_stream_url(current_uri: &str, expected_uri: &str) -> bool {
    // Extract everything after the last "://" to get host+path
    // This handles nested schemes like "aac://http://host/path" -> "host/path"
    fn extract_host_path(url: &str) -> &str {
        match url.rfind("://") {
            Some(idx) => &url[idx + 3..],
            None => url,
        }
    }

    extract_host_path(current_uri).eq_ignore_ascii_case(extract_host_path(expected_uri))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─────────────────────────────────────────────────────────────────────────────
    // is_matching_stream_url tests
    // ─────────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_is_matching_stream_url_same() {
        assert!(is_matching_stream_url(
            "http://192.168.1.100:8080/stream.aac",
            "http://192.168.1.100:8080/stream.aac"
        ));
    }

    #[test]
    fn test_is_matching_stream_url_nested_scheme() {
        assert!(is_matching_stream_url(
            "aac://http://192.168.1.100:8080/stream.aac",
            "http://192.168.1.100:8080/stream.aac"
        ));
    }

    #[test]
    fn test_is_matching_stream_url_case_insensitive() {
        assert!(is_matching_stream_url(
            "http://192.168.1.100:8080/Stream.AAC",
            "http://192.168.1.100:8080/stream.aac"
        ));
    }

    #[test]
    fn test_is_matching_stream_url_different() {
        assert!(!is_matching_stream_url(
            "http://192.168.1.100:8080/other.aac",
            "http://192.168.1.100:8080/stream.aac"
        ));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // parse_rendering_control_events tests
    // ─────────────────────────────────────────────────────────────────────────────

    use super::super::test_fixtures::{
        AV_TRANSPORT_NOTIFY_WITH_METADATA, AV_TRANSPORT_STREAM_URI, RENDERING_CONTROL_NOTIFY_FULL,
        RENDERING_CONTROL_NOTIFY_MUTED, RENDERING_CONTROL_NOTIFY_VOLUME_ONLY,
        ZONE_GROUP_STATE_SOAP_RESPONSE, ZONE_GROUP_TOPOLOGY_NOTIFY,
    };
    use crate::sonos::types::ZoneGroup;
    use crate::sonos::utils::extract_xml_text;

    #[test]
    fn parse_rendering_control_events_emits_volume_and_mute() {
        let events = parse_rendering_control_events("192.168.1.100", RENDERING_CONTROL_NOTIFY_FULL);

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
    fn parse_rendering_control_events_emits_muted_true() {
        let events =
            parse_rendering_control_events("192.168.1.101", RENDERING_CONTROL_NOTIFY_MUTED);

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
    fn parse_rendering_control_events_volume_only() {
        let events =
            parse_rendering_control_events("192.168.1.102", RENDERING_CONTROL_NOTIFY_VOLUME_ONLY);

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
    fn parse_rendering_control_events_empty_for_invalid_body() {
        let events = parse_rendering_control_events("192.168.1.103", "invalid xml");

        assert!(events.is_empty());
    }

    #[test]
    fn parse_rendering_control_events_empty_for_empty_body() {
        let events = parse_rendering_control_events("192.168.1.104", "");

        assert!(events.is_empty());
    }

    #[test]
    fn parse_rendering_control_events_uses_correct_speaker_ip() {
        let events =
            parse_rendering_control_events("10.0.0.50", RENDERING_CONTROL_NOTIFY_VOLUME_ONLY);

        assert_eq!(events.len(), 1);
        match &events[0] {
            SonosEvent::GroupVolume { speaker_ip, .. } => {
                assert_eq!(speaker_ip, "10.0.0.50");
            }
            _ => panic!("Expected GroupVolume event"),
        }
    }

    #[test]
    fn parse_rendering_control_events_sets_fixed_to_none() {
        // RenderingControl (per-speaker) doesn't have OutputFixed like GroupRenderingControl
        let events = parse_rendering_control_events("192.168.1.100", RENDERING_CONTROL_NOTIFY_FULL);

        match &events[0] {
            SonosEvent::GroupVolume { fixed, .. } => {
                assert!(fixed.is_none());
            }
            _ => panic!("Expected GroupVolume event"),
        }
    }

    #[test]
    fn parse_rendering_control_events_clamps_volume_to_100() {
        // Malformed response with volume > 100
        let body = r#"<?xml version="1.0"?>
<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">
  <e:property>
    <LastChange>&lt;Event&gt;&lt;InstanceID val=&quot;0&quot;&gt;
      &lt;Volume channel=&quot;Master&quot; val=&quot;150&quot;/&gt;
    &lt;/InstanceID&gt;&lt;/Event&gt;</LastChange>
  </e:property>
</e:propertyset>"#;
        let events = parse_rendering_control_events("192.168.1.100", body);
        assert_eq!(events.len(), 1);
        match &events[0] {
            SonosEvent::GroupVolume { volume, .. } => assert_eq!(*volume, 100),
            _ => panic!("Expected GroupVolume event"),
        }
    }

    #[test]
    fn parse_rendering_control_events_returns_empty_for_missing_last_change() {
        let body = r#"<?xml version="1.0"?>
<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">
  <e:property>
    <SomeOtherElement>value</SomeOtherElement>
  </e:property>
</e:propertyset>"#;
        let events = parse_rendering_control_events("192.168.1.100", body);
        assert!(events.is_empty());
    }

    #[test]
    fn parse_rendering_control_events_extracts_master_channel_only() {
        // RenderingControl can have LF/RF channels for stereo pairs,
        // but we only extract the Master channel value
        let body = r#"<?xml version="1.0"?>
<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">
  <e:property>
    <LastChange>&lt;Event&gt;&lt;InstanceID val=&quot;0&quot;&gt;
      &lt;Volume channel=&quot;LF&quot; val=&quot;50&quot;/&gt;
      &lt;Volume channel=&quot;RF&quot; val=&quot;50&quot;/&gt;
      &lt;Volume channel=&quot;Master&quot; val=&quot;60&quot;/&gt;
    &lt;/InstanceID&gt;&lt;/Event&gt;</LastChange>
  </e:property>
</e:propertyset>"#;
        let events = parse_rendering_control_events("192.168.1.100", body);
        // Should extract Master (60), not LF/RF (50)
        match &events[0] {
            SonosEvent::GroupVolume { volume, .. } => assert_eq!(*volume, 60),
            _ => panic!("Expected GroupVolume event"),
        }
    }

    #[test]
    fn parse_rendering_control_events_master_before_other_channels() {
        // Verify Master is extracted even when it appears before LF/RF
        let body = r#"<?xml version="1.0"?>
<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">
  <e:property>
    <LastChange>&lt;Event&gt;&lt;InstanceID val=&quot;0&quot;&gt;
      &lt;Volume channel=&quot;Master&quot; val=&quot;60&quot;/&gt;
      &lt;Volume channel=&quot;LF&quot; val=&quot;50&quot;/&gt;
      &lt;Volume channel=&quot;RF&quot; val=&quot;50&quot;/&gt;
    &lt;/InstanceID&gt;&lt;/Event&gt;</LastChange>
  </e:property>
</e:propertyset>"#;
        let events = parse_rendering_control_events("192.168.1.100", body);
        // Should still extract Master (60), not RF (50) which appeared last
        match &events[0] {
            SonosEvent::GroupVolume { volume, .. } => assert_eq!(*volume, 60),
            _ => panic!("Expected GroupVolume event"),
        }
    }

    #[test]
    fn parse_rendering_control_events_no_master_returns_empty() {
        // If there's no Master channel, we should get no events
        let body = r#"<?xml version="1.0"?>
<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">
  <e:property>
    <LastChange>&lt;Event&gt;&lt;InstanceID val=&quot;0&quot;&gt;
      &lt;Volume channel=&quot;LF&quot; val=&quot;50&quot;/&gt;
      &lt;Volume channel=&quot;RF&quot; val=&quot;50&quot;/&gt;
    &lt;/InstanceID&gt;&lt;/Event&gt;</LastChange>
  </e:property>
</e:propertyset>"#;
        let events = parse_rendering_control_events("192.168.1.100", body);
        // No Master channel = no events
        assert!(events.is_empty());
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Entity decoding tests (AVTransport + ZoneGroupTopology)
    // ─────────────────────────────────────────────────────────────────────────────

    /// Flattens groups into comparable tuples (`ZoneGroup` has no `PartialEq`).
    fn group_summary(groups: &[ZoneGroup]) -> Vec<(String, String, String, Vec<String>)> {
        groups
            .iter()
            .map(|g| {
                (
                    g.id.clone(),
                    g.name.clone(),
                    g.coordinator_uuid.clone(),
                    g.members.iter().map(|m| m.zone_name.clone()).collect(),
                )
            })
            .collect()
    }

    #[test]
    fn parse_av_transport_events_handles_didl_metadata() {
        let events = parse_av_transport_events(
            "192.168.1.50",
            AV_TRANSPORT_NOTIFY_WITH_METADATA,
            None::<fn(&str) -> Option<String>>,
        );

        assert_eq!(events.len(), 1);
        match &events[0] {
            SonosEvent::TransportState {
                speaker_ip,
                state,
                current_uri,
                ..
            } => {
                assert_eq!(speaker_ip, "192.168.1.50");
                assert_eq!(*state, TransportState::Playing);
                // The URI is escaped once inside the LastChange document, so it
                // must come back decoded exactly once.
                assert_eq!(current_uri.as_deref(), Some(AV_TRANSPORT_STREAM_URI));
            }
            _ => panic!("Expected TransportState event"),
        }
    }

    #[test]
    fn av_transport_last_change_parses_fields_after_track_metadata() {
        // The NOTIFY body is decoded exactly once, so the DIDL-Lite inside
        // CurrentTrackMetaData stays escaped and every state variable that
        // follows it parses normally.
        let last_change = extract_xml_text(AV_TRANSPORT_NOTIFY_WITH_METADATA, "LastChange")
            .expect("LastChange element");
        let attrs = extract_empty_val_attrs(
            &last_change,
            &[
                "TransportState",
                "CurrentTrackURI",
                "AVTransportURI",
                "CurrentTransportActions",
            ],
        );

        assert_eq!(
            attrs.get("TransportState").map(String::as_str),
            Some("PLAYING")
        );
        assert_eq!(
            attrs.get("CurrentTrackURI").map(String::as_str),
            Some(AV_TRANSPORT_STREAM_URI)
        );
        // Both of these follow CurrentTrackMetaData in the payload.
        assert_eq!(
            attrs.get("AVTransportURI").map(String::as_str),
            Some(AV_TRANSPORT_STREAM_URI)
        );
        assert_eq!(
            attrs.get("CurrentTransportActions").map(String::as_str),
            Some("Set, Play, Stop, Pause, Seek, X_DLNA_SeekTime, X_DLNA_SeekTrackNr")
        );
    }

    #[test]
    fn av_transport_track_metadata_decodes_to_usable_didl() {
        let last_change = extract_xml_text(AV_TRANSPORT_NOTIFY_WITH_METADATA, "LastChange")
            .expect("LastChange element");
        let attrs = extract_empty_val_attrs(&last_change, &["CurrentTrackMetaData"]);
        let didl = attrs
            .get("CurrentTrackMetaData")
            .expect("CurrentTrackMetaData val");

        // One decode per layer leaves a well-formed DIDL-Lite document.
        assert!(didl.starts_with("<DIDL-Lite "), "not DIDL-Lite: {didl}");
        assert!(
            didl.ends_with("</DIDL-Lite>"),
            "truncated DIDL-Lite: {didl}"
        );
        assert_eq!(
            extract_xml_text(didl, "streamContent").as_deref(),
            Some("Tom's \"Work\" Tab")
        );
        assert_eq!(
            extract_xml_text(didl, "res").as_deref(),
            Some(AV_TRANSPORT_STREAM_URI)
        );
    }

    /// Records exactly what a second decode of the AVTransport `LastChange`
    /// does, so the scope of that change is not overstated.
    ///
    /// This is a characterisation test, **not** a guard on the production line:
    /// quick-xml resynchronises after the mangled `CurrentTrackMetaData`, so
    /// the two variables `parse_av_transport_events` actually reads
    /// (`TransportState`, `CurrentTrackURI`) come back identical either way,
    /// and re-inserting the decode there would not fail any test. The damage is
    /// confined to values whose decoded text contains a quote, which today is
    /// only the DIDL metadata this path does not read. Reading any metadata
    /// field here later would make the double decode fatal - the reason the
    /// extra decode is gone rather than merely unused.
    #[test]
    fn double_decoding_av_transport_last_change_corrupts_only_the_didl() {
        let once = extract_xml_text(AV_TRANSPORT_NOTIFY_WITH_METADATA, "LastChange")
            .expect("LastChange element");
        let twice = html_escape::decode_html_entities(&once).to_string();

        let read_by_production = ["TransportState", "CurrentTrackURI"];
        assert_eq!(
            extract_empty_val_attrs(&once, &read_by_production),
            extract_empty_val_attrs(&twice, &read_by_production),
            "the fields this path reads are insensitive to the extra decode"
        );

        // The metadata is not insensitive: the `"` in the track title ends the
        // `val` attribute as soon as the DIDL is spliced in as raw markup.
        let good = extract_empty_val_attrs(&once, &["CurrentTrackMetaData"]);
        let mangled = extract_empty_val_attrs(&twice, &["CurrentTrackMetaData"]);
        assert!(good["CurrentTrackMetaData"].ends_with("</DIDL-Lite>"));
        assert_eq!(
            mangled.get("CurrentTrackMetaData").map(String::as_str),
            Some("<DIDL-Lite xmlns:dc=")
        );
    }

    #[test]
    fn parse_zone_topology_events_decodes_zone_names_like_soap_path() {
        let events = parse_zone_topology_events(ZONE_GROUP_TOPOLOGY_NOTIFY);
        assert_eq!(events.len(), 1);

        let soap_state = extract_xml_text(ZONE_GROUP_STATE_SOAP_RESPONSE, "ZoneGroupState")
            .expect("ZoneGroupState element");
        let soap_groups = parse_zone_group_xml(&soap_state);

        match &events[0] {
            SonosEvent::ZoneGroupsUpdated { groups, .. } => {
                assert_eq!(groups.len(), 3);
                assert_eq!(groups[0].name, "Tom's Office");
                assert_eq!(groups[0].members[0].zone_name, "Tom's Office");
                assert_eq!(groups[1].name, "Kitchen & Bar");
                // Regression guard for the second decode removed from this
                // function: `'` and `&` survive a double decode by luck, but a
                // quoted room name truncates to `Tom's ` because the decoded
                // `"` ends the ZoneName attribute early.
                assert_eq!(groups[2].name, "Tom's \"Den\"");
                assert_eq!(groups[2].members[0].zone_name, "Tom's \"Den\"");
                // GENA and SOAP carry the same document, so they must decode
                // to exactly the same groups.
                assert_eq!(group_summary(groups), group_summary(&soap_groups));
            }
            _ => panic!("Expected ZoneGroupsUpdated event"),
        }
    }
}
