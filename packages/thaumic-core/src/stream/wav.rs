use bytes::{BufMut, Bytes, BytesMut};

use crate::protocol_constants::WAV_STREAM_SIZE_MAX;

/// Generates a standard 44-byte WAVE header for an infinite LPCM stream.
///
/// @param sample_rate - Typically 44100 or 48000.
/// @param channels - 1 (mono) or 2 (stereo).
/// @param bits_per_sample - Bit depth (16 or 24). Invalid values default to 16.
pub fn create_wav_header(sample_rate: u32, channels: u16, bits_per_sample: u16) -> Bytes {
    // Validate bits_per_sample - only 16 and 24 are valid for PCM WAV
    let bits_per_sample = match bits_per_sample {
        16 | 24 => bits_per_sample,
        other => {
            log::warn!("[WAV] Invalid bits_per_sample {}, defaulting to 16", other);
            16
        }
    };

    let mut header = BytesMut::with_capacity(44);

    // Safe division - bits_per_sample is now guaranteed to be 16 or 24
    let bytes_per_sample = bits_per_sample / 8;
    let byte_rate = sample_rate * channels as u32 * bytes_per_sample as u32;
    let block_align = channels * bytes_per_sample;

    // RIFF header
    header.put_slice(b"RIFF");
    header.put_u32_le(WAV_STREAM_SIZE_MAX); // File size (infinite stream)
    header.put_slice(b"WAVE");

    // fmt chunk
    header.put_slice(b"fmt ");
    header.put_u32_le(16); // Chunk size
    header.put_u16_le(1); // Audio format (PCM)
    header.put_u16_le(channels);
    header.put_u32_le(sample_rate);
    header.put_u32_le(byte_rate);
    header.put_u16_le(block_align);
    header.put_u16_le(bits_per_sample);

    // data chunk
    header.put_slice(b"data");
    header.put_u32_le(WAV_STREAM_SIZE_MAX); // Data size (infinite stream)

    header.freeze()
}
