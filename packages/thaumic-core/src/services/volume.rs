//! Multi-speaker volume orchestration service.
//!
//! Provides shared logic for setting volume on multiple speakers concurrently.
//! Used by both HTTP and WebSocket handlers.

use std::collections::HashSet;
use std::sync::Arc;

use futures::future::join_all;
use serde::Serialize;

use crate::error::ThaumicError;
use crate::sonos::traits::SonosClient;

/// Result of setting volume on multiple speakers.
///
/// Field names match existing HTTP response shape for consistency.
#[derive(Debug, Clone, Serialize)]
pub struct MultiSpeakerVolumeResult {
    /// Number of speakers that successfully had volume set.
    pub success: usize,
    /// Total number of speakers attempted.
    pub total: usize,
    /// List of (ip, error) tuples for failures.
    pub failures: Vec<(String, String)>,
}

/// Sets volume on multiple speakers concurrently.
///
/// - Deduplicates IPs using HashSet
/// - Clamps volume to 0-100
/// - Returns success/failure counts
/// - Returns ThaumicError if speaker_ips is empty
///
/// # Arguments
/// * `sonos` - The Sonos client (implements SonosVolumeControl)
/// * `speaker_ips` - List of speaker IP addresses to set volume on
/// * `volume` - Target volume level (0-100, values > 100 are clamped)
///
/// # Returns
/// Result containing success/failure counts and any error details
pub async fn set_multi_speaker_volume(
    sonos: Arc<dyn SonosClient>,
    speaker_ips: &[String],
    volume: u8,
) -> Result<MultiSpeakerVolumeResult, ThaumicError> {
    // Dedupe using HashSet, then collect for iteration
    let unique_ips: Vec<_> = speaker_ips
        .iter()
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();

    if unique_ips.is_empty() {
        return Err(ThaumicError::InvalidRequest(
            "speaker_ips cannot be empty".into(),
        ));
    }

    // Clamp volume to valid range (underlying function also clamps, but be explicit)
    let volume = volume.min(100);

    // Spawn concurrent volume set operations
    let futures: Vec<_> = unique_ips
        .iter()
        .map(|ip| {
            let sonos = Arc::clone(&sonos);
            let ip = ip.clone();
            async move {
                sonos
                    .set_speaker_volume(&ip, volume)
                    .await
                    .map_err(|e| (ip, e.to_string()))
            }
        })
        .collect();

    let results = join_all(futures).await;
    let (successes, failures): (Vec<_>, Vec<_>) = results.into_iter().partition(Result::is_ok);

    let success_count = successes.len();
    let failure_details: Vec<_> = failures.into_iter().filter_map(|r| r.err()).collect();

    // Return error if all speakers failed - ensures consistent handling by callers
    if success_count == 0 && !failure_details.is_empty() {
        return Err(ThaumicError::Internal(format!(
            "All volume commands failed: {:?}",
            failure_details
        )));
    }

    Ok(MultiSpeakerVolumeResult {
        success: success_count,
        total: unique_ips.len(),
        failures: failure_details,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicU8, Ordering};

    use crate::error::DiscoveryResult;
    use crate::sonos::discovery::Speaker;
    use crate::sonos::soap::{SoapError, SoapResult};
    use crate::sonos::traits::{SonosDiscovery, SonosPlayback, SonosTopology, SonosVolumeControl};
    use crate::sonos::types::{PositionInfo, ZoneGroup};
    use crate::stream::{AudioCodec, AudioFormat, StreamMetadata};

    /// Mock Sonos client for testing volume operations
    struct MockSonosClient {
        /// Track last volume set for verification
        last_volume: AtomicU8,
        /// Whether to fail operations
        should_fail: bool,
    }

    impl MockSonosClient {
        fn new(should_fail: bool) -> Self {
            Self {
                last_volume: AtomicU8::new(0),
                should_fail,
            }
        }
    }

    #[async_trait]
    impl SonosDiscovery for MockSonosClient {
        async fn discover_speakers(&self) -> DiscoveryResult<Vec<Speaker>> {
            Ok(vec![])
        }
    }

    #[async_trait]
    impl SonosPlayback for MockSonosClient {
        async fn play_uri(
            &self,
            _ip: &str,
            _uri: &str,
            _codec: AudioCodec,
            _audio_format: &AudioFormat,
            _metadata: Option<&StreamMetadata>,
            _artwork_url: &str,
        ) -> SoapResult<()> {
            Ok(())
        }

        async fn play(&self, _ip: &str) -> SoapResult<()> {
            Ok(())
        }

        async fn stop(&self, _ip: &str) -> SoapResult<()> {
            Ok(())
        }

        async fn switch_to_queue(&self, _ip: &str, _coordinator_uuid: &str) -> SoapResult<()> {
            Ok(())
        }

        async fn get_position_info(&self, _ip: &str) -> SoapResult<PositionInfo> {
            Ok(PositionInfo {
                track: 1,
                track_duration: "00:00:00".to_string(),
                track_uri: "".to_string(),
                rel_time: "00:00:00".to_string(),
                rel_time_ms: 0,
            })
        }

        async fn join_group(&self, _ip: &str, _coordinator_uuid: &str) -> SoapResult<()> {
            Ok(())
        }

        async fn leave_group(&self, _ip: &str) -> SoapResult<()> {
            Ok(())
        }
    }

    #[async_trait]
    impl SonosTopology for MockSonosClient {
        async fn get_zone_groups(&self, _ip: &str) -> SoapResult<Vec<ZoneGroup>> {
            Ok(vec![])
        }
    }

    #[async_trait]
    impl SonosVolumeControl for MockSonosClient {
        async fn get_group_volume(&self, _coordinator_ip: &str) -> SoapResult<u8> {
            Ok(50)
        }

        async fn set_group_volume(&self, _coordinator_ip: &str, _volume: u8) -> SoapResult<()> {
            Ok(())
        }

        async fn get_group_mute(&self, _coordinator_ip: &str) -> SoapResult<bool> {
            Ok(false)
        }

        async fn set_group_mute(&self, _coordinator_ip: &str, _mute: bool) -> SoapResult<()> {
            Ok(())
        }

        async fn get_speaker_volume(&self, _speaker_ip: &str) -> SoapResult<u8> {
            Ok(50)
        }

        async fn set_speaker_volume(&self, _speaker_ip: &str, volume: u8) -> SoapResult<()> {
            if self.should_fail {
                return Err(SoapError::Fault("simulated failure".to_string()));
            }
            self.last_volume.store(volume, Ordering::SeqCst);
            Ok(())
        }
    }

    // Blanket implementation from traits.rs applies: MockSonosClient now implements SonosClient

    #[tokio::test]
    async fn empty_ips_returns_error() {
        let sonos = Arc::new(MockSonosClient::new(false));
        let result = set_multi_speaker_volume(sonos, &[], 50).await;
        assert!(result.is_err());
        match result {
            Err(ThaumicError::InvalidRequest(msg)) => {
                assert!(msg.contains("cannot be empty"));
            }
            _ => panic!("Expected InvalidRequest error"),
        }
    }

    #[tokio::test]
    async fn single_speaker_success() {
        let sonos = Arc::new(MockSonosClient::new(false));
        let ips = vec!["192.168.1.100".to_string()];
        let result = set_multi_speaker_volume(sonos.clone(), &ips, 75)
            .await
            .unwrap();

        assert_eq!(result.success, 1);
        assert_eq!(result.total, 1);
        assert!(result.failures.is_empty());
        assert_eq!(sonos.last_volume.load(Ordering::SeqCst), 75);
    }

    #[tokio::test]
    async fn deduplicates_ips() {
        let sonos = Arc::new(MockSonosClient::new(false));
        let ips = vec![
            "192.168.1.100".to_string(),
            "192.168.1.100".to_string(), // Duplicate
            "192.168.1.101".to_string(),
        ];
        let result = set_multi_speaker_volume(sonos, &ips, 50).await.unwrap();

        // Should only process 2 unique IPs
        assert_eq!(result.total, 2);
        assert_eq!(result.success, 2);
    }

    #[tokio::test]
    async fn clamps_volume_to_100() {
        let sonos = Arc::new(MockSonosClient::new(false));
        let ips = vec!["192.168.1.100".to_string()];
        let _ = set_multi_speaker_volume(sonos.clone(), &ips, 150)
            .await
            .unwrap();

        assert_eq!(sonos.last_volume.load(Ordering::SeqCst), 100);
    }

    #[tokio::test]
    async fn all_failures_returns_error() {
        let sonos = Arc::new(MockSonosClient::new(true));
        let ips = vec!["192.168.1.100".to_string()];
        let result = set_multi_speaker_volume(sonos, &ips, 50).await;

        assert!(result.is_err());
        match result {
            Err(ThaumicError::Internal(msg)) => {
                assert!(msg.contains("All volume commands failed"));
                assert!(msg.contains("192.168.1.100"));
            }
            _ => panic!("Expected Internal error"),
        }
    }

    #[tokio::test]
    async fn partial_failure_returns_ok() {
        // Create a client that fails for specific IPs
        struct PartialFailClient;

        #[async_trait]
        impl SonosDiscovery for PartialFailClient {
            async fn discover_speakers(&self) -> DiscoveryResult<Vec<Speaker>> {
                Ok(vec![])
            }
        }

        #[async_trait]
        impl SonosPlayback for PartialFailClient {
            async fn play_uri(
                &self,
                _ip: &str,
                _uri: &str,
                _codec: AudioCodec,
                _audio_format: &AudioFormat,
                _metadata: Option<&StreamMetadata>,
                _artwork_url: &str,
            ) -> SoapResult<()> {
                Ok(())
            }
            async fn play(&self, _ip: &str) -> SoapResult<()> {
                Ok(())
            }
            async fn stop(&self, _ip: &str) -> SoapResult<()> {
                Ok(())
            }
            async fn switch_to_queue(&self, _ip: &str, _coordinator_uuid: &str) -> SoapResult<()> {
                Ok(())
            }
            async fn get_position_info(&self, _ip: &str) -> SoapResult<PositionInfo> {
                Ok(PositionInfo {
                    track: 1,
                    track_duration: "00:00:00".to_string(),
                    track_uri: "".to_string(),
                    rel_time: "00:00:00".to_string(),
                    rel_time_ms: 0,
                })
            }
            async fn join_group(&self, _ip: &str, _coordinator_uuid: &str) -> SoapResult<()> {
                Ok(())
            }
            async fn leave_group(&self, _ip: &str) -> SoapResult<()> {
                Ok(())
            }
        }

        #[async_trait]
        impl SonosTopology for PartialFailClient {
            async fn get_zone_groups(&self, _ip: &str) -> SoapResult<Vec<ZoneGroup>> {
                Ok(vec![])
            }
        }

        #[async_trait]
        impl SonosVolumeControl for PartialFailClient {
            async fn get_group_volume(&self, _coordinator_ip: &str) -> SoapResult<u8> {
                Ok(50)
            }
            async fn set_group_volume(&self, _coordinator_ip: &str, _volume: u8) -> SoapResult<()> {
                Ok(())
            }
            async fn get_group_mute(&self, _coordinator_ip: &str) -> SoapResult<bool> {
                Ok(false)
            }
            async fn set_group_mute(&self, _coordinator_ip: &str, _mute: bool) -> SoapResult<()> {
                Ok(())
            }
            async fn get_speaker_volume(&self, _speaker_ip: &str) -> SoapResult<u8> {
                Ok(50)
            }
            async fn set_speaker_volume(&self, speaker_ip: &str, _volume: u8) -> SoapResult<()> {
                // Fail for .101, succeed for .100
                if speaker_ip.ends_with(".101") {
                    Err(SoapError::Fault("simulated failure".to_string()))
                } else {
                    Ok(())
                }
            }
        }

        let sonos = Arc::new(PartialFailClient);
        let ips = vec!["192.168.1.100".to_string(), "192.168.1.101".to_string()];
        let result = set_multi_speaker_volume(sonos, &ips, 50).await.unwrap();

        assert_eq!(result.success, 1);
        assert_eq!(result.total, 2);
        assert_eq!(result.failures.len(), 1);
        assert_eq!(result.failures[0].0, "192.168.1.101");
    }
}
