//! Sync-aware volume and mute routing.
//!
//! Routes volume/mute operations to the correct Sonos service based on
//! whether a speaker is in a synchronized multi-room session.
//! - Sync session: use per-speaker RenderingControl
//! - Non-sync: use GroupRenderingControl (preserves stereo pair/sub behavior)

use super::playback_session_store::{GroupRole, PlaybackSessionStore};

/// Routes volume/mute operations based on sync session state.
pub(crate) struct VolumeRouter<'a> {
    sessions: &'a PlaybackSessionStore,
}

impl<'a> VolumeRouter<'a> {
    /// Creates a new VolumeRouter backed by the given session store.
    pub fn new(sessions: &'a PlaybackSessionStore) -> Self {
        Self { sessions }
    }

    /// Returns whether to use per-speaker control for volume/mute operations.
    ///
    /// Returns `true` for speakers in sync sessions (use RenderingControl),
    /// `false` otherwise (use GroupRenderingControl for stereo pair/sub behavior).
    #[inline]
    fn should_use_speaker_control(&self, speaker_ip: &str) -> bool {
        self.sessions
            .is_in_sync_session(speaker_ip)
            .unwrap_or(false)
    }

    /// Gets volume with automatic routing based on sync session state.
    pub async fn get_volume_routed(
        &self,
        sonos: &dyn crate::sonos::traits::SonosVolumeControl,
        speaker_ip: &str,
    ) -> crate::error::SoapResult<u8> {
        if self.should_use_speaker_control(speaker_ip) {
            sonos.get_speaker_volume(speaker_ip).await
        } else {
            sonos.get_group_volume(speaker_ip).await
        }
    }

    /// Sets volume with automatic routing based on sync session state.
    pub async fn set_volume_routed(
        &self,
        sonos: &dyn crate::sonos::traits::SonosVolumeControl,
        speaker_ip: &str,
        volume: u8,
    ) -> crate::error::SoapResult<()> {
        if self.should_use_speaker_control(speaker_ip) {
            sonos.set_speaker_volume(speaker_ip, volume).await
        } else {
            sonos.set_group_volume(speaker_ip, volume).await
        }
    }

    /// Gets mute state with automatic routing based on sync session state.
    pub async fn get_mute_routed(
        &self,
        sonos: &dyn crate::sonos::traits::SonosVolumeControl,
        speaker_ip: &str,
    ) -> crate::error::SoapResult<bool> {
        if self.should_use_speaker_control(speaker_ip) {
            sonos.get_speaker_mute(speaker_ip).await
        } else {
            sonos.get_group_mute(speaker_ip).await
        }
    }

    /// Sets mute state with automatic routing based on sync session state.
    pub async fn set_mute_routed(
        &self,
        sonos: &dyn crate::sonos::traits::SonosVolumeControl,
        speaker_ip: &str,
        mute: bool,
    ) -> crate::error::SoapResult<()> {
        if self.should_use_speaker_control(speaker_ip) {
            sonos.set_speaker_mute(speaker_ip, mute).await
        } else {
            sonos.set_group_mute(speaker_ip, mute).await
        }
    }

    /// Resolves the sync session coordinator IP for a given speaker.
    ///
    /// - If the speaker is a coordinator → returns `speaker_ip`
    /// - If the speaker is a slave → returns its `coordinator_ip`
    /// - If not in any session → returns `None`
    pub fn resolve_sync_coordinator_ip(&self, speaker_ip: &str) -> Option<String> {
        let session = self.sessions.get_by_speaker_ip(speaker_ip)?;
        match session.role {
            GroupRole::Coordinator => Some(speaker_ip.to_string()),
            GroupRole::Slave => session.coordinator_ip,
        }
    }

    /// Sets group volume for the entire sync session containing `speaker_ip`.
    ///
    /// Resolves the coordinator IP, then calls `set_group_volume` on it so Sonos
    /// adjusts all members proportionally. If the speaker is not in a sync session,
    /// falls back to `set_group_volume` directly.
    pub async fn set_sync_group_volume(
        &self,
        sonos: &dyn crate::sonos::traits::SonosVolumeControl,
        speaker_ip: &str,
        volume: u8,
    ) -> crate::error::SoapResult<()> {
        let target_ip = self
            .resolve_sync_coordinator_ip(speaker_ip)
            .unwrap_or_else(|| speaker_ip.to_string());
        sonos.set_group_volume(&target_ip, volume).await
    }

    /// Sets group mute for the entire sync session containing `speaker_ip`.
    ///
    /// Resolves the coordinator IP, then calls `set_group_mute` on it so Sonos
    /// mutes/unmutes all members. If the speaker is not in a sync session,
    /// falls back to `set_group_mute` directly.
    pub async fn set_sync_group_mute(
        &self,
        sonos: &dyn crate::sonos::traits::SonosVolumeControl,
        speaker_ip: &str,
        mute: bool,
    ) -> crate::error::SoapResult<()> {
        let target_ip = self
            .resolve_sync_coordinator_ip(speaker_ip)
            .unwrap_or_else(|| speaker_ip.to_string());
        sonos.set_group_mute(&target_ip, mute).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::SoapResult;
    use crate::services::playback_session_store::{
        GroupRole, PlaybackSession, PlaybackSessionStore,
    };
    use crate::sonos::traits::SonosVolumeControl;
    use crate::stream::AudioCodec;
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// Mock volume control that tracks which methods are called.
    struct MockVolumeControl {
        get_speaker_volume_called: AtomicBool,
        get_group_volume_called: AtomicBool,
        set_speaker_volume_called: AtomicBool,
        set_group_volume_called: AtomicBool,
        get_speaker_mute_called: AtomicBool,
        get_group_mute_called: AtomicBool,
        set_speaker_mute_called: AtomicBool,
        set_group_mute_called: AtomicBool,
    }

    impl MockVolumeControl {
        fn new() -> Self {
            Self {
                get_speaker_volume_called: AtomicBool::new(false),
                get_group_volume_called: AtomicBool::new(false),
                set_speaker_volume_called: AtomicBool::new(false),
                set_group_volume_called: AtomicBool::new(false),
                get_speaker_mute_called: AtomicBool::new(false),
                get_group_mute_called: AtomicBool::new(false),
                set_speaker_mute_called: AtomicBool::new(false),
                set_group_mute_called: AtomicBool::new(false),
            }
        }
    }

    #[async_trait]
    impl SonosVolumeControl for MockVolumeControl {
        async fn get_group_volume(&self, _: &str) -> SoapResult<u8> {
            self.get_group_volume_called.store(true, Ordering::SeqCst);
            Ok(50)
        }
        async fn set_group_volume(&self, _: &str, _: u8) -> SoapResult<()> {
            self.set_group_volume_called.store(true, Ordering::SeqCst);
            Ok(())
        }
        async fn get_group_mute(&self, _: &str) -> SoapResult<bool> {
            self.get_group_mute_called.store(true, Ordering::SeqCst);
            Ok(false)
        }
        async fn set_group_mute(&self, _: &str, _: bool) -> SoapResult<()> {
            self.set_group_mute_called.store(true, Ordering::SeqCst);
            Ok(())
        }
        async fn get_speaker_volume(&self, _: &str) -> SoapResult<u8> {
            self.get_speaker_volume_called.store(true, Ordering::SeqCst);
            Ok(75)
        }
        async fn set_speaker_volume(&self, _: &str, _: u8) -> SoapResult<()> {
            self.set_speaker_volume_called.store(true, Ordering::SeqCst);
            Ok(())
        }
        async fn get_speaker_mute(&self, _: &str) -> SoapResult<bool> {
            self.get_speaker_mute_called.store(true, Ordering::SeqCst);
            Ok(true)
        }
        async fn set_speaker_mute(&self, _: &str, _: bool) -> SoapResult<()> {
            self.set_speaker_mute_called.store(true, Ordering::SeqCst);
            Ok(())
        }
    }

    fn make_session(stream_id: &str, speaker_ip: &str, role: GroupRole) -> PlaybackSession {
        PlaybackSession {
            stream_id: stream_id.to_string(),
            speaker_ip: speaker_ip.to_string(),
            stream_url: match role {
                GroupRole::Coordinator => "http://server/stream".to_string(),
                GroupRole::Slave => "x-rincon:RINCON_100".to_string(),
            },
            codec: AudioCodec::Aac,
            role,
            coordinator_ip: match role {
                GroupRole::Coordinator => None,
                GroupRole::Slave => Some("192.168.1.100".to_string()),
            },
            coordinator_uuid: Some("RINCON_100".to_string()),
            original_coordinator_uuid: None,
        }
    }

    fn create_test_router() -> (PlaybackSessionStore, MockVolumeControl) {
        (PlaybackSessionStore::new(), MockVolumeControl::new())
    }

    // ───────────────────────────────────────────────────────────────────
    // Volume routing
    // ───────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn set_volume_routed_uses_speaker_control_in_sync_session() {
        let (store, mock) = create_test_router();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));
        store.insert(make_session("s1", "192.168.1.101", GroupRole::Slave));

        let router = VolumeRouter::new(&store);
        router
            .set_volume_routed(&mock, "192.168.1.100", 75)
            .await
            .unwrap();

        assert!(mock.set_speaker_volume_called.load(Ordering::SeqCst));
        assert!(!mock.set_group_volume_called.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn set_volume_routed_uses_group_control_for_solo_speaker() {
        let (store, mock) = create_test_router();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));

        let router = VolumeRouter::new(&store);
        router
            .set_volume_routed(&mock, "192.168.1.100", 75)
            .await
            .unwrap();

        assert!(!mock.set_speaker_volume_called.load(Ordering::SeqCst));
        assert!(mock.set_group_volume_called.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn set_volume_routed_uses_group_control_for_unknown_speaker() {
        let (store, mock) = create_test_router();

        let router = VolumeRouter::new(&store);
        router
            .set_volume_routed(&mock, "192.168.1.100", 75)
            .await
            .unwrap();

        assert!(!mock.set_speaker_volume_called.load(Ordering::SeqCst));
        assert!(mock.set_group_volume_called.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn get_volume_routed_uses_speaker_control_in_sync_session() {
        let (store, mock) = create_test_router();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));
        store.insert(make_session("s1", "192.168.1.101", GroupRole::Slave));

        let router = VolumeRouter::new(&store);
        let _ = router
            .get_volume_routed(&mock, "192.168.1.100")
            .await
            .unwrap();

        assert!(mock.get_speaker_volume_called.load(Ordering::SeqCst));
        assert!(!mock.get_group_volume_called.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn get_volume_routed_uses_group_control_for_solo_speaker() {
        let (store, mock) = create_test_router();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));

        let router = VolumeRouter::new(&store);
        let _ = router
            .get_volume_routed(&mock, "192.168.1.100")
            .await
            .unwrap();

        assert!(!mock.get_speaker_volume_called.load(Ordering::SeqCst));
        assert!(mock.get_group_volume_called.load(Ordering::SeqCst));
    }

    // ───────────────────────────────────────────────────────────────────
    // Mute routing
    // ───────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn set_mute_routed_uses_speaker_control_in_sync_session() {
        let (store, mock) = create_test_router();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));
        store.insert(make_session("s1", "192.168.1.101", GroupRole::Slave));

        let router = VolumeRouter::new(&store);
        router
            .set_mute_routed(&mock, "192.168.1.100", true)
            .await
            .unwrap();

        assert!(mock.set_speaker_mute_called.load(Ordering::SeqCst));
        assert!(!mock.set_group_mute_called.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn set_mute_routed_uses_group_control_for_solo_speaker() {
        let (store, mock) = create_test_router();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));

        let router = VolumeRouter::new(&store);
        router
            .set_mute_routed(&mock, "192.168.1.100", true)
            .await
            .unwrap();

        assert!(!mock.set_speaker_mute_called.load(Ordering::SeqCst));
        assert!(mock.set_group_mute_called.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn get_mute_routed_uses_speaker_control_in_sync_session() {
        let (store, mock) = create_test_router();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));
        store.insert(make_session("s1", "192.168.1.101", GroupRole::Slave));

        let router = VolumeRouter::new(&store);
        let _ = router
            .get_mute_routed(&mock, "192.168.1.100")
            .await
            .unwrap();

        assert!(mock.get_speaker_mute_called.load(Ordering::SeqCst));
        assert!(!mock.get_group_mute_called.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn get_mute_routed_uses_group_control_for_solo_speaker() {
        let (store, mock) = create_test_router();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));

        let router = VolumeRouter::new(&store);
        let _ = router
            .get_mute_routed(&mock, "192.168.1.100")
            .await
            .unwrap();

        assert!(!mock.get_speaker_mute_called.load(Ordering::SeqCst));
        assert!(mock.get_group_mute_called.load(Ordering::SeqCst));
    }

    // ───────────────────────────────────────────────────────────────────
    // resolve_sync_coordinator_ip
    // ───────────────────────────────────────────────────────────────────

    #[test]
    fn resolve_sync_coordinator_returns_self_for_coordinator() {
        let store = PlaybackSessionStore::new();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));

        let router = VolumeRouter::new(&store);
        assert_eq!(
            router.resolve_sync_coordinator_ip("192.168.1.100"),
            Some("192.168.1.100".to_string())
        );
    }

    #[test]
    fn resolve_sync_coordinator_returns_coordinator_ip_for_slave() {
        let store = PlaybackSessionStore::new();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));
        store.insert(make_session("s1", "192.168.1.101", GroupRole::Slave));

        let router = VolumeRouter::new(&store);
        assert_eq!(
            router.resolve_sync_coordinator_ip("192.168.1.101"),
            Some("192.168.1.100".to_string())
        );
    }

    #[test]
    fn resolve_sync_coordinator_returns_none_for_unknown_speaker() {
        let store = PlaybackSessionStore::new();
        let router = VolumeRouter::new(&store);
        assert_eq!(router.resolve_sync_coordinator_ip("192.168.1.200"), None);
    }

    // ───────────────────────────────────────────────────────────────────
    // Sync group volume/mute
    // ───────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn set_sync_group_volume_calls_group_volume_on_coordinator() {
        let (store, mock) = create_test_router();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));
        store.insert(make_session("s1", "192.168.1.101", GroupRole::Slave));

        let router = VolumeRouter::new(&store);
        router
            .set_sync_group_volume(&mock, "192.168.1.101", 60)
            .await
            .unwrap();

        assert!(mock.set_group_volume_called.load(Ordering::SeqCst));
        assert!(!mock.set_speaker_volume_called.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn set_sync_group_volume_falls_back_for_unknown_speaker() {
        let (store, mock) = create_test_router();

        let router = VolumeRouter::new(&store);
        router
            .set_sync_group_volume(&mock, "192.168.1.200", 50)
            .await
            .unwrap();

        assert!(mock.set_group_volume_called.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn set_sync_group_mute_calls_group_mute_on_coordinator() {
        let (store, mock) = create_test_router();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));
        store.insert(make_session("s1", "192.168.1.101", GroupRole::Slave));

        let router = VolumeRouter::new(&store);
        router
            .set_sync_group_mute(&mock, "192.168.1.100", true)
            .await
            .unwrap();

        assert!(mock.set_group_mute_called.load(Ordering::SeqCst));
        assert!(!mock.set_speaker_mute_called.load(Ordering::SeqCst));
    }
}
