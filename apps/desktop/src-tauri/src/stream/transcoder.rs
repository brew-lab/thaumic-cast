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
/// Used for:
/// - Already-encoded formats (AAC, FLAC, Vorbis) where the browser has already performed encoding
/// - PCM/WAV streams where the WAV header is added per-HTTP-connection by the HTTP handler
pub struct Passthrough;

impl Transcoder for Passthrough {
    fn transcode(&self, input: &[u8]) -> Bytes {
        Bytes::copy_from_slice(input)
    }

    fn description(&self) -> &'static str {
        "passthrough"
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
}
