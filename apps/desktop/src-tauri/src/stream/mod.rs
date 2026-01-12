pub mod icy;
pub mod manager;
pub mod transcoder;
pub mod wav;

pub use icy::{IcyMetadataInjector, ICY_METAINT};
pub use manager::{
    AudioCodec, PlaybackEpoch, StreamManager, StreamMetadata, StreamState, StreamTiming,
};
pub use transcoder::{Passthrough, Transcoder};
pub use wav::create_wav_header;

use bytes::Bytes;

use crate::protocol_constants::{DEFAULT_CHANNELS, DEFAULT_SAMPLE_RATE};

/// Audio format configuration for a stream.
///
/// Describes the PCM audio format being streamed, used for:
/// - WAV header generation (sample rate, channels, bit depth)
/// - Silence frame generation (keepalive during delivery gaps)
#[derive(Debug, Clone, Copy)]
pub struct AudioFormat {
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
}

impl AudioFormat {
    /// Creates a new audio format configuration.
    pub fn new(sample_rate: u32, channels: u16, bits_per_sample: u16) -> Self {
        Self {
            sample_rate,
            channels,
            bits_per_sample,
        }
    }

    /// Calculates the frame size in bytes for the given duration.
    ///
    /// Uses saturating arithmetic to prevent overflow with extreme values.
    #[inline]
    pub fn frame_bytes(&self, duration_ms: u32) -> usize {
        let samples_per_channel =
            (self.sample_rate as u64).saturating_mul(duration_ms as u64) / 1000;
        let bytes_per_sample = (self.bits_per_sample / 8) as u64;

        samples_per_channel
            .saturating_mul(self.channels as u64)
            .saturating_mul(bytes_per_sample) as usize
    }

    /// Creates a silence frame of the specified duration.
    ///
    /// Returns a `Bytes` buffer filled with zeros (digital silence).
    /// Used to keep the HTTP stream alive during delivery gaps.
    pub fn silence_frame(&self, duration_ms: u32) -> Bytes {
        Bytes::from(vec![0u8; self.frame_bytes(duration_ms)])
    }
}

impl Default for AudioFormat {
    fn default() -> Self {
        Self {
            sample_rate: DEFAULT_SAMPLE_RATE,
            channels: DEFAULT_CHANNELS,
            bits_per_sample: 16,
        }
    }
}

/// Tagged audio frame distinguishing real audio from injected silence.
///
/// Used in the HTTP stream pipeline to ensure epoch tracking only fires
/// on actual audio data, not keepalive silence frames.
#[derive(Clone)]
pub enum TaggedFrame {
    /// Real audio data from the broadcast channel
    Audio(Bytes),
    /// Injected silence to keep connection alive during delivery gaps
    Silence(Bytes),
}

impl TaggedFrame {
    /// Returns the underlying bytes regardless of frame type.
    #[inline]
    pub fn into_bytes(self) -> Bytes {
        match self {
            TaggedFrame::Audio(b) | TaggedFrame::Silence(b) => b,
        }
    }

    /// Returns a reference to the underlying bytes.
    #[inline]
    pub fn as_bytes(&self) -> &Bytes {
        match self {
            TaggedFrame::Audio(b) | TaggedFrame::Silence(b) => b,
        }
    }

    /// Returns true if this is real audio (not injected silence).
    #[inline]
    pub fn is_real_audio(&self) -> bool {
        matches!(self, TaggedFrame::Audio(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod audio_format {
        use super::*;

        #[test]
        fn frame_bytes_standard_cd_quality() {
            // CD quality: 44100 Hz, stereo, 16-bit
            let format = AudioFormat::new(44100, 2, 16);
            // 20ms of audio: 44100 * 0.020 = 882 samples per channel
            // 882 * 2 channels * 2 bytes = 3528 bytes
            assert_eq!(format.frame_bytes(20), 3528);
        }

        #[test]
        fn frame_bytes_48khz_stereo() {
            // Common streaming format: 48000 Hz, stereo, 16-bit
            let format = AudioFormat::new(48000, 2, 16);
            // 20ms of audio: 48000 * 0.020 = 960 samples per channel
            // 960 * 2 channels * 2 bytes = 3840 bytes
            assert_eq!(format.frame_bytes(20), 3840);
        }

        #[test]
        fn frame_bytes_one_second() {
            let format = AudioFormat::new(48000, 2, 16);
            // 1 second: 48000 samples * 2 channels * 2 bytes = 192000 bytes
            assert_eq!(format.frame_bytes(1000), 192000);
        }

        #[test]
        fn frame_bytes_mono() {
            let format = AudioFormat::new(48000, 1, 16);
            // 20ms mono: 960 samples * 1 channel * 2 bytes = 1920 bytes
            assert_eq!(format.frame_bytes(20), 1920);
        }

        #[test]
        fn frame_bytes_24bit() {
            let format = AudioFormat::new(48000, 2, 24);
            // 20ms 24-bit: 960 samples * 2 channels * 3 bytes = 5760 bytes
            assert_eq!(format.frame_bytes(20), 5760);
        }

        #[test]
        fn frame_bytes_does_not_overflow_with_large_values() {
            // Extreme but technically valid: 192kHz, 8 channels, 32-bit, 1 minute
            let format = AudioFormat::new(192000, 8, 32);
            // Should not panic, uses saturating arithmetic
            let result = format.frame_bytes(60000);
            // 192000 * 60 = 11,520,000 samples per channel
            // 11,520,000 * 8 channels * 4 bytes = 368,640,000 bytes
            assert_eq!(result, 368_640_000);
        }

        #[test]
        fn silence_frame_has_correct_length() {
            let format = AudioFormat::new(48000, 2, 16);
            let silence = format.silence_frame(20);
            assert_eq!(silence.len(), 3840);
        }

        #[test]
        fn silence_frame_is_all_zeros() {
            let format = AudioFormat::new(48000, 2, 16);
            let silence = format.silence_frame(20);
            assert!(silence.iter().all(|&b| b == 0));
        }

        #[test]
        fn default_matches_expected_values() {
            let format = AudioFormat::default();
            assert_eq!(format.sample_rate, 48000);
            assert_eq!(format.channels, 2);
            assert_eq!(format.bits_per_sample, 16);
        }
    }

    mod tagged_frame {
        use super::*;

        #[test]
        fn audio_frame_is_real_audio() {
            let frame = TaggedFrame::Audio(Bytes::from_static(b"audio"));
            assert!(frame.is_real_audio());
        }

        #[test]
        fn silence_frame_is_not_real_audio() {
            let frame = TaggedFrame::Silence(Bytes::from_static(b"\0\0\0\0"));
            assert!(!frame.is_real_audio());
        }

        #[test]
        fn into_bytes_extracts_audio_content() {
            let data = Bytes::from_static(b"audio data");
            let frame = TaggedFrame::Audio(data.clone());
            assert_eq!(frame.into_bytes(), data);
        }

        #[test]
        fn into_bytes_extracts_silence_content() {
            let data = Bytes::from_static(b"\0\0\0\0");
            let frame = TaggedFrame::Silence(data.clone());
            assert_eq!(frame.into_bytes(), data);
        }

        #[test]
        fn as_bytes_returns_reference() {
            let data = Bytes::from_static(b"test");
            let frame = TaggedFrame::Audio(data.clone());
            assert_eq!(frame.as_bytes(), &data);
        }
    }
}
