//! Fixed protocol constants that should NOT be changed.
//!
//! These values are defined by external specifications (UPnP, GENA, audio standards)
//! and changing them would break protocol compliance.

// ─────────────────────────────────────────────────────────────────────────────
// GENA (UPnP General Event Notification Architecture)
// ─────────────────────────────────────────────────────────────────────────────

/// GENA subscription timeout requested from speaker (seconds).
///
/// 1 hour is a reasonable default per UPnP spec recommendations.
pub const GENA_SUBSCRIPTION_TIMEOUT_SECS: u64 = 3600;

/// Time before subscription expiry to trigger renewal (seconds).
///
/// 5 minutes provides comfortable buffer for network delays.
pub const GENA_RENEWAL_BUFFER_SECS: u64 = 300;

/// Interval between subscription renewal checks (seconds).
pub const GENA_RENEWAL_CHECK_SECS: u64 = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Audio Standards
// ─────────────────────────────────────────────────────────────────────────────

/// Default audio sample rate (Hz).
///
/// 48kHz is the standard for digital audio (DVD, Blu-ray, professional audio).
pub const DEFAULT_SAMPLE_RATE: u32 = 48000;

/// Default number of audio channels (stereo).
pub const DEFAULT_CHANNELS: u16 = 2;

/// Maximum size indicator for WAV streams (4,294,967,295 bytes / ~4.3 GB).
///
/// Used in WAV headers (RIFF file size, data chunk size) and HTTP Content-Length
/// to signal an "infinite" stream. This prevents chunked transfer encoding,
/// which some renderers (including Sonos) handle poorly for WAV.
pub const WAV_STREAM_SIZE_MAX: u32 = u32::MAX;

// ─────────────────────────────────────────────────────────────────────────────
// ICY Protocol (Shoutcast/Icecast metadata)
// ─────────────────────────────────────────────────────────────────────────────

/// ICY metadata interval (bytes between metadata blocks).
///
/// 8192 bytes is the interval we use for Sonos compatibility.
/// This is a protocol specification constant, not a tunable parameter.
pub const ICY_METAINT: usize = 8192;

// ─────────────────────────────────────────────────────────────────────────────
// HTTP/SOAP
// ─────────────────────────────────────────────────────────────────────────────

/// Timeout for SOAP HTTP requests (seconds).
///
/// 10 seconds is reasonable for LAN operations.
pub const SOAP_TIMEOUT_SECS: u64 = 10;

/// Maximum size of GENA notification body (bytes).
pub const MAX_GENA_BODY_SIZE: usize = 64 * 1024;
