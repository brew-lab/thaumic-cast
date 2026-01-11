use bytes::{BufMut, Bytes, BytesMut};

use crate::protocol_constants::WAV_STREAM_SIZE_MAX;

/// Generates a standard 44-byte WAVE header for an infinite LPCM stream.
///
/// @param sample_rate - Typically 44100 or 48000.
/// @param channels - 1 (mono) or 2 (stereo).
pub fn create_wav_header(sample_rate: u32, channels: u16) -> Bytes {
    let mut header = BytesMut::with_capacity(44);

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
    header.put_u32_le(sample_rate * channels as u32 * 2); // Byte rate
    header.put_u16_le(channels * 2); // Block align
    header.put_u16_le(16); // Bits per sample

    // data chunk
    header.put_slice(b"data");
    header.put_u32_le(WAV_STREAM_SIZE_MAX); // Data size (infinite stream)

    header.freeze()
}
