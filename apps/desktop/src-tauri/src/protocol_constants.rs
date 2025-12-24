//! Fixed protocol constants that should NOT be changed.
//!
//! These values are defined by external specifications (UPnP, GENA, audio standards)
//! and changing them would break protocol compliance.

// ─────────────────────────────────────────────────────────────────────────────
// SSDP / UPnP (RFC 2326, UPnP Device Architecture)
// ─────────────────────────────────────────────────────────────────────────────

/// MX value for SSDP M-SEARCH (max response delay in seconds).
///
/// Per UPnP Device Architecture 1.0, this controls how long devices
/// wait before responding to avoid network congestion.
pub const SSDP_MX_VALUE: u64 = 1;

/// Buffer time after last SSDP response before ending discovery (milliseconds).
pub const SSDP_BUFFER_MS: u64 = 500;

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

/// Timeout for fetching speaker description XML (seconds).
pub const HTTP_FETCH_TIMEOUT_SECS: u64 = 1;

/// Maximum size of GENA notification body (bytes).
pub const MAX_GENA_BODY_SIZE: usize = 64 * 1024;
