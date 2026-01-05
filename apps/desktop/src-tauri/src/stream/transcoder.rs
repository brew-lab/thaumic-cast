//! Audio transcoding for PCM to various formats.
//!
//! This module provides the `Transcoder` trait and implementations for
//! converting audio data between formats. The primary use case is receiving
//! raw PCM audio from the browser extension and wrapping it in a streamable
//! container format for Sonos speakers.

use bytes::Bytes;

/// Trait for audio format transcoding.
///
/// Implementations convert input audio data to the target format.
/// This abstraction allows `StreamState` to handle different input
/// formats without knowing the encoding details.
pub trait Transcoder: Send + Sync {
    /// Transcodes audio data from input format to output format.
    ///
    /// # Arguments
    /// * `input` - Raw input bytes (format depends on implementation)
    ///
    /// # Returns
    /// Transcoded output bytes ready for streaming.
    fn transcode(&self, input: &[u8]) -> Bytes;

    /// Returns a description of the transcoding operation for logging.
    fn description(&self) -> &'static str;
}

/// Passthrough transcoder that performs no conversion.
///
/// Used for already-encoded formats (AAC, FLAC, Vorbis) where the
/// browser has already performed encoding.
pub struct Passthrough;

impl Transcoder for Passthrough {
    fn transcode(&self, input: &[u8]) -> Bytes {
        Bytes::copy_from_slice(input)
    }

    fn description(&self) -> &'static str {
        "passthrough"
    }
}

/// WAV transcoder - passthrough for PCM data.
///
/// For WAV streaming, the PCM data is passed through unchanged.
/// The WAV header is added per-HTTP-connection by the HTTP handler,
/// not by the transcoder, because Sonos may reconnect and needs
/// a fresh header each time.
pub struct WavTranscoder;

impl WavTranscoder {
    /// Creates a new WAV transcoder (passthrough).
    pub fn new(_sample_rate: u32, _channels: u16) -> Self {
        Self
    }
}

impl Transcoder for WavTranscoder {
    fn transcode(&self, input: &[u8]) -> Bytes {
        // Just pass through raw PCM - header added by HTTP handler per connection
        Bytes::copy_from_slice(input)
    }

    fn description(&self) -> &'static str {
        "PCM passthrough (WAV header per connection)"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_passthrough() {
        let transcoder = Passthrough;
        let input = vec![1u8, 2, 3, 4, 5];
        let output = transcoder.transcode(&input);
        assert_eq!(output.as_ref(), input.as_slice());
    }

    #[test]
    fn test_wav_transcoder_passthrough() {
        let transcoder = WavTranscoder::new(48000, 2);
        let pcm_data = vec![1u8, 2, 3, 4, 5];

        // WavTranscoder just passes through - header added by HTTP handler
        let output = transcoder.transcode(&pcm_data);
        assert_eq!(output.as_ref(), pcm_data.as_slice());
    }
}
