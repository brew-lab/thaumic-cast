use std::collections::HashMap;

use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;

use crate::stream::AudioCodec;

/// Default Sonos speaker control port.
pub const SONOS_PORT: u16 = 1400;

// ─────────────────────────────────────────────────────────────────────────────
// XML Parsing Utilities
// ─────────────────────────────────────────────────────────────────────────────

/// Extracts text content from the first occurrence of an XML element.
///
/// Searches for an element by its local name (ignoring namespace prefixes)
/// and returns its decoded text content.
///
/// # Arguments
/// * `xml` - The XML string to search
/// * `element_name` - The local name of the element to find (without namespace prefix)
///
/// # Returns
/// The text content of the element with HTML entities decoded, or None if not found.
///
/// # Example
/// ```ignore
/// let xml = r#"<u:CurrentVolume>42</u:CurrentVolume>"#;
/// assert_eq!(extract_xml_text(xml, "CurrentVolume"), Some("42".to_string()));
/// ```
pub fn extract_xml_text(xml: &str, element_name: &str) -> Option<String> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let target_bytes = element_name.as_bytes();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) if e.local_name().as_ref() == target_bytes => {
                if let Ok(text) = reader.read_text(e.name()) {
                    let decoded = html_escape::decode_html_entities(&text);
                    return Some(decoded.to_string());
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    None
}

/// Extracts `val` attributes from empty XML elements.
///
/// Many UPnP/GENA events use empty elements with `val` attributes to convey state:
/// ```xml
/// <TransportState val="PLAYING"/>
/// <CurrentTrackURI val="http://..."/>
/// ```
///
/// This function extracts those values for a given set of element names.
///
/// # Arguments
/// * `xml` - The XML string to parse
/// * `element_names` - Element names to look for (local names, without namespace prefix)
///
/// # Returns
/// A map from element name to its `val` attribute value.
/// Only elements that exist and have a `val` attribute are included.
///
/// # Example
/// ```ignore
/// let xml = r#"<Event><TransportState val="PLAYING"/><Volume val="50"/></Event>"#;
/// let attrs = extract_empty_val_attrs(xml, &["TransportState", "Volume"]);
/// assert_eq!(attrs.get("TransportState"), Some(&"PLAYING".to_string()));
/// assert_eq!(attrs.get("Volume"), Some(&"50".to_string()));
/// ```
pub fn extract_empty_val_attrs(xml: &str, element_names: &[&str]) -> HashMap<String, String> {
    let mut result = HashMap::new();
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();

    // Convert to bytes for comparison
    let targets: Vec<&[u8]> = element_names.iter().map(|s| s.as_bytes()).collect();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Empty(ref e)) => {
                let local = e.local_name();
                let local_ref = local.as_ref();
                if let Some(&name) = targets.iter().find(|&&t| t == local_ref) {
                    if let Some(val) = get_xml_attr(e, b"val") {
                        // Safe: name came from element_names which are &str
                        let key = std::str::from_utf8(name).unwrap_or_default();
                        result.insert(key.to_string(), val);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    result
}

// ─────────────────────────────────────────────────────────────────────────────
// Zone Group Parsing Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Extracts IP address from a UPnP Location URL.
///
/// # Arguments
/// * `location` - URL in format "http://192.168.1.100:1400/xml/..."
///
/// # Returns
/// The IP address portion, or None if the URL format is invalid.
///
/// # Example
/// ```ignore
/// let ip = extract_ip_from_location("http://192.168.1.100:1400/xml/device_desc.xml");
/// assert_eq!(ip, Some("192.168.1.100".to_string()));
/// ```
pub fn extract_ip_from_location(location: &str) -> Option<String> {
    let stripped = location.strip_prefix("http://")?;
    let host_end = stripped.find(':')?;
    Some(stripped[..host_end].to_string())
}

/// Extracts model name from a Sonos Icon URL.
///
/// The Icon attribute contains the device type in format like "x-rincon-cpicon:sonos-one-g1".
/// This function extracts the model portion (e.g., "one") without formatting.
///
/// # Arguments
/// * `icon` - Icon URL from the device description
///
/// # Returns
/// The model name in lowercase, or "unknown" if extraction fails.
///
/// # Example
/// ```ignore
/// assert_eq!(extract_model_from_icon("x-rincon-cpicon:sonos-arc"), "arc");
/// assert_eq!(extract_model_from_icon("x-rincon-cpicon:sonos-one-g1"), "one");
/// ```
pub fn extract_model_from_icon(icon: &str) -> String {
    if let Some(pos) = icon.find("sonos-") {
        let rest = &icon[pos + 6..];
        // Take until next dash or end
        if let Some(end) = rest.find('-') {
            return rest[..end].to_string();
        }
        return rest.to_string();
    }
    "unknown".to_string()
}

/// Parses channel role from HTSatChanMapSet for a given speaker UUID.
///
/// The HTSatChanMapSet attribute on a coordinator contains channel assignments
/// for all speakers in a home theater setup.
///
/// # Format
/// `"UUID1:LF,RF;UUID2:SW;UUID3:LR;UUID4:RR"`
///
/// # Channel Codes
/// - `LF,RF` - Left+Right Front → "Soundbar"
/// - `SW` - Subwoofer → "Subwoofer"
/// - `LR` - Left Rear → "Surround Left"
/// - `RR` - Right Rear → "Surround Right"
/// - `LF` - Left Front only → "Left"
/// - `RF` - Right Front only → "Right"
///
/// # Arguments
/// * `ht_sat_chan_map` - The HTSatChanMapSet attribute value
/// * `uuid` - The UUID of the speaker to look up
///
/// # Returns
/// The human-readable channel role, or None if the UUID is not in the map.
pub fn get_channel_role(ht_sat_chan_map: &str, uuid: &str) -> Option<String> {
    for mapping in ht_sat_chan_map.split(';') {
        if let Some((map_uuid, channels)) = mapping.split_once(':') {
            if map_uuid == uuid {
                return Some(
                    match channels {
                        "LF,RF" => "Soundbar",
                        "SW" => "Subwoofer",
                        "LR" => "Surround Left",
                        "RR" => "Surround Right",
                        "LF" => "Left",
                        "RF" => "Right",
                        other => other,
                    }
                    .to_string(),
                );
            }
        }
    }
    None
}

// ─────────────────────────────────────────────────────────────────────────────
// URL Building
// ─────────────────────────────────────────────────────────────────────────────

/// Converts an HTTP/HTTPS URL to a Sonos-compatible `x-rincon-mp3radio://` URI.
///
/// Sonos speakers require stream URLs to use the `x-rincon-mp3radio://` scheme
/// instead of `http://` or `https://`. This function performs that conversion.
///
/// # Arguments
/// * `uri` - The original stream URL (http:// or https://)
///
/// # Returns
/// The URI with the scheme replaced by `x-rincon-mp3radio://`
///
/// # Example
/// ```ignore
/// assert_eq!(
///     normalize_sonos_uri("http://192.168.1.50:8080/stream"),
///     "x-rincon-mp3radio://192.168.1.50:8080/stream"
/// );
/// assert_eq!(
///     normalize_sonos_uri("https://example.com/audio"),
///     "x-rincon-mp3radio://example.com/audio"
/// );
/// ```
pub fn normalize_sonos_uri(uri: &str) -> String {
    if uri.starts_with("https://") {
        uri.replace("https://", "x-rincon-mp3radio://")
    } else {
        uri.replace("http://", "x-rincon-mp3radio://")
    }
}

/// Builds a Sonos-compatible stream URI with proper scheme and file extension.
///
/// Different codecs require different URI schemes:
/// - WAV/FLAC: Use `http://` with `.wav`/`.flac` extension (Sonos uses URL suffix for format detection)
/// - MP3/AAC: Use `x-rincon-mp3radio://` scheme (optimized for internet radio)
///
/// # Arguments
/// * `base_uri` - The base stream URL (http://...)
/// * `codec` - The audio codec being streamed
///
/// # Returns
/// A properly formatted URI for Sonos playback
pub fn build_sonos_stream_uri(base_uri: &str, codec: AudioCodec) -> String {
    match codec {
        AudioCodec::Wav => {
            // WAV: Keep http://, add .wav extension
            // Sonos identifies format by URL suffix, not Content-Type
            format!("{}.wav", base_uri)
        }
        AudioCodec::Flac => {
            // FLAC: Keep http://, add .flac extension
            format!("{}.flac", base_uri)
        }
        AudioCodec::Aac | AudioCodec::Mp3 => {
            // MP3/AAC: Use x-rincon-mp3radio:// scheme
            normalize_sonos_uri(base_uri)
        }
    }
}

/// Builds a Sonos speaker URL for the given IP and endpoint.
///
/// # Arguments
/// * `ip` - The speaker's IP address
/// * `endpoint` - The UPnP endpoint path (e.g., "/MediaRenderer/AVTransport/Control")
///
/// # Returns
/// A fully-formed HTTP URL string
pub fn build_sonos_url(ip: &str, endpoint: &str) -> String {
    format!("http://{}:{}{}", ip, SONOS_PORT, endpoint)
}

/// Gets an attribute value from an XML element.
///
/// # Arguments
/// * `elem` - The XML element to search
/// * `attr_name` - The attribute name as bytes (e.g., `b"ZoneName"`)
///
/// # Returns
/// The attribute value as a String, or None if not found
pub fn get_xml_attr(elem: &BytesStart, attr_name: &[u8]) -> Option<String> {
    elem.attributes()
        .flatten()
        .find(|a| a.key.as_ref() == attr_name)
        .map(|a| String::from_utf8_lossy(&a.value).to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// XML Encoding
// ─────────────────────────────────────────────────────────────────────────────

/// Escapes XML special characters for embedding in XML content.
///
/// This escapes all five XML special characters as required by the XML spec:
/// - `&` → `&amp;`
/// - `<` → `&lt;`
/// - `>` → `&gt;`
/// - `"` → `&quot;`
/// - `'` → `&apos;`
///
/// Used for SOAP arguments and DIDL-Lite metadata values.
///
/// # Example
/// ```ignore
/// assert_eq!(escape_xml("Tom & Jerry"), "Tom &amp; Jerry");
/// assert_eq!(escape_xml("<title>"), "&lt;title&gt;");
/// ```
pub fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
