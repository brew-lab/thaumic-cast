//! Core application state types.
//!
//! This module provides [`CoreState`] which holds all shared state for the
//! application, including configuration and runtime services. The desktop
//! app wraps this in its own state type that adds Tauri-specific state.

use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use crate::context::NetworkContext;

/// Core application state - Tauri-independent.
///
/// Contains service references and configuration that are shared across
/// the application. This struct is designed to be wrapped by platform-specific
/// state types (e.g., `DesktopState` for Tauri).
///
/// # Note
///
/// The `services` field is currently a placeholder. It will be populated
/// with `BootstrappedServices` in Phase 5 when the bootstrap function is created.
pub struct CoreState {
    /// Application configuration.
    pub config: Arc<RwLock<Config>>,
    /// Network context for URL building and IP detection.
    pub network_ctx: NetworkContext,
}

impl CoreState {
    /// Creates a new `CoreState` with the given configuration and network context.
    pub fn new(config: Config, network_ctx: NetworkContext) -> Self {
        Self {
            config: Arc::new(RwLock::new(config)),
            network_ctx,
        }
    }
}

/// Configuration for audio streaming behavior.
///
/// Groups related streaming parameters that control concurrency,
/// buffering, and channel capacity.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StreamingConfig {
    /// Maximum number of concurrent audio streams.
    pub max_concurrent_streams: usize,

    /// Maximum frames to buffer for late-joining clients.
    /// Extension sends 20ms frames, so 50 frames ≈ 1 second of audio.
    pub buffer_frames: usize,

    /// Capacity of the broadcast channel for audio frames.
    pub channel_capacity: usize,
}

impl StreamingConfig {
    /// Creates a new `StreamingConfig` with validated values.
    ///
    /// # Errors
    ///
    /// Returns an error if any value would cause runtime issues.
    pub fn new(
        max_concurrent_streams: usize,
        buffer_frames: usize,
        channel_capacity: usize,
    ) -> Result<Self, String> {
        let config = Self {
            max_concurrent_streams,
            buffer_frames,
            channel_capacity,
        };
        config.validate()?;
        Ok(config)
    }

    /// Validates the configuration values.
    pub fn validate(&self) -> Result<(), String> {
        if self.max_concurrent_streams == 0 {
            return Err("max_concurrent_streams must be >= 1".to_string());
        }
        if self.buffer_frames == 0 {
            return Err("buffer_frames must be >= 1".to_string());
        }
        if self.channel_capacity == 0 {
            return Err(
                "channel_capacity must be >= 1 (broadcast::channel panics on 0)".to_string(),
            );
        }
        Ok(())
    }
}

impl Default for StreamingConfig {
    fn default() -> Self {
        Self {
            max_concurrent_streams: 10,
            buffer_frames: 50,
            channel_capacity: 500,
        }
    }
}

/// Configuration for the Thaumic Cast application.
///
/// All fields have sensible defaults.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Config {
    // Server
    /// Preferred port for the HTTP/WS server (0 = auto-allocate).
    pub preferred_port: u16,

    // Discovery
    /// Interval for refreshing the Sonos topology (seconds).
    pub topology_refresh_interval: u64,

    /// Number of M-SEARCH packets to send during discovery.
    pub ssdp_send_count: u64,

    /// Delay between M-SEARCH packet retries (milliseconds).
    pub ssdp_retry_delay_ms: u64,

    /// Enable SSDP multicast discovery.
    pub discovery_ssdp_multicast: bool,

    /// Enable SSDP broadcast discovery.
    pub discovery_ssdp_broadcast: bool,

    /// Enable mDNS/Bonjour discovery.
    pub discovery_mdns: bool,

    /// mDNS browse timeout (milliseconds).
    pub mdns_browse_timeout_ms: u64,

    // Streaming
    /// Streaming configuration.
    #[serde(default)]
    pub streaming: StreamingConfig,

    // WebSocket
    /// WebSocket heartbeat timeout (seconds).
    pub ws_heartbeat_timeout_secs: u64,

    /// Interval between WebSocket heartbeat checks (seconds).
    pub ws_heartbeat_check_interval_secs: u64,

    /// Capacity of the event broadcast channel.
    pub event_channel_capacity: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            preferred_port: 0,
            topology_refresh_interval: 30,
            ssdp_send_count: 3,
            ssdp_retry_delay_ms: 800,
            discovery_ssdp_multicast: true,
            discovery_ssdp_broadcast: true,
            discovery_mdns: true,
            mdns_browse_timeout_ms: 2000,
            streaming: StreamingConfig::default(),
            ws_heartbeat_timeout_secs: 30,
            ws_heartbeat_check_interval_secs: 1,
            event_channel_capacity: 100,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streaming_config_default_is_valid() {
        let config = StreamingConfig::default();
        assert!(config.validate().is_ok());
    }

    #[test]
    fn streaming_config_rejects_zero_values() {
        assert!(StreamingConfig::new(0, 50, 100).is_err());
        assert!(StreamingConfig::new(10, 0, 100).is_err());
        assert!(StreamingConfig::new(10, 50, 0).is_err());
    }

    #[test]
    fn config_default_is_sensible() {
        let config = Config::default();
        assert_eq!(config.preferred_port, 0);
        assert!(config.discovery_ssdp_multicast);
        assert!(config.discovery_mdns);
    }
}
