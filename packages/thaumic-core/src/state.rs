//! Core application state types.
//!
//! Provides configuration ([`Config`], [`StreamingConfig`]), Sonos runtime
//! state ([`SonosState`]), and manual speaker persistence ([`ManualSpeakerConfig`]).

use std::collections::HashSet;
use std::hash::Hash;
use std::sync::OnceLock;
use std::time::Instant;

use dashmap::DashMap;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::services::speaker_monitor::control::DriftMode;
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
    /// Frames are 10 ms by default (the extension's default and every capture
    /// packet), so 50 frames ≈ 500 ms of audio. A compressed connection is
    /// served all of it. A PCM stream's ring is sized up from this to hold the
    /// largest connect burst plus the largest jitter buffer (see
    /// [`crate::protocol_constants::pcm_ring_frames`]), and a new PCM
    /// connection is served only its burst plus its `jitter_buffer_ms` of it.
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

    // Streaming
    /// Streaming configuration.
    #[serde(default)]
    pub streaming: StreamingConfig,

    // Access control
    /// Whether `GET /stream/{id}/live` refuses addresses the stream is not for.
    ///
    /// A stream id is not a secret: the server hands the stream URL to a Sonos
    /// speaker, and the speaker republishes it as `CurrentTrackURI` to any
    /// unauthenticated device on the LAN that asks. Every fetch is therefore
    /// checked against the addresses the stream is actually playing on, plus
    /// this machine.
    ///
    /// Defaults to `false`, which **logs and serves**: a fetch from an
    /// unexpected address is reported at `warn` and still gets its audio. A
    /// wrongly refused fetch is dead air with nothing in the UI to explain it,
    /// so the first release observes real households before anyone enforces.
    /// Set to `true` once the logs show no unexpected addresses. Only the
    /// headless server exposes the option today (`strict_stream_access` in its
    /// config, or `THAUMIC_STRICT_STREAM_ACCESS`); the desktop app runs with
    /// the default.
    ///
    /// Known gap once enforced: sessions are keyed by the speaker's address,
    /// and nothing rewrites a live session when a speaker is renumbered
    /// mid-cast (DHCP renewal, reboot). That speaker's next fetch comes from
    /// an address the stream does not list and is refused until playback is
    /// restarted. With the flag off the fetch is served and logged, which is
    /// how often this happens gets measured.
    ///
    /// What it does not do: the allowlist is simply whatever the control API
    /// has been told to play on, and `POST /api/playback/start` is
    /// unauthenticated like the rest of the LAN API — it accepts any address as
    /// a speaker. A device that can reach that endpoint can therefore name
    /// itself and be admitted. This flag closes the passive hole, where a
    /// stream URL is readable off any speaker by anyone; it is not a defence
    /// against someone actively driving the control API, which needs
    /// authentication there instead.
    #[serde(default)]
    pub strict_stream_access: bool,

    // Diagnostics
    /// Whether the server keeps an eye on each speaker playing one of its
    /// streams by asking it for its playback position every few seconds.
    ///
    /// Defaults to `true`. A speaker that fetches a stream is polled with a
    /// quiet `GetPositionInfo` every two to three seconds (about 24 calls a
    /// minute, and never more than 120 a minute across the whole process), so
    /// a speaker that is about to run out of audio shows up in the log before
    /// it is heard. Speakers that never fetch the stream themselves, such as
    /// grouped speakers following a coordinator and home-theatre satellites,
    /// are never polled.
    ///
    /// `false` restores the earlier behaviour: a cast is only polled when its
    /// client asked for video sync, which needs the polls and keeps them
    /// whatever this says. The setting is read once per speaker connection,
    /// so a change applies from each speaker's next connection without a
    /// restart. `THAUMIC_SPEAKER_MONITOR=on|off` overrides it (see
    /// [`crate::services::latency_monitor::speaker_monitor_enabled`]).
    #[serde(default = "default_speaker_monitor")]
    pub speaker_monitor: bool,

    // Streaming
    /// Milliseconds of already-captured audio a PCM connection is sent as fast
    /// as TCP takes it when a speaker's GET starts, before real-time pacing
    /// takes over. `0` turns the burst off.
    ///
    /// Defaults to [`DEFAULT_PCM_CONNECT_BURST_MS`]. Paced from its first
    /// frame, a speaker never holds more than a few tens of milliseconds of
    /// audio ahead of its playhead, and a Wi-Fi retransmission burst outlasts
    /// that; the burst leaves it this much in hand, on every connection
    /// including a resume. End-to-end latency grows by the same amount, which
    /// video sync accounts for. The server's own jitter buffer is kept on top,
    /// so a stream whose ring does not yet hold both (a connection moments
    /// after the stream starts) bursts only what it has beyond the jitter
    /// buffer. Values above [`MAX_PCM_CONNECT_BURST_MS`] are clamped. Compressed
    /// codecs are unaffected. Read once per connection;
    /// `THAUMIC_PCM_CONNECT_BURST_MS` overrides it (see
    /// [`crate::stream::pcm_connect_burst_ms`]).
    ///
    /// [`DEFAULT_PCM_CONNECT_BURST_MS`]: crate::protocol_constants::DEFAULT_PCM_CONNECT_BURST_MS
    /// [`MAX_PCM_CONNECT_BURST_MS`]: crate::protocol_constants::MAX_PCM_CONNECT_BURST_MS
    #[serde(default = "default_pcm_connect_burst_ms")]
    pub pcm_connect_burst_ms: u64,

    /// Clock drift correction for PCM streams: `on` stretches or squeezes
    /// each speaker's audio by at most 150 ppm to hold its head start level
    /// over long casts, `observe` works out and logs what it would do while
    /// leaving the audio byte for byte as captured, `off` does neither.
    ///
    /// Defaults to [`DriftMode::Observe`]. Correction steers by the speaker
    /// monitor, so with [`Self::speaker_monitor`] off it is off. Read once
    /// per connection, so a change applies from each speaker's next
    /// connection; `THAUMIC_DRIFT_COMPENSATION=on|observe|off` overrides it
    /// (see [`crate::services::speaker_monitor::control::drift_compensation_mode`]).
    #[serde(default)]
    pub drift_compensation: DriftMode,
}

/// Speaker monitoring is on unless switched off.
fn default_speaker_monitor() -> bool {
    true
}

/// The PCM connect burst is on unless switched off.
fn default_pcm_connect_burst_ms() -> u64 {
    crate::protocol_constants::DEFAULT_PCM_CONNECT_BURST_MS
}

impl Default for Config {
    fn default() -> Self {
        Self {
            preferred_port: 0,
            topology_refresh_interval: 30,
            streaming: StreamingConfig::default(),
            strict_stream_access: false,
            speaker_monitor: default_speaker_monitor(),
            pcm_connect_burst_ms: default_pcm_connect_burst_ms(),
            drift_compensation: DriftMode::default(),
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
    /// When each entry of `transport_states` last arrived in a GENA NOTIFY.
    ///
    /// Sonos only notifies on change, and a subscription whose callback has
    /// become unreachable still renews, so an old entry may be right or may
    /// be stale; the age is what lets a reader tell a state heard since it
    /// started watching from one it cannot vouch for.
    pub transport_state_received: DashMap<String, Instant>,
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
        self.transport_state_received
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

    /// Records a transport state heard in a GENA NOTIFY, and when it arrived.
    pub fn record_transport_state(&self, speaker_ip: &str, state: TransportState) {
        self.transport_states.insert(speaker_ip.to_string(), state);
        self.transport_state_received
            .insert(speaker_ip.to_string(), Instant::now());
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
        assert_eq!(config.topology_refresh_interval, 30);
        assert!(config.speaker_monitor, "speaker monitoring ships on");
    }

    /// A config written before the field existed keeps monitoring on.
    #[test]
    fn speaker_monitor_defaults_on_when_absent() {
        let config: Config =
            serde_json::from_str(r#"{"preferred_port":0,"topology_refresh_interval":30}"#)
                .expect("parses");
        assert!(config.speaker_monitor);
        let config: Config = serde_json::from_str(
            r#"{"preferred_port":0,"topology_refresh_interval":30,"speaker_monitor":false}"#,
        )
        .expect("parses");
        assert!(!config.speaker_monitor);
    }

    /// The connect burst ships on, including for a config written before the
    /// field existed, and a config can switch it off.
    #[test]
    fn pcm_connect_burst_defaults_on_when_absent() {
        assert_eq!(Config::default().pcm_connect_burst_ms, 500);
        let config: Config =
            serde_json::from_str(r#"{"preferred_port":0,"topology_refresh_interval":30}"#)
                .expect("parses");
        assert_eq!(config.pcm_connect_burst_ms, 500);
        let config: Config = serde_json::from_str(
            r#"{"preferred_port":0,"topology_refresh_interval":30,"pcm_connect_burst_ms":0}"#,
        )
        .expect("parses");
        assert_eq!(config.pcm_connect_burst_ms, 0);
    }

    /// Drift correction ships observing, including for a config written
    /// before the field existed, and a config can set it.
    #[test]
    fn drift_compensation_defaults_to_observe_when_absent() {
        assert_eq!(Config::default().drift_compensation, DriftMode::Observe);
        let config: Config =
            serde_json::from_str(r#"{"preferred_port":0,"topology_refresh_interval":30}"#)
                .expect("parses");
        assert_eq!(config.drift_compensation, DriftMode::Observe);
        let config: Config = serde_json::from_str(
            r#"{"preferred_port":0,"topology_refresh_interval":30,"drift_compensation":"on"}"#,
        )
        .expect("parses");
        assert_eq!(config.drift_compensation, DriftMode::On);
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
