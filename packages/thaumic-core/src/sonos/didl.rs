//! DIDL-Lite metadata formatting for Sonos display.
//!
//! Creates the XML metadata structure that Sonos uses to display
//! track information (title, artist, album art) on the speaker's UI.

use crate::protocol_constants::APP_NAME;
use crate::sonos::utils::escape_xml;
use crate::stream::{AudioCodec, AudioFormat, StreamMetadata};

/// Formats DIDL-Lite metadata XML for Sonos display.
///
/// This creates the metadata structure that Sonos uses to display
/// track information (title, artist, album art) on the speaker's UI.
///
/// # Metadata Strategy
///
/// Since DIDL-Lite is only sent once at playback start (via SetAVTransportURI)
/// and ICY metadata only supports StreamTitle, we use static values for
/// album and artwork to prevent stale data:
///
/// - **Title**: Source name (e.g., "YouTube Music") - static, branded
/// - **Artist**: APP_NAME constant - static branding
/// - **Album**: "{source} • {APP_NAME}" for additional branding
/// - **Artwork**: Static app icon
///
/// The actual track info ("Artist - Title") comes from ICY StreamTitle which updates.
///
/// # Audio Format Attributes
///
/// The `<res>` element includes audio format attributes to help Sonos configure
/// playback correctly:
/// - `sampleFrequency`: Sample rate in Hz (e.g., 48000)
/// - `nrAudioChannels`: Number of channels (e.g., 2 for stereo)
/// - `bitsPerSample`: Bit depth (e.g., 16)
/// - `protocolInfo`: MIME type based on codec (audio/wav, audio/aac, etc.)
pub(crate) fn format_didl_lite(
    stream_url: &str,
    codec: AudioCodec,
    audio_format: &AudioFormat,
    metadata: Option<&StreamMetadata>,
    artwork_url: &str,
) -> String {
    log::debug!(
        "[DIDL] Incoming metadata: {:?}, codec={}, format={:?}",
        metadata.map(|m| format!(
            "title={:?}, artist={:?}, source={:?}",
            m.title, m.artist, m.source
        )),
        codec.as_str(),
        audio_format
    );

    // IMPORTANT: DIDL-Lite is sent once and never updates. ICY StreamTitle handles
    // dynamic track info ("Artist - Title"). To avoid duplication on Sonos display,
    // we use STATIC branded values here:
    //
    // Sonos displays:
    //   Line 1: ICY StreamTitle (dynamic, updates with each track)
    //   Line 2: DIDL-Lite dc:title (static, set once at playback start)
    //
    // So we set dc:title to "{source} • {APP_NAME}", not the song title.
    let title = match metadata.and_then(|m| m.source.as_deref()) {
        Some(source) => format!("{} • {}", source, APP_NAME),
        None => APP_NAME.to_string(),
    };
    let artist = APP_NAME;

    // Album also shows "{source} • {APP_NAME}" for consistency
    let album = title.clone();

    let mime_type = codec.mime_type();

    log::debug!(
        "[DIDL] Sending to Sonos: title={:?}, artist={:?}, album={:?}, mime={}, icon={:?}",
        title,
        artist,
        album,
        mime_type,
        artwork_url
    );

    let mut didl = String::from(
        r#"<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">"#,
    );
    didl.push_str(r#"<item id="0" parentID="-1" restricted="true">"#);
    didl.push_str(&format!("<dc:title>{}</dc:title>", escape_xml(&title)));
    didl.push_str(&format!("<dc:creator>{}</dc:creator>", escape_xml(artist)));

    // Always set album for consistent branding
    didl.push_str(&format!("<upnp:album>{}</upnp:album>", escape_xml(&album)));

    // Album art URL for Sonos display. Note: Android Sonos app requires HTTPS,
    // iOS works with HTTP. See: https://github.com/amp64/sonosbugtracker/issues/33
    didl.push_str(&format!(
        "<upnp:albumArtURI>{}</upnp:albumArtURI>",
        escape_xml(artwork_url)
    ));

    didl.push_str("<upnp:class>object.item.audioItem.audioBroadcast</upnp:class>");

    // Build <res> element with audio format attributes for proper Sonos configuration
    didl.push_str(&format!(
        r#"<res protocolInfo="http-get:*:{}:*" sampleFrequency="{}" nrAudioChannels="{}" bitsPerSample="{}">{}</res>"#,
        mime_type,
        audio_format.sample_rate,
        audio_format.channels,
        audio_format.bits_per_sample,
        escape_xml(stream_url)
    ));
    didl.push_str("</item>");
    didl.push_str("</DIDL-Lite>");

    didl
}
