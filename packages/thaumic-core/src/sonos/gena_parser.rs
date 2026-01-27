//! GENA event XML parsing.
//!
//! This module contains pure parsing functions for GENA NOTIFY payloads.
//! It separates XML parsing concerns from subscription lifecycle management.

use crate::sonos::client::parse_zone_group_xml;
use crate::sonos::types::{TransportState, ZoneGroup};
use crate::sonos::utils::{
    extract_empty_val_attrs, extract_master_channel_attrs, extract_xml_text,
};

/// Parsed data from an AVTransport NOTIFY event.
#[derive(Debug, Default)]
pub struct AvTransportData {
    /// Current transport state (playing, paused, stopped, etc.).
    pub transport_state: Option<TransportState>,
    /// Current track URI being played.
    pub current_uri: Option<String>,
}

/// Parsed data from a GroupRenderingControl NOTIFY event.
#[derive(Debug, Default)]
pub struct GroupRenderingData {
    /// Group volume level (0-100).
    pub volume: Option<u8>,
    /// Group mute state.
    pub muted: Option<bool>,
    /// Whether the output is fixed (line-level, cannot be adjusted).
    pub output_fixed: Option<bool>,
}

/// Parsed data from a RenderingControl NOTIFY event.
///
/// Per-speaker volume/mute for synchronized multi-room playback.
#[derive(Debug, Default)]
pub struct RenderingControlData {
    /// Speaker volume level (0-100).
    pub volume: Option<u8>,
    /// Speaker mute state.
    pub muted: Option<bool>,
}

/// Parses an AVTransport NOTIFY event body.
///
/// Extracts transport state and current track URI from the LastChange element.
#[must_use]
pub fn parse_av_transport(body: &str) -> AvTransportData {
    let mut data = AvTransportData::default();

    // Extract LastChange from property set
    let Some(last_change) = extract_xml_text(body, "LastChange") else {
        return data;
    };

    let unescaped = html_escape::decode_html_entities(&last_change);
    let attrs = extract_empty_val_attrs(&unescaped, &["TransportState", "CurrentTrackURI"]);

    if let Some(val) = attrs.get("TransportState") {
        data.transport_state = val.parse().ok();
    }

    if let Some(val) = attrs.get("CurrentTrackURI") {
        let decoded = html_escape::decode_html_entities(val).to_string();
        if !decoded.is_empty() {
            data.current_uri = Some(decoded);
        }
    }

    data
}

/// Parses a GroupRenderingControl NOTIFY event body.
///
/// Extracts group volume and mute state.
#[must_use]
pub fn parse_group_rendering_control(body: &str) -> GroupRenderingData {
    let mut data = GroupRenderingData::default();

    // GroupRenderingControl uses direct element content, not LastChange
    if let Some(volume_str) = extract_xml_text(body, "GroupVolume") {
        if let Ok(volume) = volume_str.parse::<u8>() {
            // Sonos volumes are 0-100; clamp in case of malformed response
            data.volume = Some(volume.min(100));
        }
    }

    if let Some(mute_str) = extract_xml_text(body, "GroupMute") {
        data.muted = Some(mute_str == "1");
    }

    if let Some(fixed_str) = extract_xml_text(body, "OutputFixed") {
        data.output_fixed = Some(fixed_str == "1");
    }

    data
}

/// Parses a RenderingControl NOTIFY event body.
///
/// RenderingControl uses the LastChange XML format (like AVTransport).
/// Extracts Volume and Mute attributes with `channel="Master"` only,
/// ignoring per-speaker channels like LF/RF from stereo pairs.
#[must_use]
pub fn parse_rendering_control(body: &str) -> RenderingControlData {
    let mut data = RenderingControlData::default();

    // Extract LastChange from property set
    let Some(last_change) = extract_xml_text(body, "LastChange") else {
        return data;
    };

    let unescaped = html_escape::decode_html_entities(&last_change);

    // Extract Volume and Mute from the InstanceID element, Master channel only.
    // Format: <Volume channel="Master" val="42"/>
    //         <Mute channel="Master" val="0"/>
    // Stereo pairs also send LF/RF channels which we ignore.
    let attrs = extract_master_channel_attrs(&unescaped, &["Volume", "Mute"]);

    if let Some(val) = attrs.get("Volume") {
        if let Ok(volume) = val.parse::<u8>() {
            data.volume = Some(volume.min(100));
        }
    }

    if let Some(val) = attrs.get("Mute") {
        data.muted = Some(val == "1");
    }

    data
}

/// Parses a ZoneGroupTopology NOTIFY event body.
///
/// Extracts and parses the zone group state XML.
#[must_use]
pub fn parse_zone_group_topology(body: &str) -> Vec<ZoneGroup> {
    // Extract ZoneGroupState from property set
    let Some(zone_state) = extract_xml_text(body, "ZoneGroupState") else {
        return vec![];
    };

    let unescaped = html_escape::decode_html_entities(&zone_state);
    parse_zone_group_xml(&unescaped)
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
    // parse_rendering_control tests
    // ─────────────────────────────────────────────────────────────────────────────

    use super::super::test_fixtures::{
        RENDERING_CONTROL_NOTIFY_FULL, RENDERING_CONTROL_NOTIFY_MUTED,
        RENDERING_CONTROL_NOTIFY_VOLUME_ONLY,
    };

    #[test]
    fn parse_rendering_control_extracts_volume_and_mute() {
        let data = parse_rendering_control(RENDERING_CONTROL_NOTIFY_FULL);
        assert_eq!(data.volume, Some(42));
        assert_eq!(data.muted, Some(false));
    }

    #[test]
    fn parse_rendering_control_extracts_muted_state() {
        let data = parse_rendering_control(RENDERING_CONTROL_NOTIFY_MUTED);
        assert_eq!(data.volume, Some(75));
        assert_eq!(data.muted, Some(true));
    }

    #[test]
    fn parse_rendering_control_handles_volume_only() {
        let data = parse_rendering_control(RENDERING_CONTROL_NOTIFY_VOLUME_ONLY);
        assert_eq!(data.volume, Some(100));
        assert_eq!(data.muted, None);
    }

    #[test]
    fn parse_rendering_control_clamps_volume_to_100() {
        // Malformed response with volume > 100
        let body = r#"<?xml version="1.0"?>
<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">
  <e:property>
    <LastChange>&lt;Event&gt;&lt;InstanceID val=&quot;0&quot;&gt;
      &lt;Volume channel=&quot;Master&quot; val=&quot;150&quot;/&gt;
    &lt;/InstanceID&gt;&lt;/Event&gt;</LastChange>
  </e:property>
</e:propertyset>"#;
        let data = parse_rendering_control(body);
        assert_eq!(data.volume, Some(100));
    }

    #[test]
    fn parse_rendering_control_returns_default_for_empty_body() {
        let data = parse_rendering_control("");
        assert_eq!(data.volume, None);
        assert_eq!(data.muted, None);
    }

    #[test]
    fn parse_rendering_control_returns_default_for_missing_last_change() {
        let body = r#"<?xml version="1.0"?>
<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">
  <e:property>
    <SomeOtherElement>value</SomeOtherElement>
  </e:property>
</e:propertyset>"#;
        let data = parse_rendering_control(body);
        assert_eq!(data.volume, None);
        assert_eq!(data.muted, None);
    }

    #[test]
    fn parse_rendering_control_extracts_master_channel_only() {
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
        let data = parse_rendering_control(body);
        // Should extract Master (60), not LF/RF (50)
        assert_eq!(data.volume, Some(60));
    }

    #[test]
    fn parse_rendering_control_master_before_other_channels() {
        // Verify Master is extracted even when it appears before LF/RF
        // (the bug was that last element would win)
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
        let data = parse_rendering_control(body);
        // Should still extract Master (60), not RF (50) which appeared last
        assert_eq!(data.volume, Some(60));
    }

    #[test]
    fn parse_rendering_control_no_master_returns_none() {
        // If there's no Master channel, we should get None (not LF/RF values)
        let body = r#"<?xml version="1.0"?>
<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">
  <e:property>
    <LastChange>&lt;Event&gt;&lt;InstanceID val=&quot;0&quot;&gt;
      &lt;Volume channel=&quot;LF&quot; val=&quot;50&quot;/&gt;
      &lt;Volume channel=&quot;RF&quot; val=&quot;50&quot;/&gt;
    &lt;/InstanceID&gt;&lt;/Event&gt;</LastChange>
  </e:property>
</e:propertyset>"#;
        let data = parse_rendering_control(body);
        // No Master channel = no volume extracted
        assert_eq!(data.volume, None);
    }
}
