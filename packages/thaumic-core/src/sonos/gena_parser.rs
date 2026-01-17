//! GENA event XML parsing.
//!
//! This module contains pure parsing functions for GENA NOTIFY payloads.
//! It separates XML parsing concerns from subscription lifecycle management.

use crate::sonos::client::parse_zone_group_xml;
use crate::sonos::types::{TransportState, ZoneGroup};
use crate::sonos::utils::{extract_empty_val_attrs, extract_xml_text};

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
}
