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
    #[inline]
    pub fn frame_bytes(&self, duration_ms: u32) -> usize {
        let samples_per_channel = (self.sample_rate * duration_ms) / 1000;
        samples_per_channel as usize * self.channels as usize * (self.bits_per_sample / 8) as usize
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
