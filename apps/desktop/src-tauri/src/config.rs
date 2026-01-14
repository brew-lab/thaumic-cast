//! Configuration constants and re-exports.
//!
//! This module provides backward-compatible access to configuration values.
//!
//! # Organization
//!
//! Configuration is split between two sources:
//!
//! - **`protocol_constants`**: Fixed protocol values (UPnP, GENA, audio standards)
//!   that should never change as they're defined by external specifications.
//!
//! - **`state::Config`**: Runtime-configurable tunables with sensible defaults.
//!   These can be adjusted based on hardware, network conditions, or preferences.
//!
//! # Migration
//!
//! New code should prefer:
//! - `crate::protocol_constants::*` for fixed protocol values
//! - `crate::state::Config` for runtime tunables
//!
//! The constants exported here are for backward compatibility and will
//! continue to work, but new code should use the sources above directly.

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports from protocol_constants (fixed values)
// ─────────────────────────────────────────────────────────────────────────────

pub use crate::protocol_constants::{
    GENA_RENEWAL_BUFFER_SECS, GENA_RENEWAL_CHECK_SECS, GENA_SUBSCRIPTION_TIMEOUT_SECS,
    MAX_GENA_BODY_SIZE, SOAP_TIMEOUT_SECS,
};

// ─────────────────────────────────────────────────────────────────────────────
// Backward-compatible defaults (match Config::default())
//
// These constants mirror the default values in state::Config.
// They exist for backward compatibility with code that imports from config.rs.
// ─────────────────────────────────────────────────────────────────────────────

/// Capacity of the event broadcast channel for WebSocket clients.
/// See [`Config::event_channel_capacity`](crate::state::Config::event_channel_capacity).
pub const EVENT_CHANNEL_CAPACITY: usize = 100;

/// Capacity of the internal GENA event channel (SubscriptionLost events).
/// Lower than other channels since these are rare failure-only events.
pub const GENA_EVENT_CHANNEL_CAPACITY: usize = 64;

/// WebSocket heartbeat timeout (seconds).
/// See [`Config::ws_heartbeat_timeout_secs`](crate::state::Config::ws_heartbeat_timeout_secs).
pub const WS_HEARTBEAT_TIMEOUT_SECS: u64 = 30;

/// Interval between WebSocket heartbeat checks (seconds).
/// See [`Config::ws_heartbeat_check_interval_secs`](crate::state::Config::ws_heartbeat_check_interval_secs).
pub const WS_HEARTBEAT_CHECK_INTERVAL_SECS: u64 = 1;

/// Delay before serving audio after Sonos connects (ms).
///
/// When Sonos connects, we wait this long before starting to serve audio.
/// This allows the ring buffer to accumulate frames, reducing sensitivity
/// to early-connection jitter. Similar to swyh-rs "initial buffering".
///
/// Set to 0 to disable (start serving immediately).
/// Higher values = more buffer headroom but increased startup latency.
pub const HTTP_PREFILL_DELAY_MS: u64 = 250;

/// Duration of injected silence frames (ms).
///
/// Matches our standard frame duration from the extension (20ms).
/// This is the atomic unit of silence injected when a timeout occurs.
pub const SILENCE_FRAME_DURATION_MS: u32 = 20;

/// Minimum streaming buffer size (ms).
///
/// Lower bound for user-configurable streaming buffer. Values below this
/// provide insufficient jitter absorption for reliable playback.
pub const MIN_STREAMING_BUFFER_MS: u64 = 100;

/// Maximum streaming buffer size (ms).
///
/// Upper bound for user-configurable streaming buffer. Higher values add
/// latency without meaningful benefit for typical network conditions.
pub const MAX_STREAMING_BUFFER_MS: u64 = 1000;

/// Default streaming buffer size (ms).
///
/// Balances latency (~200ms) with jitter absorption. Suitable for most
/// home network conditions.
pub const DEFAULT_STREAMING_BUFFER_MS: u64 = 200;

/// Maximum cadence queue size (frames).
///
/// Derived from `MAX_STREAMING_BUFFER_MS / SILENCE_FRAME_DURATION_MS`.
/// At 20ms/frame, 1000ms buffer = 50 frames max.
pub const MAX_CADENCE_QUEUE_SIZE: usize =
    (MAX_STREAMING_BUFFER_MS / SILENCE_FRAME_DURATION_MS as u64) as usize;
