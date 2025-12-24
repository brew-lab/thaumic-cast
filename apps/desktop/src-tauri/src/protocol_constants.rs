//! Fixed protocol constants that should NOT be changed.
//!
//! These values are defined by external specifications (UPnP, GENA, audio standards)
//! and changing them would break protocol compliance.

use std::time::Duration;

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
/// 16384 is the de facto standard used by Shoutcast.
pub const ICY_METAINT: usize = 16384;

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

// ─────────────────────────────────────────────────────────────────────────────
// Derived Constants
// ─────────────────────────────────────────────────────────────────────────────

/// Computes the total discovery timeout based on retry timing.
///
/// This is a function rather than a constant because it depends on runtime
/// configuration values (ssdp_send_count, ssdp_retry_delay_ms).
pub fn compute_discovery_timeout(send_count: u64, retry_delay_ms: u64) -> Duration {
    Duration::from_millis(send_count * retry_delay_ms + SSDP_MX_VALUE * 1000 + SSDP_BUFFER_MS)
}
