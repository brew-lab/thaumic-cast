use std::hash::Hash;

use dashmap::DashMap;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::types::{TransportState, ZoneGroup};

/// Configuration for the Thaumic Cast Desktop application.
///
/// All fields have sensible defaults. These values can be tuned based on:
/// - Hardware capabilities (`max_concurrent_streams`)
/// - Network conditions (`ws_heartbeat_timeout_secs`, `ssdp_send_count`)
/// - Latency vs memory tradeoffs (`stream_buffer_frames`)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Config {
    // ─────────────────────────────────────────────────────────────────────────
    // Server
    // ─────────────────────────────────────────────────────────────────────────
    /// Preferred port for the HTTP/WS server (0 = auto-allocate).
    pub preferred_port: u16,

    // ─────────────────────────────────────────────────────────────────────────
    // Discovery
    // ─────────────────────────────────────────────────────────────────────────
    /// Interval for refreshing the Sonos topology (seconds).
    pub topology_refresh_interval: u64,

    /// Number of M-SEARCH packets to send during discovery.
    /// Higher values improve reliability on lossy networks.
    pub ssdp_send_count: u64,

    /// Delay between M-SEARCH packet retries (milliseconds).
    pub ssdp_retry_delay_ms: u64,

    // ─────────────────────────────────────────────────────────────────────────
    // Streaming
    // ─────────────────────────────────────────────────────────────────────────
    /// Maximum number of concurrent audio streams.
    /// Increase for powerful hardware, decrease for resource-constrained systems.
    pub max_concurrent_streams: usize,

    /// Maximum frames to buffer for late-joining clients.
    /// Higher values = more memory, better catchup for slow clients.
    /// At 48kHz stereo with ~100ms frames, 50 frames = ~5 seconds.
    pub stream_buffer_frames: usize,

    /// Capacity of the broadcast channel for audio frames.
    pub stream_channel_capacity: usize,

    // ─────────────────────────────────────────────────────────────────────────
    // WebSocket
    // ─────────────────────────────────────────────────────────────────────────
    /// WebSocket heartbeat timeout (seconds).
    /// Connection dropped if no activity within this period.
    pub ws_heartbeat_timeout_secs: u64,

    /// Interval between WebSocket heartbeat checks (seconds).
    pub ws_heartbeat_check_interval_secs: u64,

    /// Capacity of the event broadcast channel.
    pub event_channel_capacity: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            // Server
            preferred_port: 0,

            // Discovery
            topology_refresh_interval: 30,
            ssdp_send_count: 3,
            ssdp_retry_delay_ms: 800,

            // Streaming
            max_concurrent_streams: 10,
            stream_buffer_frames: 50,
            stream_channel_capacity: 100,

            // WebSocket
            ws_heartbeat_timeout_secs: 10,
            ws_heartbeat_check_interval_secs: 1,
            event_channel_capacity: 100,
        }
    }
}

/// Runtime state for discovered Sonos groups and their statuses.
///
/// # Concurrency design
///
/// - `groups` uses `RwLock<Vec<_>>` because it's replaced atomically during
///   topology refreshes and always read as a whole collection.
/// - Other fields use `DashMap` for fine-grained concurrent access by coordinator IP,
///   supporting frequent per-group GENA event updates without blocking readers.
#[derive(Debug, Default)]
pub struct SonosState {
    /// Current zone groups in the system.
    ///
    /// Updated atomically during topology discovery; read as a complete list.
    pub groups: RwLock<Vec<ZoneGroup>>,
    /// Map of coordinator IP to their current transport state (from GENA).
    pub transport_states: DashMap<String, TransportState>,
    /// Map of coordinator IP to their current group volume level (0-100).
    pub group_volumes: DashMap<String, u8>,
    /// Map of coordinator IP to their group mute status.
    pub group_mutes: DashMap<String, bool>,
}

impl SonosState {
    /// Serializes the current state to JSON.
    ///
    /// Returns a JSON object containing groups, transport states, volumes, and mute states.
    pub fn to_json(&self) -> serde_json::Value {
        json!({
            "groups": *self.groups.read(),
            "transportStates": dashmap_to_json(&self.transport_states),
            "groupVolumes": dashmap_to_json(&self.group_volumes),
            "groupMutes": dashmap_to_json(&self.group_mutes),
        })
    }

    /// Removes stale entries from state maps based on current topology.
    ///
    /// Called after topology changes to garbage-collect orphaned entries for
    /// speakers that are no longer coordinators or have disappeared.
    ///
    /// # Arguments
    /// * `valid_coordinator_ips` - Set of IPs that are currently group coordinators
    /// * `valid_speaker_ips` - Set of IPs for all currently discovered speakers
    pub fn cleanup_stale_entries(
        &self,
        valid_coordinator_ips: &std::collections::HashSet<String>,
        valid_speaker_ips: &std::collections::HashSet<String>,
    ) {
        // Transport states are per-speaker (any speaker can report transport state)
        self.transport_states
            .retain(|ip, _| valid_speaker_ips.contains(ip));

        // Volume and mute are per-coordinator (only coordinators control group volume)
        self.group_volumes
            .retain(|ip, _| valid_coordinator_ips.contains(ip));
        self.group_mutes
            .retain(|ip, _| valid_coordinator_ips.contains(ip));
    }
}

/// Converts a DashMap to a JSON object map.
fn dashmap_to_json<K, V>(map: &DashMap<K, V>) -> serde_json::Map<String, serde_json::Value>
where
    K: Eq + Hash + Clone + ToString,
    V: Clone + Serialize,
{
    map.iter()
        .map(|r| (r.key().to_string(), json!(r.value().clone())))
        .collect()
}
