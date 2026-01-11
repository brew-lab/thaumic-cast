use std::hash::Hash;
use std::sync::OnceLock;

use dashmap::DashMap;
use parking_lot::{Mutex, RwLock};
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

    /// Enable SSDP multicast discovery (239.255.255.250:1900).
    pub discovery_ssdp_multicast: bool,

    /// Enable SSDP broadcast discovery (directed per-interface + 255.255.255.255).
    pub discovery_ssdp_broadcast: bool,

    /// Enable mDNS/Bonjour discovery (_sonos._tcp.local.).
    pub discovery_mdns: bool,

    /// mDNS browse timeout (milliseconds).
    pub mdns_browse_timeout_ms: u64,

    // ─────────────────────────────────────────────────────────────────────────
    // Streaming
    // ─────────────────────────────────────────────────────────────────────────
    /// Maximum number of concurrent audio streams.
    /// Increase for powerful hardware, decrease for resource-constrained systems.
    pub max_concurrent_streams: usize,

    /// Maximum frames to buffer for late-joining clients.
    /// Higher values = more memory, better catchup for slow clients.
    /// Extension sends 20ms frames, so 50 frames ≈ 1 second of audio.
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
            discovery_ssdp_multicast: true,
            discovery_ssdp_broadcast: true,
            discovery_mdns: true,
            mdns_browse_timeout_ms: 2000,

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
