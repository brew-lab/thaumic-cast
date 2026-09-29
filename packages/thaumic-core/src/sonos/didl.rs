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
    format_didl_lite_as(stream_url, codec, audio_format, metadata, artwork_url, None)
}

/// [`format_didl_lite`], describing the item as a track of
/// `declared_data_bytes` of audio when that is set.
///
/// With `None` the item is an `object.item.audioItem.audioBroadcast` with no
/// duration or size, as every cast is started. With a data size it is an
/// `object.item.audioItem.musicTrack` whose `<res>` declares the duration of
/// that much audio in `audio_format` (`H:MM:SS.mmm`) and a size of the data
/// plus its 44-byte WAV header: an experiment for queued PCM segments (see
/// [`crate::stream::PcmSegmentDidl::Track`]).
pub(crate) fn format_didl_lite_as(
    stream_url: &str,
    codec: AudioCodec,
    audio_format: &AudioFormat,
    metadata: Option<&StreamMetadata>,
    artwork_url: &str,
    declared_data_bytes: Option<u64>,
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

    let (class, length) = match declared_data_bytes {
        Some(data_bytes) => (
            "object.item.audioItem.musicTrack",
            track_length_attrs(data_bytes, audio_format),
        ),
        None => ("object.item.audioItem.audioBroadcast", String::new()),
    };
    didl.push_str(&format!("<upnp:class>{class}</upnp:class>"));

    // Build <res> element with audio format attributes for proper Sonos configuration
    didl.push_str(&format!(
        r#"<res protocolInfo="http-get:*:{}:*"{} sampleFrequency="{}" nrAudioChannels="{}" bitsPerSample="{}">{}</res>"#,
        mime_type,
        length,
        audio_format.sample_rate,
        audio_format.channels,
        audio_format.bits_per_sample,
        escape_xml(stream_url)
    ));
    didl.push_str("</item>");
    didl.push_str("</DIDL-Lite>");

    didl
}

/// The ` duration="H:MM:SS.mmm" size="…"` attributes of a track holding
/// `data_bytes` of audio in `audio_format`, behind a 44-byte WAV header.
fn track_length_attrs(data_bytes: u64, audio_format: &AudioFormat) -> String {
    let byte_rate = (u64::from(audio_format.sample_rate)
        * u64::from(audio_format.channels)
        * audio_format.bytes_per_sample() as u64)
        .max(1);
    let ms = data_bytes.saturating_mul(1000) / byte_rate;
    format!(
        r#" duration="{}:{:02}:{:02}.{:03}" size="{}""#,
        ms / 3_600_000,
        ms / 60_000 % 60,
        ms / 1000 % 60,
        ms % 1000,
        data_bytes.saturating_add(44)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "http://192.168.1.50:49400/stream/abc/live/1";

    /// Every cast, and every queued segment by default, is a broadcast with
    /// no duration or size.
    #[test]
    fn an_item_is_a_broadcast_with_no_length_by_default() {
        let didl = format_didl_lite(URL, AudioCodec::Pcm, &AudioFormat::default(), None, "art");
        assert_eq!(
            didl,
            format_didl_lite_as(
                URL,
                AudioCodec::Pcm,
                &AudioFormat::default(),
                None,
                "art",
                None
            )
        );
        assert!(didl.contains("<upnp:class>object.item.audioItem.audioBroadcast</upnp:class>"));
        assert!(didl.contains(r#"<res protocolInfo="http-get:*:audio/wav:*" sampleFrequency"#));
        assert!(!didl.contains("duration="));
        assert!(!didl.contains("size="));
    }

    /// The track experiment declares a segment's duration and its size on
    /// the wire: 10485120 data bytes at 48 kHz stereo are 54.61 s.
    #[test]
    fn a_track_declares_its_duration_and_size() {
        let didl = format_didl_lite_as(
            URL,
            AudioCodec::Pcm,
            &AudioFormat::default(),
            None,
            "art",
            Some(10_485_120),
        );
        assert!(didl.contains("<upnp:class>object.item.audioItem.musicTrack</upnp:class>"));
        assert!(didl.contains(
            r#"<res protocolInfo="http-get:*:audio/wav:*" duration="0:00:54.610" size="10485164" "#
        ));
        let full = format_didl_lite_as(
            URL,
            AudioCodec::Pcm,
            &AudioFormat::default(),
            None,
            "art",
            Some(0xFFFF_0000),
        );
        assert!(full.contains(r#"duration="6:12:49.280" size="4294901804""#));
    }
}
