//! The codecs a stream can be served in, and what teardown each one needs.

use serde::Serialize;

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

impl AudioCodec {
    /// Returns the cleanup ordering required for this codec during stream teardown.
    #[must_use]
    pub const fn cleanup_order(&self) -> CleanupOrder {
        match self {
            Self::Pcm => CleanupOrder::HttpFirst,
            _ => CleanupOrder::SoapFirst,
        }
    }

    /// Returns the codec as a short string identifier (e.g., "pcm", "aac").
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Pcm => "pcm",
            Self::Aac => "aac",
            Self::Mp3 => "mp3",
            Self::Flac => "flac",
        }
    }

    /// Returns the MIME type for this codec.
    ///
    /// Note: PCM returns "audio/wav" because it's served in a WAV container for Sonos.
    #[must_use]
    pub const fn mime_type(&self) -> &'static str {
        match self {
            Self::Pcm => "audio/wav", // WAV container for Sonos compatibility
            Self::Aac => "audio/aac",
            Self::Mp3 => "audio/mpeg",
            Self::Flac => "audio/flac",
        }
    }
}
