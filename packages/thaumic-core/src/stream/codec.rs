//! The codecs a stream can be served in, and the one table of what the server
//! decides from each.

use serde::Serialize;

use super::tap::WAV_HEADER_BYTES;

/// Supported audio codecs for the stream.
///
/// Note: `Pcm` outputs as WAV container (PCM + RIFF headers) for Sonos compatibility.
/// The MIME type and file extensions remain `audio/wav` and `.wav` because that's
/// what Sonos expects, but the actual codec is uncompressed PCM.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AudioCodec {
    Pcm,
    Aac,
    Mp3,
    Flac,
}

/// Cleanup ordering for stream teardown.
///
/// Sonos devices behave differently depending on the codec, which affects the
/// safe order for closing the HTTP stream vs sending SOAP stop commands.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CleanupOrder {
    /// Close the HTTP stream before sending SOAP stop commands.
    ///
    /// Required for PCM: Sonos blocks on HTTP reads for uncompressed audio,
    /// so SOAP commands would timeout if the HTTP connection is still open.
    HttpFirst,
    /// Send SOAP stop commands before closing the HTTP stream.
    ///
    /// Required for compressed codecs: Sonos has an internal decoder buffer,
    /// so stopping playback first prevents draining buffered audio after
    /// the stream source is gone.
    SoapFirst,
}

/// How a speaker is given the URL of a stream of some codec.
///
/// Sonos picks its handling from the URL: the scheme and, for a plain HTTP
/// item, the file extension.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CodecUri {
    /// Plain `http://`, with this file extension appended for format
    /// detection (dot included, e.g. `".wav"`).
    Http {
        /// The extension appended to the stream URL.
        extension: &'static str,
    },
    /// The `x-rincon-mp3radio://` scheme, which Sonos handles as internet
    /// radio.
    Mp3Radio,
}

/// Everything the server decides from a stream's codec alone, one row per
/// codec (see [`AudioCodec::facts`]).
///
/// Each field is one reason, named for it. Two fields that hold the same
/// values today are still two reasons, and are not to be merged or read in
/// each other's place.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CodecFacts {
    /// Short identifier (e.g. `"pcm"`); see [`AudioCodec::as_str`].
    pub name: &'static str,
    /// The `Content-Type` a connection is served with; see
    /// [`AudioCodec::mime_type`].
    pub mime: &'static str,
    /// Which of the HTTP stream and the SOAP stop goes first at teardown; see
    /// [`CleanupOrder`].
    pub cleanup_order: CleanupOrder,
    /// The scheme and extension of the URL a speaker is given.
    pub uri: CodecUri,
    /// Whether a connection can carry ICY metadata, when the client asks
    /// for it.
    pub icy: bool,
    /// Bytes of container header a connection sends before its first audio
    /// byte: the WAV header for PCM, nothing for a compressed codec.
    pub container_header_bytes: u32,
    /// Whether the codec is served through the PCM serving path: the fixed
    /// cadence with silence on underrun, the first-connection wait, segments
    /// and their continuation, the PCM HTTP switches, the resume `Play`, the
    /// exact byte rate a connection's tap measures with, and rate control.
    pub paced: bool,
    /// Whether a new stream's ring is raised from the configured size to at
    /// least [`pcm_ring_frames`], so it holds the connect burst plus the
    /// jitter buffer.
    ///
    /// [`pcm_ring_frames`]: crate::protocol_constants::pcm_ring_frames
    pub ring_floor: bool,
    /// Whether 24-bit samples are accepted; any other codec falls back to
    /// 16-bit.
    pub allows_24_bit: bool,
}

impl AudioCodec {
    /// The facts the server decides from this codec: the one table every
    /// per-codec decision reads.
    #[must_use]
    pub const fn facts(self) -> &'static CodecFacts {
        match self {
            Self::Pcm => &CodecFacts {
                name: "pcm",
                // WAV container for Sonos compatibility
                mime: "audio/wav",
                cleanup_order: CleanupOrder::HttpFirst,
                // Keep http://, add .wav extension for Sonos format detection
                uri: CodecUri::Http { extension: ".wav" },
                icy: false,
                container_header_bytes: WAV_HEADER_BYTES,
                paced: true,
                ring_floor: true,
                allows_24_bit: false,
            },
            Self::Aac => &CodecFacts {
                name: "aac",
                mime: "audio/aac",
                cleanup_order: CleanupOrder::SoapFirst,
                uri: CodecUri::Mp3Radio,
                icy: true,
                container_header_bytes: 0,
                paced: false,
                ring_floor: false,
                allows_24_bit: false,
            },
            Self::Mp3 => &CodecFacts {
                name: "mp3",
                mime: "audio/mpeg",
                cleanup_order: CleanupOrder::SoapFirst,
                uri: CodecUri::Mp3Radio,
                icy: true,
                container_header_bytes: 0,
                paced: false,
                ring_floor: false,
                allows_24_bit: false,
            },
            Self::Flac => &CodecFacts {
                name: "flac",
                mime: "audio/flac",
                cleanup_order: CleanupOrder::SoapFirst,
                // Keep http://, add .flac extension
                uri: CodecUri::Http { extension: ".flac" },
                icy: false,
                container_header_bytes: 0,
                paced: false,
                ring_floor: false,
                // 24-bit is only supported for FLAC, on Sonos S2 speakers.
                allows_24_bit: true,
            },
        }
    }

    /// Returns the cleanup ordering required for this codec during stream teardown.
    #[must_use]
    pub const fn cleanup_order(&self) -> CleanupOrder {
        self.facts().cleanup_order
    }

    /// Returns the codec as a short string identifier (e.g., "pcm", "aac").
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        self.facts().name
    }

    /// Returns the MIME type for this codec.
    ///
    /// Note: PCM returns "audio/wav" because it's served in a WAV container for Sonos.
    #[must_use]
    pub const fn mime_type(&self) -> &'static str {
        self.facts().mime
    }
}
