pub mod cadence;
pub mod icy;
pub mod manager;
pub mod wav;

pub use cadence::{
    create_wav_stream_with_cadence, lagged_error, CadenceConfig, LoggingStreamGuard,
};
pub use icy::{IcyMetadataInjector, ICY_METAINT};
pub use manager::{
    AudioCodec, PlaybackEpoch, StreamMetadata, StreamRegistry, StreamState, StreamTiming,
};
pub use wav::create_wav_header;

use std::collections::HashMap;
use std::sync::OnceLock;

use bytes::Bytes;
use parking_lot::RwLock;

use crate::protocol_constants::{DEFAULT_CHANNELS, DEFAULT_SAMPLE_RATE};

// ─────────────────────────────────────────────────────────────────────────────
// Crossfade Constants
// ─────────────────────────────────────────────────────────────────────────────

/// Duration of crossfade in milliseconds for silence transitions.
///
/// 2ms is short enough to be imperceptible but eliminates discontinuity pops
/// that occur when abruptly transitioning between audio and silence.
pub const CROSSFADE_MS: u32 = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Silence Frame Cache
// ─────────────────────────────────────────────────────────────────────────────

/// Global cache for silence frames to avoid repeated allocations.
///
/// Silence frames are keyed by their byte length since different audio formats
/// with the same duration may produce the same byte count. The cache is lazily
/// initialized and never cleared (silence frames are small and finite).
static SILENCE_CACHE: OnceLock<RwLock<HashMap<usize, Bytes>>> = OnceLock::new();

/// Gets a cached silence frame of the given byte length, or creates and caches one.
///
/// This avoids ~200KB/s of allocations during delivery gaps by reusing
/// pre-allocated silence buffers. The `Bytes::clone()` is O(1) (Arc bump).
fn get_or_create_silence(byte_len: usize) -> Bytes {
    let cache = SILENCE_CACHE.get_or_init(|| RwLock::new(HashMap::new()));

    // Fast path: check if already cached
    if let Some(silence) = cache.read().get(&byte_len) {
        return silence.clone();
    }

    // Slow path: create and cache
    let mut cache_write = cache.write();
    // Double-check after acquiring write lock (another thread may have inserted)
    if let Some(silence) = cache_write.get(&byte_len) {
        return silence.clone();
    }

    let silence = Bytes::from(vec![0u8; byte_len]);
    cache_write.insert(byte_len, silence.clone());
    silence
}

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

    /// Returns bytes per sample (e.g., 2 for 16-bit audio).
    #[inline]
    pub const fn bytes_per_sample(&self) -> usize {
        (self.bits_per_sample / 8) as usize
    }

    /// Returns the number of samples per channel for the given duration.
    #[inline]
    pub fn frame_samples(&self, duration_ms: u32) -> usize {
        ((self.sample_rate as u64 * duration_ms as u64) / 1000) as usize
    }

    /// Calculates the frame size in bytes for the given duration.
    ///
    /// Uses saturating arithmetic to prevent overflow with extreme values.
    #[inline]
    pub fn frame_bytes(&self, duration_ms: u32) -> usize {
        let samples_per_channel =
            (self.sample_rate as u64).saturating_mul(duration_ms as u64) / 1000;
        let bytes_per_sample = self.bytes_per_sample() as u64;

        samples_per_channel
            .saturating_mul(self.channels as u64)
            .saturating_mul(bytes_per_sample) as usize
    }

    /// Creates a silence frame of the specified duration.
    ///
    /// Returns a cached `Bytes` buffer filled with zeros (digital silence).
    /// Used to keep the HTTP stream alive during delivery gaps.
    ///
    /// Silence frames are cached globally by byte length to avoid repeated
    /// allocations (~200KB/s during delivery gaps). The returned `Bytes`
    /// clone is O(1) since it's just an Arc reference count bump.
    pub fn silence_frame(&self, duration_ms: u32) -> Bytes {
        get_or_create_silence(self.frame_bytes(duration_ms))
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

// ─────────────────────────────────────────────────────────────────────────────
// PCM Crossfade Utilities (16-bit only)
// ─────────────────────────────────────────────────────────────────────────────
//
// These utilities are designed for 16-bit signed PCM (the standard WAV format).
// They use `i16` sample representation and assume 2 bytes per sample.
//
// **Invariant**: PCM streams in this crate are always 16-bit. The handshake in
// `ws.rs` enforces this by downgrading 24-bit requests to 16-bit for non-FLAC
// codecs. 24-bit is only supported for FLAC, which doesn't use the cadence loop.

/// Bytes per sample for 16-bit PCM audio.
const PCM_16BIT_BYTES_PER_SAMPLE: usize = 2;

/// Required bit depth for crossfade utilities.
const CROSSFADE_REQUIRED_BITS: u16 = 16;

/// Returns true if the audio format is compatible with crossfade utilities.
///
/// Crossfade requires 16-bit PCM with mono or stereo (1-2 channels).
/// Multi-channel audio (>2) is not supported.
#[inline]
pub fn is_crossfade_compatible(audio_format: &AudioFormat) -> bool {
    audio_format.bits_per_sample == CROSSFADE_REQUIRED_BITS && audio_format.channels <= 2
}

/// Extracts the last stereo sample pair from a 16-bit PCM buffer.
///
/// Returns `None` if the buffer is too small to contain a complete stereo sample.
/// For mono audio, the same sample is returned for both channels.
///
/// # Note
/// This function is specific to 16-bit PCM audio.
#[inline]
pub fn extract_last_sample_pair(data: &[u8], channels: u16) -> Option<(i16, i16)> {
    let frame_bytes = PCM_16BIT_BYTES_PER_SAMPLE * channels as usize;

    if data.len() < frame_bytes {
        return None;
    }

    let offset = data.len() - frame_bytes;
    let left = i16::from_le_bytes([data[offset], data[offset + 1]]);
    let right = if channels >= 2 {
        i16::from_le_bytes([data[offset + 2], data[offset + 3]])
    } else {
        left // Mono: duplicate
    };

    Some((left, right))
}

/// Applies a linear fade-in to the beginning of a 16-bit PCM buffer.
///
/// Modifies the first `fade_samples` sample pairs in place, ramping
/// amplitude from 0 to 1.
///
/// # Note
/// This function is specific to 16-bit PCM audio.
pub fn apply_fade_in(data: &mut [u8], channels: u16, fade_samples: usize) {
    let frame_bytes = PCM_16BIT_BYTES_PER_SAMPLE * channels as usize;

    if fade_samples == 0 || frame_bytes == 0 {
        return;
    }

    // Cap fade to available samples (shorter fade is better than no fade)
    let available_samples = data.len() / frame_bytes;
    let effective_fade = fade_samples.min(available_samples);

    if effective_fade == 0 {
        return;
    }

    // Use (effective_fade - 1) as divisor to reach both endpoints (0.0 and 1.0).
    // Edge case: if effective_fade == 1, the single sample gets t = 0.0 (silence).
    let divisor = (effective_fade - 1).max(1) as f32;

    for i in 0..effective_fade {
        // Linear ramp from 0.0 to 1.0, reaching exactly 1.0 at the last sample
        let t = i as f32 / divisor;

        // Apply to each channel
        for ch in 0..channels as usize {
            let offset = i * frame_bytes + ch * PCM_16BIT_BYTES_PER_SAMPLE;
            let sample = i16::from_le_bytes([data[offset], data[offset + 1]]);
            let faded = (sample as f32 * t) as i16;
            let bytes = faded.to_le_bytes();
            data[offset] = bytes[0];
            data[offset + 1] = bytes[1];
        }
    }
}

/// Creates a fade-out frame from the given starting sample values to silence.
///
/// Generates a buffer that starts at `(left, right)` sample values and
/// linearly ramps down to zero over `fade_samples`, then remains silent.
/// Used when transitioning from audio to silence to prevent pops.
///
/// # Note
/// This function is specific to 16-bit PCM with mono or stereo (1-2 channels).
pub fn create_fade_out_frame(
    left: i16,
    right: i16,
    channels: u16,
    fade_samples: usize,
    total_samples: usize,
) -> Bytes {
    debug_assert!(
        channels <= 2,
        "create_fade_out_frame only supports mono/stereo, got {} channels",
        channels
    );

    let frame_bytes = PCM_16BIT_BYTES_PER_SAMPLE * channels as usize;
    let total_bytes = total_samples * frame_bytes;

    let mut data = vec![0u8; total_bytes];

    let effective_fade = fade_samples.min(total_samples);

    if effective_fade == 0 {
        return Bytes::from(data);
    }

    // Use (effective_fade - 1) as divisor to reach both endpoints (1.0 and 0.0).
    // Edge case: if effective_fade == 1, the single sample gets t = 1.0 (full amplitude).
    let divisor = (effective_fade - 1).max(1) as f32;

    for i in 0..effective_fade {
        // Linear ramp from 1.0 to 0.0, reaching exactly 0.0 at the last sample
        let t = 1.0 - (i as f32 / divisor);

        let faded_left = (left as f32 * t) as i16;
        let offset = i * frame_bytes;
        let left_bytes = faded_left.to_le_bytes();
        data[offset] = left_bytes[0];
        data[offset + 1] = left_bytes[1];

        if channels == 2 {
            let faded_right = (right as f32 * t) as i16;
            let right_bytes = faded_right.to_le_bytes();
            data[offset + 2] = right_bytes[0];
            data[offset + 3] = right_bytes[1];
        }
    }
    // Remaining samples after fade are already zero-initialized

    Bytes::from(data)
}

/// Calculates the number of samples for the crossfade duration at the given sample rate.
#[inline]
pub fn crossfade_samples(sample_rate: u32) -> usize {
    ((sample_rate as u64 * CROSSFADE_MS as u64) / 1000) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    mod audio_format {
        use super::*;

        #[test]
        fn bytes_per_sample_16bit() {
            let format = AudioFormat::new(48000, 2, 16);
            assert_eq!(format.bytes_per_sample(), 2);
        }

        #[test]
        fn bytes_per_sample_24bit() {
            let format = AudioFormat::new(48000, 2, 24);
            assert_eq!(format.bytes_per_sample(), 3);
        }

        #[test]
        fn frame_samples_at_48khz() {
            let format = AudioFormat::new(48000, 2, 16);
            // 20ms at 48kHz = 960 samples per channel
            assert_eq!(format.frame_samples(20), 960);
        }

        #[test]
        fn frame_samples_at_44100hz() {
            let format = AudioFormat::new(44100, 2, 16);
            // 20ms at 44.1kHz = 882 samples per channel
            assert_eq!(format.frame_samples(20), 882);
        }

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

    mod crossfade {
        use super::*;

        #[test]
        fn crossfade_samples_at_48khz() {
            // 2ms at 48kHz = 96 samples
            assert_eq!(crossfade_samples(48000), 96);
        }

        #[test]
        fn crossfade_samples_at_44100hz() {
            // 2ms at 44.1kHz = 88.2, truncated to 88 samples
            assert_eq!(crossfade_samples(44100), 88);
        }

        #[test]
        fn extract_last_sample_pair_stereo() {
            // Create a simple stereo buffer: left=1000, right=2000
            let left: i16 = 1000;
            let right: i16 = 2000;
            let mut data = vec![0u8; 8]; // 2 stereo sample pairs
                                         // Write first sample pair (zeros)
                                         // Write second sample pair at offset 4
            let left_bytes = left.to_le_bytes();
            let right_bytes = right.to_le_bytes();
            data[4] = left_bytes[0];
            data[5] = left_bytes[1];
            data[6] = right_bytes[0];
            data[7] = right_bytes[1];

            let result = extract_last_sample_pair(&data, 2);
            assert_eq!(result, Some((left, right)));
        }

        #[test]
        fn extract_last_sample_pair_mono() {
            let sample: i16 = 1234;
            let bytes = sample.to_le_bytes();
            let data = vec![0, 0, bytes[0], bytes[1]]; // 2 mono samples

            let result = extract_last_sample_pair(&data, 1);
            assert_eq!(result, Some((sample, sample))); // Mono duplicates
        }

        #[test]
        fn extract_last_sample_pair_too_small() {
            let data = vec![0u8; 2]; // Only 1 sample, need 2 for stereo
            assert_eq!(extract_last_sample_pair(&data, 2), None);
        }

        #[test]
        fn apply_fade_in_reaches_endpoints() {
            // Create stereo buffer with constant value
            let sample: i16 = 10000;
            let fade_samples = 4;
            let total_samples = 8;
            let mut data = vec![0u8; total_samples * 4]; // stereo * 2 bytes

            // Fill with constant sample value
            for i in 0..total_samples {
                let offset = i * 4;
                let bytes = sample.to_le_bytes();
                data[offset] = bytes[0];
                data[offset + 1] = bytes[1];
                data[offset + 2] = bytes[0];
                data[offset + 3] = bytes[1];
            }

            apply_fade_in(&mut data, 2, fade_samples);

            // First sample should be exactly 0 (t=0)
            let first_left = i16::from_le_bytes([data[0], data[1]]);
            assert_eq!(first_left, 0, "first sample should be 0");

            // Last faded sample should be at full value (t=1.0)
            // With divisor = fade_samples - 1 = 3, at i=3: t = 3/3 = 1.0
            let last_faded_offset = (fade_samples - 1) * 4;
            let last_faded_left =
                i16::from_le_bytes([data[last_faded_offset], data[last_faded_offset + 1]]);
            assert_eq!(
                last_faded_left, sample,
                "last faded sample should reach full value"
            );

            // Non-faded samples should be unchanged
            let after_fade_offset = fade_samples * 4;
            let after_fade_left =
                i16::from_le_bytes([data[after_fade_offset], data[after_fade_offset + 1]]);
            assert_eq!(
                after_fade_left, sample,
                "samples after fade should be unchanged"
            );
        }

        #[test]
        fn create_fade_out_frame_reaches_endpoints() {
            let left: i16 = 10000;
            let right: i16 = -5000;
            let fade_samples = 4;
            let total_samples = 10;

            let frame = create_fade_out_frame(left, right, 2, fade_samples, total_samples);

            // Check frame size
            assert_eq!(frame.len(), total_samples * 4);

            // First sample should be at full value (t=1.0)
            let first_left = i16::from_le_bytes([frame[0], frame[1]]);
            let first_right = i16::from_le_bytes([frame[2], frame[3]]);
            assert_eq!(first_left, left, "first sample should be at full value");
            assert_eq!(first_right, right, "first sample should be at full value");

            // Last faded sample should be exactly 0 (t=0.0)
            // With divisor = fade_samples - 1 = 3, at i=3: t = 1 - 3/3 = 0.0
            let last_faded_offset = (fade_samples - 1) * 4;
            let last_faded_left =
                i16::from_le_bytes([frame[last_faded_offset], frame[last_faded_offset + 1]]);
            let last_faded_right =
                i16::from_le_bytes([frame[last_faded_offset + 2], frame[last_faded_offset + 3]]);
            assert_eq!(last_faded_left, 0, "last faded sample should reach 0");
            assert_eq!(last_faded_right, 0, "last faded sample should reach 0");

            // Samples after fade should remain zero
            let after_fade_offset = fade_samples * 4;
            let after_fade_left =
                i16::from_le_bytes([frame[after_fade_offset], frame[after_fade_offset + 1]]);
            assert_eq!(after_fade_left, 0, "samples after fade should be zero");
        }

        #[test]
        fn create_fade_out_frame_mono() {
            let sample: i16 = 8000;
            let fade_samples = 2;
            let total_samples = 5;

            let frame = create_fade_out_frame(sample, sample, 1, fade_samples, total_samples);

            // Check frame size (mono = 2 bytes per sample)
            assert_eq!(frame.len(), total_samples * 2);

            // First sample should be at full value
            let first = i16::from_le_bytes([frame[0], frame[1]]);
            assert_eq!(first, sample);
        }
    }
}
