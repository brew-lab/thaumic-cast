//! ICY (Shoutcast) protocol metadata handling.
//!
//! This module encapsulates ICY metadata formatting and injection,
//! keeping protocol-specific concerns separate from stream state management.

use bytes::Bytes;

use super::StreamMetadata;

/// ICY metadata interval (bytes between metadata blocks).
/// This is a protocol specification constant, not a tunable parameter.
pub const ICY_METAINT: usize = 8192;

/// Formats stream metadata into ICY protocol format.
///
/// This struct provides stateless metadata formatting according to the
/// ICY/Shoutcast protocol specification.
pub struct IcyFormatter;

impl IcyFormatter {
    /// Formats metadata into an ICY metadata block.
    ///
    /// Per ICY spec, a single zero byte indicates no metadata change.
    /// Otherwise, the first byte is the number of 16-byte blocks, followed
    /// by the metadata string padded to that length.
    ///
    /// # Arguments
    /// * `metadata` - The stream metadata to format
    ///
    /// # Returns
    /// A `Vec<u8>` containing the ICY-formatted metadata block.
    #[must_use]
    pub fn format_metadata(metadata: &StreamMetadata) -> Vec<u8> {
        let title = match (&metadata.artist, &metadata.title) {
            (Some(a), Some(t)) => format!("{} - {}", a, t),
            (None, Some(t)) => t.clone(),
            (Some(a), None) => a.clone(),
            (None, None) => return vec![0], // No metadata: single zero byte per ICY spec
        };

        // Empty string also gets the zero-byte treatment
        if title.is_empty() {
            return vec![0];
        }

        // ICY metadata uses single quotes as delimiters, so escape them
        let title = title.replace('\'', "\\'");
        let meta_str = format!("StreamTitle='{}';", title);
        let meta_bytes = meta_str.as_bytes();

        let num_blocks = (meta_bytes.len() + 15) / 16;
        let padded_len = num_blocks * 16;

        let mut result = Vec::with_capacity(padded_len + 1);
        result.push(num_blocks as u8);
        result.extend_from_slice(meta_bytes);
        result.resize(padded_len + 1, 0);

        result
    }
}

/// Stateful injector for ICY metadata blocks into audio streams.
///
/// Tracks byte position to insert metadata at the correct intervals.
/// Each instance should be used for a single stream session.
pub struct IcyMetadataInjector {
    bytes_since_meta: usize,
}

impl IcyMetadataInjector {
    /// Creates a new injector with byte counter at zero.
    #[must_use]
    pub fn new() -> Self {
        Self {
            bytes_since_meta: 0,
        }
    }

    /// Injects ICY metadata blocks into an audio chunk at the correct intervals.
    ///
    /// ICY protocol requires metadata blocks to be inserted every `ICY_METAINT` bytes.
    /// This method tracks the byte position and inserts formatted metadata when needed.
    ///
    /// # Arguments
    /// * `chunk` - The raw audio data chunk to process
    /// * `metadata` - Current stream metadata to embed
    ///
    /// # Returns
    /// A new `Bytes` buffer containing the audio data with ICY metadata blocks inserted.
    pub fn inject(&mut self, chunk: &[u8], metadata: &StreamMetadata) -> Bytes {
        let mut output = Vec::new();
        let mut remaining = chunk;

        while !remaining.is_empty() {
            let bytes_to_meta = ICY_METAINT - self.bytes_since_meta;

            if remaining.len() < bytes_to_meta {
                // Not enough bytes to reach next metadata point
                output.extend_from_slice(remaining);
                self.bytes_since_meta += remaining.len();
                break;
            }

            // Write bytes up to metadata point, then inject metadata block
            output.extend_from_slice(&remaining[..bytes_to_meta]);
            output.extend_from_slice(&IcyFormatter::format_metadata(metadata));
            remaining = &remaining[bytes_to_meta..];
            self.bytes_since_meta = 0;
        }

        Bytes::from(output)
    }

    /// Returns the current byte count since the last metadata block.
    #[must_use]
    pub fn bytes_since_meta(&self) -> usize {
        self.bytes_since_meta
    }
}

impl Default for IcyMetadataInjector {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_metadata_returns_zero_byte() {
        let metadata = StreamMetadata::default();
        let result = IcyFormatter::format_metadata(&metadata);
        assert_eq!(result, vec![0]);
    }

    #[test]
    fn title_only_formats_correctly() {
        let metadata = StreamMetadata {
            title: Some("Test Song".to_string()),
            artist: None,
            album: None,
            artwork: None,
        };
        let result = IcyFormatter::format_metadata(&metadata);
        assert_eq!(result[0], 2); // Two 16-byte blocks for "StreamTitle='Test Song';"
        assert_eq!(result.len(), 33); // 1 length byte + 32 data bytes
    }

    #[test]
    fn artist_and_title_formats_with_separator() {
        let metadata = StreamMetadata {
            title: Some("Song".to_string()),
            artist: Some("Artist".to_string()),
            album: None,
            artwork: None,
        };
        let result = IcyFormatter::format_metadata(&metadata);
        let content = String::from_utf8_lossy(&result[1..]);
        assert!(content.contains("Artist - Song"));
    }

    #[test]
    fn single_quotes_are_escaped() {
        let metadata = StreamMetadata {
            title: Some("It's a Test".to_string()),
            artist: None,
            album: None,
            artwork: None,
        };
        let result = IcyFormatter::format_metadata(&metadata);
        let content = String::from_utf8_lossy(&result[1..]);
        assert!(content.contains("It\\'s a Test"));
    }

    #[test]
    fn injector_tracks_byte_position() {
        let mut injector = IcyMetadataInjector::new();
        let metadata = StreamMetadata::default();

        // Inject a small chunk (less than ICY_METAINT)
        let chunk = vec![0u8; 1000];
        let result = injector.inject(&chunk, &metadata);

        // Should be same size (no metadata inserted yet)
        assert_eq!(result.len(), 1000);
        assert_eq!(injector.bytes_since_meta(), 1000);
    }

    #[test]
    fn injector_inserts_metadata_at_boundary() {
        let mut injector = IcyMetadataInjector::new();
        let metadata = StreamMetadata::default();

        // Inject exactly ICY_METAINT bytes
        let chunk = vec![0u8; ICY_METAINT];
        let result = injector.inject(&chunk, &metadata);

        // Should be ICY_METAINT + 1 (zero byte for empty metadata)
        assert_eq!(result.len(), ICY_METAINT + 1);
        assert_eq!(result[ICY_METAINT], 0); // Zero byte for empty metadata
        assert_eq!(injector.bytes_since_meta(), 0);
    }

    #[test]
    fn injector_handles_multiple_boundaries() {
        let mut injector = IcyMetadataInjector::new();
        let metadata = StreamMetadata::default();

        // Inject 2.5x ICY_METAINT bytes
        let chunk = vec![0u8; ICY_METAINT * 2 + ICY_METAINT / 2];
        let result = injector.inject(&chunk, &metadata);

        // Should have 2 metadata insertions (1 byte each for empty metadata)
        assert_eq!(result.len(), ICY_METAINT * 2 + ICY_METAINT / 2 + 2);
        assert_eq!(injector.bytes_since_meta(), ICY_METAINT / 2);
    }
}
