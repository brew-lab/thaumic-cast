//! ICY (Shoutcast) protocol metadata handling.
//!
//! This module encapsulates ICY metadata formatting and injection,
//! keeping protocol-specific concerns separate from stream state management.

use bytes::{Bytes, BytesMut};

use super::StreamMetadata;
pub use crate::protocol_constants::ICY_METAINT;

/// Size in bytes of the blocks an ICY metadata length byte counts.
const ICY_BLOCK_SIZE: usize = 16;

/// Most bytes one ICY metadata block can carry: the length byte is a `u8`
/// counting 16-byte blocks.
pub const ICY_MAX_METADATA_BYTES: usize = u8::MAX as usize * ICY_BLOCK_SIZE;

/// What precedes the title inside a metadata block.
const ICY_TITLE_PREFIX: &str = "StreamTitle='";

/// What follows the title inside a metadata block.
const ICY_TITLE_SUFFIX: &str = "';";

/// Most bytes of title that fit in one metadata block beside its wrapper.
const ICY_MAX_TITLE_BYTES: usize =
    ICY_MAX_METADATA_BYTES - ICY_TITLE_PREFIX.len() - ICY_TITLE_SUFFIX.len();

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
    /// A title too long for the 255 blocks the length byte can count is cut
    /// short on a character boundary, so the block never exceeds
    /// [`ICY_MAX_METADATA_BYTES`] and the length byte never wraps.
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
        let mut title = title.replace('\'', "\u{2019}");

        // The length byte counts 16-byte blocks, so a block holds 4080 bytes at
        // most. Cut here, after the replacement: each apostrophe grew from one
        // byte to three, so a title that fitted before it may not fit now.
        if title.len() > ICY_MAX_TITLE_BYTES {
            let mut end = ICY_MAX_TITLE_BYTES;
            while !title.is_char_boundary(end) {
                end -= 1;
            }
            log::debug!(
                "[ICY] StreamTitle of {} bytes cut to {} to fit one metadata block",
                title.len(),
                end
            );
            title.truncate(end);
        }

        let meta_str = format!("{ICY_TITLE_PREFIX}{title}{ICY_TITLE_SUFFIX}");
        let meta_bytes = meta_str.as_bytes();

        let num_blocks = meta_bytes.len().div_ceil(ICY_BLOCK_SIZE);
        let padded_len = num_blocks * ICY_BLOCK_SIZE;

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

    /// Splits a formatted block into its declared length and its text, checking
    /// the block is exactly as long as its length byte says.
    fn block_text(block: &[u8]) -> &str {
        let declared = block[0] as usize * 16;
        assert_eq!(
            block.len(),
            declared + 1,
            "the length byte must describe the whole block"
        );
        std::str::from_utf8(&block[1..])
            .expect("a cut title must still be UTF-8")
            .trim_end_matches('\0')
    }

    fn title_block(title: String) -> Vec<u8> {
        IcyFormatter::format_metadata(&StreamMetadata {
            title: Some(title),
            artist: None,
            source: None,
        })
    }

    #[test]
    fn the_longest_title_that_fits_is_sent_whole() {
        // 4,065 title bytes + the 15-byte wrapper = 4,080 = 255 blocks exactly.
        let block = title_block("a".repeat(4065));

        assert_eq!(block[0], 255);
        assert_eq!(
            block_text(&block),
            format!("StreamTitle='{}';", "a".repeat(4065))
        );
    }

    #[test]
    fn a_title_one_byte_too_long_is_cut_not_wrapped() {
        // 4,066 bytes would need 256 blocks, which a u8 writes as 0: "no
        // metadata", followed by 4,096 bytes the speaker would play as audio.
        let block = title_block("a".repeat(4066));

        assert_eq!(block[0], 255);
        assert_eq!(block.len(), ICY_MAX_METADATA_BYTES + 1);
        assert_eq!(
            block_text(&block),
            format!("StreamTitle='{}';", "a".repeat(4065))
        );
    }

    #[test]
    fn a_title_of_apostrophes_is_cut_after_they_are_replaced() {
        // 2,000 one-byte apostrophes become 6,000 bytes of U+2019. Cutting
        // before the replacement would let all of them through.
        let block = title_block("'".repeat(2000));

        assert_eq!(block[0], 255);
        assert_eq!(block.len(), ICY_MAX_METADATA_BYTES + 1);
        // 4,065 / 3 = 1,355 whole characters, with no partial one after them.
        assert_eq!(
            block_text(&block),
            format!("StreamTitle='{}';", "\u{2019}".repeat(1355))
        );
    }

    #[test]
    fn a_long_title_is_cut_on_a_character_boundary() {
        // Two ASCII bytes, then 4-byte characters: the 1,016th of them would
        // end at byte 4,066, one past the limit, and must go whole.
        let block = title_block(format!("ab{}", "\u{1F3B5}".repeat(2000)));

        // 2 + 4 * 1,015 = 4,062 is the last boundary at or under 4,065.
        assert_eq!(
            block_text(&block),
            format!("StreamTitle='ab{}';", "\u{1F3B5}".repeat(1015))
        );
        assert_eq!(block[0], 255);
    }

    #[test]
    fn an_artist_counts_towards_the_limit() {
        let block = IcyFormatter::format_metadata(&StreamMetadata {
            title: Some("t".repeat(4000)),
            artist: Some("a".repeat(4000)),
            source: None,
        });

        assert_eq!(block[0], 255);
        assert_eq!(block.len(), ICY_MAX_METADATA_BYTES + 1);
        assert!(block_text(&block).ends_with("';"));
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
