//! Audio transcoding for PCM to various formats.
//!
//! This module provides the `Transcoder` trait and implementations for
//! converting audio data between formats. The primary use case is receiving
//! raw PCM audio from the browser extension and wrapping it in a streamable
//! container format for Sonos speakers.

use bytes::{BufMut, Bytes, BytesMut};
use parking_lot::Mutex;

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

/// WAV transcoder for PCM to WAV streaming.
///
/// Wraps raw PCM audio in a WAV container for streaming to Sonos speakers.
/// The WAV header uses unknown length (0xFFFFFFFF) for streaming compatibility.
pub struct WavTranscoder {
    /// Sample rate in Hz.
    sample_rate: u32,
    /// Number of audio channels.
    channels: u16,
    /// Bits per sample (always 16 for our use case).
    bits_per_sample: u16,
    /// Whether the WAV header has been sent.
    header_sent: Mutex<bool>,
}

impl WavTranscoder {
    /// Creates a new WAV transcoder.
    ///
    /// # Arguments
    /// * `sample_rate` - Sample rate in Hz (e.g., 48000)
    /// * `channels` - Number of audio channels (1 or 2)
    ///
    /// # Returns
    /// A new `WavTranscoder` instance configured for the given parameters.
    pub fn new(sample_rate: u32, channels: u16) -> Self {
        Self {
            sample_rate,
            channels,
            bits_per_sample: 16,
            header_sent: Mutex::new(false),
        }
    }

    /// Creates a WAV header for streaming (unknown length).
    fn create_header(&self) -> Bytes {
        let byte_rate =
            self.sample_rate * u32::from(self.channels) * u32::from(self.bits_per_sample) / 8;
        let block_align = self.channels * self.bits_per_sample / 8;

        let mut buf = BytesMut::with_capacity(44);

        // RIFF header
        buf.put_slice(b"RIFF");
        buf.put_u32_le(0xFFFF_FFFF); // Unknown file size for streaming

        // WAVE format
        buf.put_slice(b"WAVE");

        // fmt subchunk
        buf.put_slice(b"fmt ");
        buf.put_u32_le(16); // Subchunk1Size (16 for PCM)
        buf.put_u16_le(1); // AudioFormat (1 = PCM)
        buf.put_u16_le(self.channels);
        buf.put_u32_le(self.sample_rate);
        buf.put_u32_le(byte_rate);
        buf.put_u16_le(block_align);
        buf.put_u16_le(self.bits_per_sample);

        // data subchunk
        buf.put_slice(b"data");
        buf.put_u32_le(0xFFFF_FFFF); // Unknown data size for streaming

        buf.freeze()
    }
}

impl Transcoder for WavTranscoder {
    fn transcode(&self, input: &[u8]) -> Bytes {
        let mut header_sent = self.header_sent.lock();

        if !*header_sent {
            // First frame: prepend WAV header
            *header_sent = true;
            let header = self.create_header();
            log::debug!(
                "[WavTranscoder] Sending WAV header ({}Hz, {}ch)",
                self.sample_rate,
                self.channels
            );

            let mut buf = BytesMut::with_capacity(header.len() + input.len());
            buf.put(header);
            buf.put_slice(input);
            buf.freeze()
        } else {
            // Subsequent frames: pass through raw PCM
            Bytes::copy_from_slice(input)
        }
    }

    fn description(&self) -> &'static str {
        "PCM → WAV"
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
    fn test_wav_transcoder_creates() {
        let transcoder = WavTranscoder::new(48000, 2);
        assert_eq!(transcoder.sample_rate, 48000);
        assert_eq!(transcoder.channels, 2);
        assert_eq!(transcoder.description(), "PCM → WAV");
    }

    #[test]
    fn test_wav_transcoder_header() {
        let transcoder = WavTranscoder::new(48000, 2);

        // Create some PCM data
        let pcm_data = vec![0u8; 100];
        let output = transcoder.transcode(&pcm_data);

        // WAV output should start with "RIFF"
        assert!(output.len() >= 44 + 100);
        assert_eq!(&output[0..4], b"RIFF");
        assert_eq!(&output[8..12], b"WAVE");
    }

    #[test]
    fn test_wav_transcoder_header_sent_once() {
        let transcoder = WavTranscoder::new(48000, 2);
        let pcm_data = vec![0u8; 100];

        // First call includes header
        let first = transcoder.transcode(&pcm_data);
        assert!(first.starts_with(b"RIFF"));
        assert_eq!(first.len(), 44 + 100);

        // Second call should NOT include header
        let second = transcoder.transcode(&pcm_data);
        assert!(!second.starts_with(b"RIFF"));
        assert_eq!(second.len(), 100);
    }
}
