//! Core application state types.
//!
//! Provides configuration ([`Config`], [`StreamingConfig`]), Sonos runtime
//! state ([`SonosState`]), and manual speaker persistence ([`ManualSpeakerConfig`]).

use std::collections::HashSet;
use std::hash::Hash;
use std::sync::OnceLock;

use dashmap::DashMap;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::sonos::types::{TransportState, ZoneGroup};

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

// ─────────────────────────────────────────────────────────────────────────────
// Sonos Runtime State
// ─────────────────────────────────────────────────────────────────────────────

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
    /// Map of coordinator IP to their fixed volume status.
    /// True indicates volume cannot be adjusted (line-level output).
    pub group_volume_fixed: DashMap<String, bool>,
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
            "groupVolumeFixed": dashmap_to_json(&self.group_volume_fixed),
        })
    }

    /// Removes stale entries from state maps based on current topology.
    ///
    /// Called after topology changes to garbage-collect orphaned entries for
    /// speakers that have disappeared from the network entirely.
    ///
    /// # Arguments
    /// * `valid_speaker_ips` - Set of IPs for all currently discovered speakers
    pub fn cleanup_stale_entries(&self, valid_speaker_ips: &HashSet<String>) {
        self.transport_states
            .retain(|ip, _| valid_speaker_ips.contains(ip));

        // Retain volume/mute data for any speaker still in the topology, not just
        // coordinators. During sync sessions, RenderingControl events populate
        // per-speaker entries for slaves. If we only kept coordinator entries,
        // periodic topology refreshes would discard slave volume data, creating a
        // gap when the sync session tears down (RC unsubscribed, GRC not yet
        // re-subscribed) that causes the UI to fall back to default values.
        self.group_volumes
            .retain(|ip, _| valid_speaker_ips.contains(ip));
        self.group_mutes
            .retain(|ip, _| valid_speaker_ips.contains(ip));
        self.group_volume_fixed
            .retain(|ip, _| valid_speaker_ips.contains(ip));
    }

    /// Looks up a coordinator's UUID by their IP address.
    ///
    /// Returns the RINCON_xxx UUID if found, None if no matching coordinator.
    #[must_use]
    pub fn get_coordinator_uuid_by_ip(&self, ip: &str) -> Option<String> {
        self.groups
            .read()
            .iter()
            .find(|g| g.coordinator_ip == ip)
            .map(|g| g.coordinator_uuid.clone())
    }

    /// Looks up any speaker's UUID by their IP address.
    ///
    /// Searches all members across all groups, not just coordinators.
    /// Returns the RINCON_xxx UUID if found, None if no matching member.
    #[must_use]
    pub fn get_member_uuid_by_ip(&self, ip: &str) -> Option<String> {
        self.groups
            .read()
            .iter()
            .flat_map(|g| g.members.iter())
            .find(|m| m.ip == ip)
            .map(|m| m.uuid.clone())
    }

    /// Returns the coordinator UUID if the speaker is a slave in an existing group.
    ///
    /// This is used to capture original group membership before joining a streaming group,
    /// allowing restoration after streaming ends.
    ///
    /// Returns:
    /// - `Some(coordinator_uuid)` if the speaker is a slave in an existing group
    /// - `None` if the speaker is already a coordinator or not found in any group
    #[must_use]
    pub fn get_original_coordinator_for_slave(&self, speaker_ip: &str) -> Option<String> {
        let groups = self.groups.read();
        for group in groups.iter() {
            if group.members.iter().any(|m| m.ip == speaker_ip) {
                if group.coordinator_ip == speaker_ip {
                    // Speaker is already a coordinator - no restoration needed
                    return None;
                }
                // Speaker is a slave in this group - return the original coordinator
                return Some(group.coordinator_uuid.clone());
            }
        }
        None
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

// ─────────────────────────────────────────────────────────────────────────────
// Manual Speaker Configuration (persisted)
// ─────────────────────────────────────────────────────────────────────────────

const MANUAL_SPEAKERS_FILE: &str = "manual_speakers.json";

/// Global mutex to serialize all manual speaker config file operations.
/// Prevents race conditions from concurrent add/remove operations.
static CONFIG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn config_lock() -> &'static Mutex<()> {
    CONFIG_LOCK.get_or_init(|| Mutex::new(()))
}

/// Persisted configuration for manually added speakers.
///
/// Used when auto-discovery fails due to network configuration (VPN, firewall, etc.).
/// These IPs are probed alongside auto-discovered speakers during topology refresh.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ManualSpeakerConfig {
    /// Manually configured speaker IP addresses.
    pub speaker_ips: Vec<String>,
}

impl ManualSpeakerConfig {
    /// Loads manual speaker configuration from the app data directory.
    ///
    /// Returns default (empty) config if file doesn't exist or is invalid.
    pub fn load(app_data_dir: &std::path::Path) -> Self {
        let path = app_data_dir.join(MANUAL_SPEAKERS_FILE);
        match std::fs::read_to_string(&path) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    /// Saves manual speaker configuration to the app data directory.
    ///
    /// Uses atomic write (temp file + rename) to prevent corruption on crash.
    /// Creates the directory if it doesn't exist.
    pub fn save(&self, app_data_dir: &std::path::Path) -> std::io::Result<()> {
        std::fs::create_dir_all(app_data_dir)?;
        let path = app_data_dir.join(MANUAL_SPEAKERS_FILE);
        let temp_path = app_data_dir.join("manual_speakers.json.tmp");
        let contents = serde_json::to_string_pretty(self)?;

        // Write to temp file first
        std::fs::write(&temp_path, contents)?;
        // Atomic rename (on most filesystems)
        std::fs::rename(&temp_path, &path)
    }

    /// Adds an IP address if not already present.
    ///
    /// Returns true if the IP was added, false if already present.
    fn add_ip(&mut self, ip: String) -> bool {
        if self.speaker_ips.contains(&ip) {
            false
        } else {
            self.speaker_ips.push(ip);
            true
        }
    }

    /// Removes an IP address if present.
    ///
    /// Returns true if the IP was removed, false if not found.
    fn remove_ip(&mut self, ip: &str) -> bool {
        let len_before = self.speaker_ips.len();
        self.speaker_ips.retain(|i| i != ip);
        self.speaker_ips.len() < len_before
    }

    /// Atomically adds an IP address to the config file.
    ///
    /// Acquires a lock, loads the config, adds the IP (if not present), and saves.
    /// Idempotent - adding an existing IP is a no-op (skips disk write).
    pub fn add_ip_atomic(app_data_dir: &std::path::Path, ip: String) -> std::io::Result<()> {
        let _guard = config_lock().lock();
        let mut config = Self::load(app_data_dir);
        if config.add_ip(ip) {
            config.save(app_data_dir)?;
        }
        Ok(())
    }

    /// Atomically removes an IP address from the config file.
    ///
    /// Acquires a lock, loads the config, removes the IP (if present), and saves.
    /// Idempotent - removing a non-existent IP is a no-op (skips disk write).
    pub fn remove_ip_atomic(app_data_dir: &std::path::Path, ip: &str) -> std::io::Result<()> {
        let _guard = config_lock().lock();
        let mut config = Self::load(app_data_dir);
        if config.remove_ip(ip) {
            config.save(app_data_dir)?;
        }
        Ok(())
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

    #[test]
    fn get_original_coordinator_returns_uuid_for_slave() {
        use crate::sonos::types::{ZoneGroup, ZoneGroupMember};

        let state = SonosState::default();
        {
            let mut groups = state.groups.write();
            *groups = vec![ZoneGroup {
                id: "group1".to_string(),
                name: "Living Room".to_string(),
                coordinator_uuid: "RINCON_LIVING".to_string(),
                coordinator_ip: "192.168.1.100".to_string(),
                members: vec![
                    ZoneGroupMember {
                        uuid: "RINCON_LIVING".to_string(),
                        ip: "192.168.1.100".to_string(),
                        zone_name: "Living Room".to_string(),
                        model: "One".to_string(),
                    },
                    ZoneGroupMember {
                        uuid: "RINCON_KITCHEN".to_string(),
                        ip: "192.168.1.101".to_string(),
                        zone_name: "Kitchen".to_string(),
                        model: "One".to_string(),
                    },
                ],
            }];
        }

        // Kitchen is a slave - should return Living Room's UUID
        assert_eq!(
            state.get_original_coordinator_for_slave("192.168.1.101"),
            Some("RINCON_LIVING".to_string())
        );
    }

    #[test]
    fn get_original_coordinator_returns_none_for_coordinator() {
        use crate::sonos::types::{ZoneGroup, ZoneGroupMember};

        let state = SonosState::default();
        {
            let mut groups = state.groups.write();
            *groups = vec![ZoneGroup {
                id: "group1".to_string(),
                name: "Living Room".to_string(),
                coordinator_uuid: "RINCON_LIVING".to_string(),
                coordinator_ip: "192.168.1.100".to_string(),
                members: vec![ZoneGroupMember {
                    uuid: "RINCON_LIVING".to_string(),
                    ip: "192.168.1.100".to_string(),
                    zone_name: "Living Room".to_string(),
                    model: "One".to_string(),
                }],
            }];
        }

        // Living Room is coordinator - should return None
        assert_eq!(
            state.get_original_coordinator_for_slave("192.168.1.100"),
            None
        );
    }

    #[test]
    fn get_original_coordinator_returns_none_for_unknown() {
        let state = SonosState::default();

        // Unknown IP - should return None
        assert_eq!(
            state.get_original_coordinator_for_slave("192.168.1.200"),
            None
        );
    }
}
