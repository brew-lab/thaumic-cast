//! Artwork configuration and resolution.
//!
//! This module handles artwork source resolution for Sonos album art display.
//! It supports multiple sources with a defined precedence chain:
//!
//! 1. **Hosted URL** (`artwork_url`): External HTTPS URL, ideal for Android compatibility
//! 2. **Local file** (`data_dir/artwork.jpg`): User-provided file in the data directory
//! 3. **Embedded default**: Compile-time embedded artwork as fallback
//!
//! # Example
//!
//! ```ignore
//! use thaumic_core::{ArtworkConfig, ArtworkSource};
//!
//! let config = ArtworkConfig {
//!     url: Some("https://cdn.example.com/artwork.jpg".to_string()),
//!     data_dir: None,
//! };
//!
//! let source = config.resolve();
//! // Returns ArtworkSource::Url("https://cdn.example.com/artwork.jpg")
//! ```

use std::path::PathBuf;

use bytes::Bytes;

use crate::DEFAULT_ARTWORK;

/// The resolved artwork source for Sonos album art display.
///
/// This enum represents the final resolved artwork after applying the
/// precedence chain. It's used by the HTTP server and Sonos metadata builder.
#[derive(Debug, Clone)]
pub enum ArtworkSource {
    /// An external URL (typically HTTPS) to hosted artwork.
    ///
    /// When this variant is active, the URL is passed directly to Sonos
    /// in the DIDL-Lite metadata, bypassing the local `/artwork.jpg` endpoint.
    /// This is the preferred option for Android Sonos app compatibility.
    Url(String),

    /// Raw image bytes to be served at `/artwork.jpg`.
    ///
    /// This can be either user-provided (from `data_dir/artwork.jpg`)
    /// or the embedded default artwork.
    Bytes(Bytes),
}

impl ArtworkSource {
    /// Returns the artwork URL to use in Sonos DIDL-Lite metadata.
    ///
    /// - For `Url` variant: returns the external URL directly
    /// - For `Bytes` variant: returns the local server URL
    ///
    /// # Arguments
    ///
    /// * `local_artwork_url` - The local server's `/artwork.jpg` URL
    #[must_use]
    pub fn metadata_url(&self, local_artwork_url: &str) -> String {
        match self {
            ArtworkSource::Url(url) => url.clone(),
            ArtworkSource::Bytes(_) => local_artwork_url.to_string(),
        }
    }

    /// Returns the bytes if this is a `Bytes` variant, `None` for `Url`.
    ///
    /// Used by the `/artwork.jpg` HTTP handler.
    #[must_use]
    pub fn as_bytes(&self) -> Option<&Bytes> {
        match self {
            ArtworkSource::Bytes(bytes) => Some(bytes),
            ArtworkSource::Url(_) => None,
        }
    }
}

impl Default for ArtworkSource {
    /// Returns the embedded default artwork.
    fn default() -> Self {
        ArtworkSource::Bytes(Bytes::from_static(DEFAULT_ARTWORK))
    }
}

/// Configuration for artwork resolution.
///
/// Apps pass raw configuration values; core handles the resolution logic.
/// This keeps the precedence chain in one place and apps as dumb data pipelines.
#[derive(Debug, Clone, Default)]
pub struct ArtworkConfig {
    /// External URL to hosted artwork (highest precedence).
    ///
    /// If set, this URL is passed directly to Sonos, bypassing local serving.
    /// Should be HTTPS for Android Sonos app compatibility.
    pub url: Option<String>,

    /// Directory to check for `artwork.jpg` file.
    ///
    /// If `url` is not set and `data_dir/artwork.jpg` exists, it will be loaded.
    pub data_dir: Option<PathBuf>,
}

impl ArtworkConfig {
    /// Creates a new `ArtworkConfig` with the given values.
    #[must_use]
    pub fn new(url: Option<String>, data_dir: Option<PathBuf>) -> Self {
        Self { url, data_dir }
    }

    /// Resolves the artwork source using the precedence chain.
    ///
    /// Precedence:
    /// 1. `url` (hosted) → `ArtworkSource::Url`
    /// 2. `data_dir/artwork.jpg` (local file) → `ArtworkSource::Bytes`
    /// 3. Embedded `DEFAULT_ARTWORK` → `ArtworkSource::Bytes`
    ///
    /// Logs warnings for invalid configurations (e.g., unreadable files).
    #[must_use]
    pub fn resolve(&self) -> ArtworkSource {
        // 1. Check for external URL (highest precedence)
        if let Some(url) = &self.url {
            if !url.is_empty() {
                log::info!("[Artwork] Using external URL: {}", url);
                return ArtworkSource::Url(url.clone());
            }
        }

        // 2. Check for local file in data_dir (single read, no exists() check)
        if let Some(data_dir) = &self.data_dir {
            let artwork_path = data_dir.join("artwork.jpg");
            match std::fs::read(&artwork_path) {
                Ok(bytes) => {
                    log::info!(
                        "[Artwork] Using local file: {} ({} bytes)",
                        artwork_path.display(),
                        bytes.len()
                    );
                    return ArtworkSource::Bytes(Bytes::from(bytes));
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    // File doesn't exist - fall through to default
                }
                Err(e) => {
                    log::warn!(
                        "[Artwork] Failed to read {}: {}, falling back to default",
                        artwork_path.display(),
                        e
                    );
                }
            }
        }

        // 3. Fall back to embedded default
        log::info!("[Artwork] Using embedded default artwork");
        ArtworkSource::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    #[test]
    fn default_artwork_source_uses_embedded() {
        let source = ArtworkSource::default();
        assert!(matches!(source, ArtworkSource::Bytes(_)));
        assert!(source.as_bytes().is_some());
    }

    #[test]
    fn metadata_url_returns_external_for_url_variant() {
        let source = ArtworkSource::Url("https://example.com/art.jpg".to_string());
        assert_eq!(
            source.metadata_url("http://192.168.1.1:49400/artwork.jpg"),
            "https://example.com/art.jpg"
        );
    }

    #[test]
    fn metadata_url_returns_local_for_bytes_variant() {
        let source = ArtworkSource::Bytes(Bytes::from_static(b"test"));
        assert_eq!(
            source.metadata_url("http://192.168.1.1:49400/artwork.jpg"),
            "http://192.168.1.1:49400/artwork.jpg"
        );
    }

    #[test]
    fn resolve_prefers_url_over_file() {
        let temp_dir = TempDir::new().unwrap();
        let artwork_path = temp_dir.path().join("artwork.jpg");
        std::fs::write(&artwork_path, b"local file").unwrap();

        let config = ArtworkConfig {
            url: Some("https://example.com/art.jpg".to_string()),
            data_dir: Some(temp_dir.path().to_path_buf()),
        };

        let source = config.resolve();
        assert!(matches!(source, ArtworkSource::Url(url) if url == "https://example.com/art.jpg"));
    }

    #[test]
    fn resolve_uses_local_file_when_no_url() {
        let temp_dir = TempDir::new().unwrap();
        let artwork_path = temp_dir.path().join("artwork.jpg");
        let mut file = std::fs::File::create(&artwork_path).unwrap();
        file.write_all(b"local artwork data").unwrap();

        let config = ArtworkConfig {
            url: None,
            data_dir: Some(temp_dir.path().to_path_buf()),
        };

        let source = config.resolve();
        match source {
            ArtworkSource::Bytes(bytes) => {
                assert_eq!(bytes.as_ref(), b"local artwork data");
            }
            _ => panic!("Expected Bytes variant"),
        }
    }

    #[test]
    fn resolve_falls_back_to_default() {
        let config = ArtworkConfig {
            url: None,
            data_dir: None,
        };

        let source = config.resolve();
        assert!(matches!(source, ArtworkSource::Bytes(_)));
        // Should be the embedded default
        assert_eq!(source.as_bytes().unwrap().len(), DEFAULT_ARTWORK.len());
    }

    #[test]
    fn resolve_ignores_empty_url() {
        let config = ArtworkConfig {
            url: Some(String::new()),
            data_dir: None,
        };

        let source = config.resolve();
        // Should fall through to default, not use empty URL
        assert!(matches!(source, ArtworkSource::Bytes(_)));
    }
}
