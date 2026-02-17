//! High-level Sonos client implementation.
//!
//! This module provides `SonosClientImpl`, the concrete implementation of
//! Sonos trait abstractions. The actual command logic is split across
//! focused submodules:
//!
//! - `zone_groups` - Zone group topology parsing and retrieval
//! - `didl` - DIDL-Lite metadata formatting
//! - `playback` - Play, stop, and transport control
//! - `volume` - Group and per-speaker volume/mute control
//! - `grouping` - Group join/leave coordination

use async_trait::async_trait;
use reqwest::Client;
use std::sync::{Arc, OnceLock};

use crate::error::{DiscoveryResult, SoapResult};
use crate::sonos::discovery::{DiscoveryConfig, DiscoveryCoordinator, Speaker};
use crate::sonos::grouping;
use crate::sonos::playback;
use crate::sonos::traits::{SonosDiscovery, SonosPlayback, SonosTopology, SonosVolumeControl};
use crate::sonos::types::{PositionInfo, ZoneGroup};
use crate::sonos::volume;
use crate::sonos::zone_groups;
use crate::stream::{AudioCodec, AudioFormat, StreamMetadata};

/// Concrete implementation of Sonos client traits.
///
/// This struct wraps the free functions in submodules to provide
/// a testable, injectable interface for Sonos operations.
pub struct SonosClientImpl {
    /// HTTP client for Sonos communication.
    client: Client,
    /// Discovery coordinator (lazily initialized).
    discovery_coordinator: OnceLock<Arc<DiscoveryCoordinator>>,
    /// Discovery configuration.
    discovery_config: DiscoveryConfig,
}

impl std::fmt::Debug for SonosClientImpl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SonosClientImpl")
            .field("client", &"Client")
            .field("discovery_config", &self.discovery_config)
            .finish()
    }
}

impl Clone for SonosClientImpl {
    fn clone(&self) -> Self {
        Self {
            client: self.client.clone(),
            discovery_coordinator: OnceLock::new(),
            discovery_config: self.discovery_config.clone(),
        }
    }
}

impl SonosClientImpl {
    /// Creates a new SonosClientImpl with the given HTTP client.
    ///
    /// # Arguments
    /// * `client` - The HTTP client to use for all Sonos communication
    #[must_use]
    pub fn new(client: Client) -> Self {
        Self {
            client,
            discovery_coordinator: OnceLock::new(),
            discovery_config: DiscoveryConfig::default(),
        }
    }

    /// Creates a new SonosClientImpl with custom discovery configuration.
    ///
    /// # Arguments
    /// * `client` - The HTTP client to use for all Sonos communication
    /// * `discovery_config` - Configuration for discovery methods
    #[must_use]
    #[allow(dead_code)]
    pub fn with_discovery_config(client: Client, discovery_config: DiscoveryConfig) -> Self {
        Self {
            client,
            discovery_coordinator: OnceLock::new(),
            discovery_config,
        }
    }

    /// Gets or creates the discovery coordinator.
    fn get_discovery_coordinator(&self) -> &Arc<DiscoveryCoordinator> {
        self.discovery_coordinator
            .get_or_init(|| Arc::new(DiscoveryCoordinator::new(self.discovery_config.clone())))
    }
}

#[async_trait]
impl SonosPlayback for SonosClientImpl {
    async fn play_uri(
        &self,
        ip: &str,
        uri: &str,
        codec: AudioCodec,
        audio_format: &AudioFormat,
        metadata: Option<&StreamMetadata>,
        artwork_url: &str,
    ) -> SoapResult<()> {
        playback::play_uri(
            &self.client,
            ip,
            uri,
            codec,
            audio_format,
            metadata,
            artwork_url,
        )
        .await
    }

    async fn play(&self, ip: &str) -> SoapResult<()> {
        playback::play(&self.client, ip).await
    }

    async fn stop(&self, ip: &str) -> SoapResult<()> {
        playback::stop(&self.client, ip).await
    }

    async fn switch_to_queue(&self, ip: &str, coordinator_uuid: &str) -> SoapResult<()> {
        playback::switch_to_queue(&self.client, ip, coordinator_uuid).await
    }

    async fn get_position_info(&self, ip: &str) -> SoapResult<PositionInfo> {
        playback::get_position_info(&self.client, ip).await
    }

    async fn join_group(&self, ip: &str, coordinator_uuid: &str) -> SoapResult<()> {
        grouping::join_group(&self.client, ip, coordinator_uuid).await
    }

    async fn leave_group(&self, ip: &str) -> SoapResult<()> {
        grouping::leave_group(&self.client, ip).await
    }
}

#[async_trait]
impl SonosTopology for SonosClientImpl {
    async fn get_zone_groups(&self, ip: &str) -> SoapResult<Vec<ZoneGroup>> {
        zone_groups::get_zone_groups(&self.client, ip).await
    }
}

#[async_trait]
impl SonosVolumeControl for SonosClientImpl {
    async fn get_group_volume(&self, coordinator_ip: &str) -> SoapResult<u8> {
        volume::get_group_volume(&self.client, coordinator_ip).await
    }

    async fn set_group_volume(&self, coordinator_ip: &str, volume: u8) -> SoapResult<()> {
        volume::set_group_volume(&self.client, coordinator_ip, volume).await
    }

    async fn get_group_mute(&self, coordinator_ip: &str) -> SoapResult<bool> {
        volume::get_group_mute(&self.client, coordinator_ip).await
    }

    async fn set_group_mute(&self, coordinator_ip: &str, mute: bool) -> SoapResult<()> {
        volume::set_group_mute(&self.client, coordinator_ip, mute).await
    }

    async fn get_speaker_volume(&self, speaker_ip: &str) -> SoapResult<u8> {
        volume::get_speaker_volume(&self.client, speaker_ip).await
    }

    async fn set_speaker_volume(&self, speaker_ip: &str, volume: u8) -> SoapResult<()> {
        volume::set_speaker_volume(&self.client, speaker_ip, volume).await
    }

    async fn get_speaker_mute(&self, speaker_ip: &str) -> SoapResult<bool> {
        volume::get_speaker_mute(&self.client, speaker_ip).await
    }

    async fn set_speaker_mute(&self, speaker_ip: &str, mute: bool) -> SoapResult<()> {
        volume::set_speaker_mute(&self.client, speaker_ip, mute).await
    }
}

#[async_trait]
impl SonosDiscovery for SonosClientImpl {
    async fn discover_speakers(&self) -> DiscoveryResult<Vec<Speaker>> {
        self.get_discovery_coordinator().discover_speakers().await
    }
}
