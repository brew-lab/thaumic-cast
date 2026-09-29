use bytes::{BufMut, Bytes, BytesMut};

use super::pcm_http::riff_size_for;
use crate::protocol_constants::WAV_STREAM_SIZE_MAX;

/// Generates a standard 44-byte WAVE header for an infinite LPCM stream.
///
/// @param sample_rate - Typically 44100 or 48000.
/// @param channels - 1 (mono) or 2 (stereo).
/// @param bits_per_sample - Bit depth (16 or 24). Invalid values default to 16.
pub fn create_wav_header(sample_rate: u32, channels: u16, bits_per_sample: u16) -> Bytes {
    create_wav_header_with_data_size(sample_rate, channels, bits_per_sample, WAV_STREAM_SIZE_MAX)
}

/// [`create_wav_header`] declaring `data_size` bytes of audio, with the RIFF
/// size to match (see [`riff_size_for`]). Only a field experiment sets
/// anything but [`WAV_STREAM_SIZE_MAX`] (see
/// [`crate::stream::PCM_WAV_DATA_SIZE_ENV`]).
pub fn create_wav_header_with_data_size(
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    data_size: u32,
) -> Bytes {
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
    header.put_u32_le(riff_size_for(data_size)); // File size (infinite stream by default)
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
    header.put_u32_le(data_size); // Data size (infinite stream by default)

    header.freeze()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u32_at(header: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes(header[offset..offset + 4].try_into().unwrap())
    }

    fn u16_at(header: &[u8], offset: usize) -> u16 {
        u16::from_le_bytes(header[offset..offset + 2].try_into().unwrap())
    }

    #[test]
    fn the_default_header_declares_the_largest_sizes() {
        let header = create_wav_header(48_000, 2, 16);
        assert_eq!(header.len(), 44);
        assert_eq!(&header[0..4], b"RIFF");
        assert_eq!(u32_at(&header, 4), 0xFFFF_FFFF);
        assert_eq!(&header[8..16], b"WAVEfmt ");
        assert_eq!(&header[36..40], b"data");
        assert_eq!(u32_at(&header, 40), 0xFFFF_FFFF);
    }

    #[test]
    fn byte_rate_and_block_align_follow_the_format() {
        for (rate, byte_rate) in [(48_000, 192_000), (44_100, 176_400)] {
            let header = create_wav_header(rate, 2, 16);
            assert_eq!(u16_at(&header, 22), 2, "channels");
            assert_eq!(u32_at(&header, 24), rate);
            assert_eq!(u32_at(&header, 28), byte_rate);
            assert_eq!(u16_at(&header, 32), 4, "block align");
            assert_eq!(u16_at(&header, 34), 16);
        }
    }

    #[test]
    fn a_data_size_sets_both_size_fields() {
        let header = create_wav_header_with_data_size(48_000, 2, 16, 10_485_760);
        assert_eq!(header.len(), 44);
        assert_eq!(u32_at(&header, 40), 10_485_760);
        assert_eq!(u32_at(&header, 4), 10_485_760 + 36);

        let empty = create_wav_header_with_data_size(48_000, 2, 16, 0);
        assert_eq!(u32_at(&empty, 40), 0);
        assert_eq!(u32_at(&empty, 4), 36);

        assert_eq!(
            create_wav_header_with_data_size(48_000, 2, 16, WAV_STREAM_SIZE_MAX),
            create_wav_header(48_000, 2, 16)
        );
    }
}
