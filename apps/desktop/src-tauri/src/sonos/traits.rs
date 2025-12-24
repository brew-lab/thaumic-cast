//! Trait abstractions for Sonos operations.
//!
//! These traits enable dependency injection for testability and modularity.
//! Services depend on traits rather than concrete implementations.

use async_trait::async_trait;

use crate::error::{DiscoveryResult, SoapResult};
use crate::sonos::discovery::Speaker;
use crate::sonos::types::ZoneGroup;
use crate::stream::StreamMetadata;

/// Trait for Sonos playback control operations.
///
/// Used by `StreamCoordinator` to command speakers to play or stop.
#[async_trait]
pub trait SonosPlayback: Send + Sync {
    /// Commands a Sonos speaker to play a specific audio URI.
    ///
    /// # Arguments
    /// * `ip` - IP address of the Sonos speaker (coordinator for grouped speakers)
    /// * `uri` - The audio stream URL to play
    /// * `metadata` - Optional stream metadata for display (title, artist, album, artwork)
    async fn play_uri(
        &self,
        ip: &str,
        uri: &str,
        metadata: Option<&StreamMetadata>,
    ) -> SoapResult<()>;

    /// Stops playback on a Sonos speaker.
    ///
    /// # Arguments
    /// * `ip` - IP address of the Sonos speaker (coordinator for grouped speakers)
    async fn stop(&self, ip: &str) -> SoapResult<()>;
}

/// Trait for Sonos topology operations.
///
/// Used by `TopologyMonitor` to fetch zone group information.
#[async_trait]
pub trait SonosTopology: Send + Sync {
    /// Fetches the current zone groups from a Sonos speaker.
    ///
    /// # Arguments
    /// * `ip` - IP address of any Sonos speaker on the network
    async fn get_zone_groups(&self, ip: &str) -> SoapResult<Vec<ZoneGroup>>;
}

/// Trait for Sonos speaker discovery operations.
///
/// Used by `TopologyMonitor` and Tauri commands to discover speakers on the network.
#[async_trait]
pub trait SonosDiscovery: Send + Sync {
    /// Discovers Sonos speakers on the local network using SSDP.
    async fn discover_speakers(&self) -> DiscoveryResult<Vec<Speaker>>;
}

/// Trait for Sonos volume and mute control operations.
///
/// Used by API handlers to control speaker group volume and mute state.
#[async_trait]
pub trait SonosVolumeControl: Send + Sync {
    /// Gets the current group volume from the coordinator (0-100).
    ///
    /// # Arguments
    /// * `coordinator_ip` - IP address of the group coordinator
    async fn get_group_volume(&self, coordinator_ip: &str) -> SoapResult<u8>;

    /// Sets the group volume on the coordinator (0-100).
    ///
    /// # Arguments
    /// * `coordinator_ip` - IP address of the group coordinator
    /// * `volume` - Desired volume level (0-100, values > 100 are clamped)
    async fn set_group_volume(&self, coordinator_ip: &str, volume: u8) -> SoapResult<()>;

    /// Gets the current group mute state from the coordinator.
    ///
    /// # Arguments
    /// * `coordinator_ip` - IP address of the group coordinator
    async fn get_group_mute(&self, coordinator_ip: &str) -> SoapResult<bool>;

    /// Sets the group mute state on the coordinator.
    ///
    /// # Arguments
    /// * `coordinator_ip` - IP address of the group coordinator
    /// * `mute` - `true` to mute, `false` to unmute
    async fn set_group_mute(&self, coordinator_ip: &str, mute: bool) -> SoapResult<()>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Combined Traits (for trait objects)
// ─────────────────────────────────────────────────────────────────────────────

/// Combined trait for topology monitoring operations.
///
/// Used by `TopologyMonitor` which needs both discovery and topology operations.
#[async_trait]
pub trait SonosTopologyClient: SonosDiscovery + SonosTopology {}

/// Blanket implementation for any type implementing both traits.
impl<T: SonosDiscovery + SonosTopology> SonosTopologyClient for T {}

/// Combined trait for all Sonos operations.
///
/// Used by `AppState` to provide a unified client for all Sonos operations.
#[async_trait]
pub trait SonosClient: SonosDiscovery + SonosPlayback + SonosTopology + SonosVolumeControl {}

/// Blanket implementation for any type implementing all traits.
impl<T: SonosDiscovery + SonosPlayback + SonosTopology + SonosVolumeControl> SonosClient for T {}
