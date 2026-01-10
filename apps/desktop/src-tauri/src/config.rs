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
    DEFAULT_CHANNELS, DEFAULT_SAMPLE_RATE, GENA_RENEWAL_BUFFER_SECS, GENA_RENEWAL_CHECK_SECS,
    GENA_SUBSCRIPTION_TIMEOUT_SECS, MAX_GENA_BODY_SIZE, SOAP_TIMEOUT_SECS,
};

// ─────────────────────────────────────────────────────────────────────────────
// Backward-compatible defaults (match Config::default())
//
// These constants mirror the default values in state::Config.
// They exist for backward compatibility with code that imports from config.rs.
// ─────────────────────────────────────────────────────────────────────────────

/// Maximum number of concurrent audio streams.
/// See [`Config::max_concurrent_streams`](crate::state::Config::max_concurrent_streams).
pub const MAX_CONCURRENT_STREAMS: usize = 10;

/// Capacity of the broadcast channel for audio frames.
/// See [`Config::stream_channel_capacity`](crate::state::Config::stream_channel_capacity).
pub const STREAM_CHANNEL_CAPACITY: usize = 100;

/// Maximum number of frames to buffer for late-joining clients.
/// See [`Config::stream_buffer_frames`](crate::state::Config::stream_buffer_frames).
pub const STREAM_BUFFER_FRAMES: usize = 50;

/// Capacity of the event broadcast channel for WebSocket clients.
/// See [`Config::event_channel_capacity`](crate::state::Config::event_channel_capacity).
pub const EVENT_CHANNEL_CAPACITY: usize = 100;

/// Capacity of the internal GENA event channel (SubscriptionLost events).
/// Lower than other channels since these are rare failure-only events.
pub const GENA_EVENT_CHANNEL_CAPACITY: usize = 64;

/// WebSocket heartbeat timeout (seconds).
/// See [`Config::ws_heartbeat_timeout_secs`](crate::state::Config::ws_heartbeat_timeout_secs).
pub const WS_HEARTBEAT_TIMEOUT_SECS: u64 = 10;

/// Interval between WebSocket heartbeat checks (seconds).
/// See [`Config::ws_heartbeat_check_interval_secs`](crate::state::Config::ws_heartbeat_check_interval_secs).
pub const WS_HEARTBEAT_CHECK_INTERVAL_SECS: u64 = 1;
