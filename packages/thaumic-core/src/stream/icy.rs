//! ICY (Shoutcast) protocol metadata handling.
//!
//! This module encapsulates ICY metadata formatting and injection,
//! keeping protocol-specific concerns separate from stream state management.

use bytes::{Bytes, BytesMut};

use super::StreamMetadata;
pub use crate::protocol_constants::ICY_METAINT;

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
            (None, None) => {
                log::debug!("[ICY] No title/artist in metadata, sending empty");
                return vec![0]; // No metadata: single zero byte per ICY spec
            }
        };

        log::trace!(
            "[ICY] StreamTitle='{}' (from artist={:?}, title={:?})",
            title,
            metadata.artist,
            metadata.title
        );

        // Empty string also gets the zero-byte treatment
        if title.is_empty() {
            return vec![0];
        }

        // ICY metadata uses single quotes as delimiters. Instead of backslash
        // escaping (which Sonos displays literally as "It\'s"), replace with
        // Unicode RIGHT SINGLE QUOTATION MARK (U+2019) which looks identical.
        let title = title.replace('\'', "\u{2019}");
        let meta_str = format!("StreamTitle='{}';", title);
        let meta_bytes = meta_str.as_bytes();

        let num_blocks = meta_bytes.len().div_ceil(16);
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
/// Caches formatted metadata to avoid repeated allocations when metadata
/// hasn't changed (which is the common case during playback).
///
/// Uses a reusable scratch buffer to minimize allocation pressure on
/// the hot audio path.
///
/// Each instance should be used for a single stream session.
pub struct IcyMetadataInjector {
    bytes_since_meta: usize,
    /// Cached formatted ICY metadata block (includes length byte + padded content).
    cached_metadata: Vec<u8>,
    /// Last artist value used to generate cached metadata (for cache invalidation).
    last_artist: Option<String>,
    /// Last title value used to generate cached metadata (for cache invalidation).
    last_title: Option<String>,
    /// Scratch buffer reused across inject() calls to reduce allocation pressure.
    /// Grows to accommodate typical chunk sizes and stabilizes after a few calls.
    output_buffer: BytesMut,
}

impl IcyMetadataInjector {
    /// Creates a new injector with byte counter at zero and empty metadata cache.
    #[must_use]
    pub fn new() -> Self {
        Self {
            bytes_since_meta: 0,
            cached_metadata: vec![0], // Default: empty metadata (single zero byte)
            last_artist: None,
            last_title: None,
            output_buffer: BytesMut::new(),
        }
    }

    /// Updates the cached metadata if artist or title has changed.
    ///
    /// Only artist and title are compared because ICY protocol's StreamTitle
    /// field only includes these values. Album, artwork, and source are used
    /// elsewhere (DIDL-Lite, WebSocket events) but not in ICY metadata blocks.
    ///
    /// Returns the byte length of the cached metadata for pre-allocation.
    fn update_metadata_cache(&mut self, metadata: &StreamMetadata) -> usize {
        if self.last_artist != metadata.artist || self.last_title != metadata.title {
            self.cached_metadata = IcyFormatter::format_metadata(metadata);
            self.last_artist = metadata.artist.clone();
            self.last_title = metadata.title.clone();
        }
        self.cached_metadata.len()
    }

    /// Injects ICY metadata blocks into an audio chunk at the correct intervals.
    ///
    /// ICY protocol requires metadata blocks to be inserted every `ICY_METAINT` bytes.
    /// This method tracks the byte position and inserts formatted metadata when needed.
    ///
    /// Uses a reusable scratch buffer that grows to accommodate typical chunk sizes,
    /// eliminating per-call allocations after the first few invocations.
    ///
    /// # Arguments
    /// * `chunk` - The raw audio data chunk to process
    /// * `metadata` - Current stream metadata to embed
    ///
    /// # Returns
    /// A new `Bytes` buffer containing the audio data with ICY metadata blocks inserted.
    pub fn inject(&mut self, chunk: &[u8], metadata: &StreamMetadata) -> Bytes {
        // Update cache if needed and get metadata size for capacity calculation
        let meta_len = self.update_metadata_cache(metadata);

        // Calculate number of metadata insertions for this chunk
        let total_bytes = self.bytes_since_meta + chunk.len();
        let num_insertions = total_bytes / ICY_METAINT;
        let required_capacity = chunk.len() + num_insertions * meta_len;

        // Reuse scratch buffer: reserve() only allocates if capacity is insufficient.
        // After a few chunks, the buffer stabilizes at typical size and stops growing.
        self.output_buffer.reserve(required_capacity);

        let mut remaining = chunk;

        while !remaining.is_empty() {
            let bytes_to_meta = ICY_METAINT - self.bytes_since_meta;

            if remaining.len() < bytes_to_meta {
                // Not enough bytes to reach next metadata point
                self.output_buffer.extend_from_slice(remaining);
                self.bytes_since_meta += remaining.len();
                break;
            }

            // Write bytes up to metadata point, then inject metadata block
            self.output_buffer
                .extend_from_slice(&remaining[..bytes_to_meta]);
            self.output_buffer.extend_from_slice(&self.cached_metadata);
            remaining = &remaining[bytes_to_meta..];
            self.bytes_since_meta = 0;
        }

        // Return content as Bytes. split() leaves buffer empty for next call.
        self.output_buffer.split().freeze()
    }

    /// Returns the current byte count since the last metadata block.
    #[must_use]
    #[allow(dead_code)] // Used in tests
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
            source: None,
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
            source: None,
        };
        let result = IcyFormatter::format_metadata(&metadata);
        let content = String::from_utf8_lossy(&result[1..]);
        assert!(content.contains("Artist - Song"));
    }

    #[test]
    fn single_quotes_are_replaced_with_unicode() {
        let metadata = StreamMetadata {
            title: Some("It's a Test".to_string()), // ASCII apostrophe U+0027
            artist: None,
            source: None,
        };
        let result = IcyFormatter::format_metadata(&metadata);
        let content = String::from_utf8_lossy(&result[1..]);
        // ASCII apostrophe (U+0027) should be replaced with Unicode RIGHT SINGLE QUOTATION MARK (U+2019)
        assert!(content.contains("It\u{2019}s a Test")); // Unicode apostrophe
        assert!(!content.contains("It\u{0027}s a Test")); // NOT ASCII apostrophe
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

    #[test]
    fn injector_caches_metadata_and_updates_on_change() {
        let mut injector = IcyMetadataInjector::new();

        let metadata1 = StreamMetadata {
            title: Some("Song A".to_string()),
            artist: Some("Artist".to_string()),
            source: None,
        };

        // First injection with metadata1
        let chunk = vec![0u8; ICY_METAINT];
        let result1 = injector.inject(&chunk, &metadata1);
        let meta_block_1: Vec<u8> = result1[ICY_METAINT..].to_vec();

        // Second injection with same metadata should produce identical metadata block
        let result2 = injector.inject(&chunk, &metadata1);
        let meta_block_2: Vec<u8> = result2[ICY_METAINT..].to_vec();
        assert_eq!(
            meta_block_1, meta_block_2,
            "Same metadata should produce same block"
        );

        // Change metadata
        let metadata2 = StreamMetadata {
            title: Some("Song B".to_string()),
            artist: Some("Artist".to_string()),
            source: None,
        };

        let result3 = injector.inject(&chunk, &metadata2);
        let meta_block_3: Vec<u8> = result3[ICY_METAINT..].to_vec();
        assert_ne!(
            meta_block_1, meta_block_3,
            "Different metadata should produce different block"
        );

        // Verify new metadata contains updated title
        let content = String::from_utf8_lossy(&meta_block_3[1..]);
        assert!(content.contains("Song B"));
    }
}
