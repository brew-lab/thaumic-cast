//! Audio transcoding for PCM to FLAC conversion.
//!
//! This module provides the `Transcoder` trait and implementations for
//! converting audio data between formats. The primary use case is receiving
//! raw PCM audio from the browser extension and encoding it to FLAC for
//! lossless streaming to Sonos speakers.

use bytes::Bytes;
use flacenc::bitsink::ByteSink;
use flacenc::component::BitRepr;
use flacenc::config;
use flacenc::error::{Verified, Verify};
use flacenc::source::MemSource;
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

/// FLAC encoder for PCM to FLAC transcoding.
///
/// Receives interleaved 16-bit PCM samples from the browser and encodes
/// them to FLAC frames for lossless streaming to Sonos speakers.
pub struct FlacTranscoder {
    /// FLAC encoder configuration (verified).
    config: Verified<config::Encoder>,
    /// Sample rate in Hz.
    sample_rate: u32,
    /// Number of audio channels.
    channels: u16,
    /// Bits per sample (always 16 for our use case).
    bits_per_sample: u16,
    /// Block size for FLAC encoding.
    block_size: usize,
    /// Whether the stream header has been sent.
    header_sent: Mutex<bool>,
}

impl FlacTranscoder {
    /// Creates a new FLAC transcoder.
    ///
    /// # Arguments
    /// * `sample_rate` - Sample rate in Hz (e.g., 48000)
    /// * `channels` - Number of audio channels (1 or 2)
    ///
    /// # Returns
    /// A new `FlacTranscoder` instance configured for the given parameters.
    ///
    /// # Panics
    /// Panics if the encoder config fails verification (should never happen with defaults).
    pub fn new(sample_rate: u32, channels: u16) -> Self {
        // Use default encoder config (compression level ~5, good balance)
        // and verify it for use with encode_with_fixed_block_size
        let config = config::Encoder::default()
            .into_verified()
            .expect("Default FLAC encoder config should always be valid");

        Self {
            config,
            sample_rate,
            channels,
            bits_per_sample: 16,
            // 4096 samples per channel = ~85ms at 48kHz
            // Good balance between compression and latency
            block_size: 4096,
            header_sent: Mutex::new(false),
        }
    }

    /// Encodes PCM samples to FLAC.
    ///
    /// # Arguments
    /// * `pcm` - Interleaved 16-bit PCM samples
    ///
    /// # Returns
    /// FLAC-encoded bytes. First call includes stream header.
    fn encode_pcm(&self, pcm: &[i16]) -> Bytes {
        // Convert i16 to i32 (flacenc expects i32 samples)
        let samples_i32: Vec<i32> = pcm.iter().map(|&s| i32::from(s)).collect();

        // Create source from samples
        let source = MemSource::from_samples(
            &samples_i32,
            self.channels as usize,
            self.bits_per_sample as usize,
            self.sample_rate as usize,
        );

        // Encode to FLAC
        let stream = flacenc::encode_with_fixed_block_size(&self.config, source, self.block_size)
            .expect("FLAC encoding failed");

        // Serialize to bytes
        let mut sink = ByteSink::new();

        let mut header_sent = self.header_sent.lock();
        if !*header_sent {
            // First encode: write full stream (header + frames)
            stream.write(&mut sink).expect("FLAC write failed");
            *header_sent = true;
            log::debug!(
                "[FlacTranscoder] Wrote stream header + {} frames",
                stream.frame_count()
            );
        } else {
            // Subsequent: write only the frame data
            for i in 0..stream.frame_count() {
                stream
                    .frame(i)
                    .expect("Frame access failed")
                    .write(&mut sink)
                    .expect("FLAC frame write failed");
            }
        }

        Bytes::from(sink.into_inner())
    }
}

impl Transcoder for FlacTranscoder {
    fn transcode(&self, input: &[u8]) -> Bytes {
        // Input is raw bytes from WebSocket, interpret as i16 PCM
        // Safety: We control the sender (extension) which sends properly aligned i16 data
        let pcm: &[i16] = bytemuck::cast_slice(input);
        self.encode_pcm(pcm)
    }

    fn description(&self) -> &'static str {
        "PCM → FLAC"
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
    fn test_flac_transcoder_creates() {
        let transcoder = FlacTranscoder::new(48000, 2);
        assert_eq!(transcoder.sample_rate, 48000);
        assert_eq!(transcoder.channels, 2);
        assert_eq!(transcoder.description(), "PCM → FLAC");
    }

    #[test]
    fn test_flac_transcoder_encodes_silence() {
        let transcoder = FlacTranscoder::new(48000, 2);

        // Create 20ms of silence (960 stereo samples = 1920 i16 values)
        let silence: Vec<i16> = vec![0i16; 1920];
        let input_bytes: &[u8] = bytemuck::cast_slice(&silence);

        let output = transcoder.transcode(input_bytes);

        // FLAC output should start with "fLaC" magic bytes
        assert!(output.len() > 4);
        assert_eq!(&output[0..4], b"fLaC");
    }

    #[test]
    fn test_flac_transcoder_header_sent_once() {
        let transcoder = FlacTranscoder::new(48000, 2);
        let silence: Vec<i16> = vec![0i16; 1920];
        let input_bytes: &[u8] = bytemuck::cast_slice(&silence);

        // First call includes header
        let first = transcoder.transcode(input_bytes);
        assert!(first.starts_with(b"fLaC"));

        // Second call should NOT include header
        let second = transcoder.transcode(input_bytes);
        assert!(!second.starts_with(b"fLaC"));
    }
}
