//! Stream lifecycle and playback orchestration service.
//!
//! Responsibilities:
//! - Create/remove audio streams (wraps StreamManager)
//! - Start/stop playback on Sonos speakers (supports multi-group)
//! - Track which streams are playing on which speakers
//! - Track expected stream URLs for source change detection
//! - Broadcast stream lifecycle events to WebSocket clients

use std::sync::Arc;

use bytes::Bytes;
use dashmap::DashMap;

use crate::context::NetworkContext;
use crate::error::ThaumicResult;
use crate::events::{EventEmitter, SpeakerRemovalReason, StreamEvent};
use crate::sonos::gena::GenaSubscriptionManager;
use crate::sonos::services::SonosService;
use crate::sonos::types::TransportState;
use crate::sonos::utils::build_sonos_stream_uri;
use crate::sonos::SonosPlayback;
use crate::state::{SonosState, StreamingConfig};
use crate::stream::{
    AudioCodec, AudioFormat, StreamManager, StreamMetadata, StreamState, Transcoder,
};
use crate::utils::now_millis;

/// Composite key for playback sessions: (stream_id, speaker_ip).
/// Allows multiple speakers to receive the same stream (multi-group casting).
#[derive(Debug, Clone, Hash, Eq, PartialEq)]
struct PlaybackSessionKey {
    stream_id: String,
    speaker_ip: String,
}

impl PlaybackSessionKey {
    fn new(stream_id: &str, speaker_ip: &str) -> Self {
        Self {
            stream_id: stream_id.to_string(),
            speaker_ip: speaker_ip.to_string(),
        }
    }
}

/// Parameters for starting playback on a single speaker.
struct SinglePlaybackParams<'a> {
    speaker_ip: &'a str,
    stream_id: &'a str,
    stream_url: &'a str,
    codec: AudioCodec,
    audio_format: &'a AudioFormat,
    artwork_url: &'a str,
    metadata: Option<&'a StreamMetadata>,
}

/// Parameters for starting playback on multiple speakers (legacy sequential mode).
struct MultiPlaybackParams<'a> {
    speaker_ips: &'a [String],
    stream_id: &'a str,
    stream_url: &'a str,
    codec: AudioCodec,
    audio_format: &'a AudioFormat,
    artwork_url: &'a str,
    metadata: Option<&'a StreamMetadata>,
}

/// Role of a speaker in synchronized group playback.
///
/// When multiple speakers play the same stream, one becomes the coordinator
/// (receives actual stream URL) and others become slaves (sync to coordinator
/// via x-rincon protocol).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupRole {
    /// Coordinator receives the actual stream URL and controls playback timing.
    /// All slaves sync their playback to the coordinator.
    #[default]
    Coordinator,
    /// Slave joins the coordinator via x-rincon protocol for synchronized playback.
    /// Does not fetch the stream directly - follows coordinator's timing.
    Slave,
}

/// Tracks an active playback session linking a stream to a speaker.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSession {
    /// The stream ID being played.
    pub stream_id: String,
    /// The speaker IP address receiving the stream.
    pub speaker_ip: String,
    /// The full URL the speaker is fetching audio from.
    /// For coordinators: the actual stream URL.
    /// For slaves: the x-rincon:{uuid} URI.
    pub stream_url: String,
    /// The codec being used (for Sonos URI formatting).
    pub codec: AudioCodec,
    /// Role in synchronized group playback.
    pub role: GroupRole,
    /// For slaves: the coordinator's IP address.
    /// For coordinators: None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coordinator_ip: Option<String>,
    /// The coordinator's UUID (for cleanup operations).
    /// Set for both coordinators (self UUID) and slaves (coordinator UUID).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coordinator_uuid: Option<String>,
    /// Original group coordinator UUID before joining the streaming group.
    /// For slaves: the UUID of the coordinator they were grouped with before streaming.
    /// None if the speaker was already standalone or is a coordinator.
    /// Used to restore group membership after streaming ends.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_coordinator_uuid: Option<String>,
}

/// Result of starting playback on a single speaker.
/// Used for reporting per-speaker success/failure in multi-group casting.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackResult {
    /// IP address of the speaker.
    pub speaker_ip: String,
    /// Whether playback started successfully.
    pub success: bool,
    /// Stream URL the speaker is fetching (on success).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_url: Option<String>,
    /// Error message (on failure).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Service responsible for stream lifecycle and playback orchestration.
pub struct StreamCoordinator {
    /// Sonos client for playback control.
    sonos: Arc<dyn SonosPlayback>,
    /// Sonos state for UUID lookups.
    sonos_state: Arc<SonosState>,
    stream_manager: Arc<StreamManager>,
    /// Network configuration (port, local IP).
    network: NetworkContext,
    /// Active playback sessions: (stream_id, speaker_ip) -> PlaybackSession
    /// Supports multi-group: one stream can have multiple speaker sessions.
    playback_sessions: DashMap<PlaybackSessionKey, PlaybackSession>,
    /// Event emitter for stream lifecycle events.
    emitter: Arc<dyn EventEmitter>,
    /// GENA subscription manager for RenderingControl subscriptions during sync sessions.
    gena_manager: Arc<GenaSubscriptionManager>,
}

/// Standalone function to check sync session status.
///
/// Extracted so both `StreamCoordinator::is_speaker_in_sync_session` and tests
/// can use the same logic without duplication.
#[must_use]
fn is_speaker_in_sync_session_impl(
    sessions: &DashMap<PlaybackSessionKey, PlaybackSession>,
    speaker_ip: &str,
) -> Option<bool> {
    let session = sessions.iter().find(|r| r.key().speaker_ip == speaker_ip)?;
    let stream_id = &session.key().stream_id;
    let has_slaves = sessions
        .iter()
        .any(|r| r.key().stream_id == *stream_id && r.value().role == GroupRole::Slave);
    Some(has_slaves)
}

impl StreamCoordinator {
    /// Creates a new StreamCoordinator.
    ///
    /// # Arguments
    /// * `sonos` - Sonos client for playback control
    /// * `sonos_state` - Sonos state for UUID lookups
    /// * `network` - Network configuration (port, local IP)
    /// * `emitter` - Event emitter for broadcasting stream events
    /// * `streaming_config` - Streaming configuration (concurrency, buffering, channel capacity)
    /// * `gena_manager` - GENA subscription manager for RenderingControl subscriptions
    pub fn new(
        sonos: Arc<dyn SonosPlayback>,
        sonos_state: Arc<SonosState>,
        network: NetworkContext,
        emitter: Arc<dyn EventEmitter>,
        streaming_config: StreamingConfig,
        gena_manager: Arc<GenaSubscriptionManager>,
    ) -> Self {
        Self {
            sonos,
            sonos_state,
            stream_manager: Arc::new(StreamManager::new(streaming_config)),
            network,
            playback_sessions: DashMap::new(),
            emitter,
            gena_manager,
        }
    }

    /// Emits a stream event to all listeners.
    fn emit_event(&self, event: StreamEvent) {
        self.emitter.emit_stream(event);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // RenderingControl Subscription Management (for sync sessions)
    // ─────────────────────────────────────────────────────────────────────────────

    /// Subscribes to RenderingControl for all speakers in a sync session.
    ///
    /// This enables volume/mute events from individual speakers during synchronized
    /// multi-room playback. Called when a slave joins a coordinator.
    ///
    /// # Arguments
    /// * `stream_id` - The stream ID to find all speakers for
    async fn subscribe_rendering_control_for_sync_session(&self, stream_id: &str) {
        let callback_url = self.network.gena_callback_url();
        let speaker_ips: Vec<String> = self
            .playback_sessions
            .iter()
            .filter(|r| r.key().stream_id == stream_id)
            .map(|r| r.key().speaker_ip.clone())
            .collect();

        log::info!(
            "[GroupSync] Switching {} speakers to RenderingControl for sync session (stream={})",
            speaker_ips.len(),
            stream_id
        );

        for ip in &speaker_ips {
            // First, unsubscribe from GroupRenderingControl to avoid dual subscriptions.
            // Both services emit the same event types (GroupVolume/GroupMute), so having
            // both active causes race conditions where events overwrite each other.
            // RenderingControl provides per-speaker volume which is what we want for sync.
            self.gena_manager
                .unsubscribe_by_ip_and_service(ip, SonosService::GroupRenderingControl)
                .await;

            // Now subscribe to RenderingControl for per-speaker volume/mute events
            if let Err(e) = self
                .gena_manager
                .subscribe(
                    ip.clone(),
                    SonosService::RenderingControl,
                    callback_url.clone(),
                )
                .await
            {
                log::warn!(
                    "[GroupSync] Failed to subscribe RenderingControl for {}: {}",
                    ip,
                    e
                );
                // Continue - degraded experience but functional
            } else {
                log::info!(
                    "[GroupSync] Subscribed to RenderingControl for {} (sync session)",
                    ip
                );

                // Unsubscribe from GroupRenderingControl again to close race window.
                // TopologyMonitor runs periodically and may have re-subscribed between
                // our initial unsubscribe and the RenderingControl subscribe completing.
                self.gena_manager
                    .unsubscribe_by_ip_and_service(ip, SonosService::GroupRenderingControl)
                    .await;
            }
        }
    }

    /// Unsubscribes from RenderingControl for a speaker.
    ///
    /// Called when a speaker leaves a sync session. The GenaSubscriptionManager
    /// handles logging for success/failure/not-found cases.
    async fn unsubscribe_rendering_control(&self, speaker_ip: &str) {
        self.gena_manager
            .unsubscribe_by_ip_and_service(speaker_ip, SonosService::RenderingControl)
            .await;
    }

    /// Gets the expected stream URL for a speaker (normalized for Sonos comparison).
    ///
    /// Returns the stream URL in the format Sonos will report:
    /// - WAV/FLAC: `http://.../.wav` or `http://.../.flac`
    /// - MP3/AAC: `x-rincon-mp3radio://...`
    /// - Slaves: `x-rincon:{uuid}` (already in final form)
    ///
    /// Note: A speaker can only play one stream at a time, so we find the first
    /// session matching the speaker IP.
    #[must_use]
    pub fn get_expected_stream(&self, speaker_ip: &str) -> Option<String> {
        self.playback_sessions
            .iter()
            .find(|r| r.key().speaker_ip == speaker_ip)
            .map(|r| {
                let url = &r.value().stream_url;
                // x-rincon URIs are already in final form (for slaves)
                if url.starts_with("x-rincon:") {
                    url.clone()
                } else {
                    build_sonos_stream_uri(url, r.value().codec)
                }
            })
    }

    /// Gets all playback sessions for a specific stream.
    ///
    /// Reserved for future use (debugging, partial speaker removal).
    #[must_use]
    #[allow(dead_code)]
    pub fn get_sessions_for_stream(&self, stream_id: &str) -> Vec<PlaybackSession> {
        self.playback_sessions
            .iter()
            .filter(|r| r.key().stream_id == stream_id)
            .map(|r| r.value().clone())
            .collect()
    }

    /// Checks if a speaker IP is part of a synchronized multi-room playback session.
    ///
    /// A session is considered "synced" if multiple speakers are playing the same
    /// stream with x-rincon joining (at least one speaker has `GroupRole::Slave`).
    ///
    /// # Arguments
    /// * `speaker_ip` - IP address of the speaker to check
    ///
    /// # Returns
    /// - `Some(true)` if speaker is in a sync session
    /// - `Some(false)` if speaker is in a non-sync session
    /// - `None` if speaker is not in any active session
    #[must_use]
    pub fn is_speaker_in_sync_session(&self, speaker_ip: &str) -> Option<bool> {
        is_speaker_in_sync_session_impl(&self.playback_sessions, speaker_ip)
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Volume/Mute Routing (sync-aware)
    // ─────────────────────────────────────────────────────────────────────────────

    /// Returns whether to use per-speaker control for volume/mute operations.
    ///
    /// Returns `true` for speakers in sync sessions (use RenderingControl),
    /// `false` otherwise (use GroupRenderingControl for stereo pair/sub behavior).
    #[inline]
    fn should_use_speaker_control(&self, speaker_ip: &str) -> bool {
        self.is_speaker_in_sync_session(speaker_ip).unwrap_or(false)
    }

    /// Gets volume with automatic routing based on sync session state.
    ///
    /// For speakers in sync sessions (x-rincon joined), uses per-speaker volume
    /// (RenderingControl). Otherwise uses group volume (GroupRenderingControl).
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
    ///
    /// For speakers in sync sessions (x-rincon joined), uses per-speaker volume
    /// (RenderingControl) to allow independent room control. Otherwise uses group
    /// volume (GroupRenderingControl) which preserves stereo pair/sub behavior.
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
    ///
    /// For speakers in sync sessions (x-rincon joined), uses per-speaker mute
    /// (RenderingControl). Otherwise uses group mute (GroupRenderingControl).
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
    ///
    /// For speakers in sync sessions (x-rincon joined), uses per-speaker mute
    /// (RenderingControl) to allow independent room control. Otherwise uses group
    /// mute (GroupRenderingControl).
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

    /// Inserts a playback session for testing purposes.
    ///
    /// This allows tests to set up coordinator state without going through
    /// the full playback start flow, enabling isolated testing of routing logic.
    #[cfg(test)]
    pub(crate) fn insert_test_session(&self, session: PlaybackSession) {
        let key = PlaybackSessionKey::new(&session.stream_id, &session.speaker_ip);
        self.playback_sessions.insert(key, session);
    }

    /// Creates a new audio stream with the specified output codec and transcoder.
    ///
    /// # Arguments
    /// * `codec` - Output codec for HTTP Content-Type (what Sonos receives)
    /// * `audio_format` - Audio format configuration (sample rate, channels, bit depth)
    /// * `transcoder` - Transcoder for converting input to output format
    /// * `streaming_buffer_ms` - Streaming buffer size in milliseconds (100-1000)
    /// * `frame_duration_ms` - Frame duration in milliseconds for cadence timing
    ///
    /// Returns the stream ID on success. Broadcasts a `StreamEvent::Created` event.
    pub fn create_stream(
        &self,
        codec: AudioCodec,
        audio_format: AudioFormat,
        transcoder: Arc<dyn Transcoder>,
        streaming_buffer_ms: u64,
        frame_duration_ms: u32,
    ) -> Result<String, String> {
        let stream_id = self.stream_manager.create_stream(
            codec,
            audio_format,
            transcoder,
            streaming_buffer_ms,
            frame_duration_ms,
        )?;

        // Broadcast stream created event
        self.emit_event(StreamEvent::Created {
            stream_id: stream_id.clone(),
            timestamp: now_millis(),
        });

        Ok(stream_id)
    }

    /// Removes a stream and cleans up all associated playback sessions.
    ///
    /// Returns the speaker IPs that were playing this stream (for caller to send
    /// SOAP commands if needed).
    ///
    /// Broadcasts a `StreamEvent::Ended` event.
    ///
    /// Note: This is the sync version used by `StreamGuard::drop()`. For graceful
    /// cleanup that stops speakers first, use `remove_stream_async()`.
    pub fn remove_stream(&self, stream_id: &str) -> Vec<String> {
        // Find and remove ALL playback sessions for this stream (multi-group support)
        let keys_to_remove: Vec<PlaybackSessionKey> = self
            .playback_sessions
            .iter()
            .filter(|r| r.key().stream_id == stream_id)
            .map(|r| r.key().clone())
            .collect();

        let speaker_ips: Vec<String> = keys_to_remove
            .iter()
            .map(|k| k.speaker_ip.clone())
            .collect();

        for key in keys_to_remove {
            self.playback_sessions.remove(&key);
        }

        self.stream_manager.remove_stream(stream_id);

        // Broadcast stream ended event
        self.emit_event(StreamEvent::Ended {
            stream_id: stream_id.to_string(),
            timestamp: now_millis(),
        });

        speaker_ips
    }

    /// Removes a stream with graceful speaker cleanup.
    ///
    /// This is the preferred method for stream removal. The cleanup order depends
    /// on the codec:
    ///
    /// **PCM:**
    /// 1. Close HTTP first (Sonos blocks on reads, SOAP would timeout)
    /// 2. Send SOAP stop commands (with group-aware ordering)
    /// 3. Clear sessions
    ///
    /// **Compressed codecs (AAC/MP3/FLAC):**
    /// 1. Send SOAP stop commands first (stops playback immediately)
    /// 2. Then close HTTP (Sonos has internal buffer that would otherwise drain)
    ///
    /// Speaker stop/switch failures are logged but don't prevent cleanup.
    pub async fn remove_stream_async(&self, stream_id: &str) {
        // Get codec before removing the stream
        let stream_state = self.get_stream(stream_id);
        let is_pcm = stream_state
            .as_ref()
            .map(|s| s.codec == AudioCodec::Pcm)
            .unwrap_or(false);

        // Collect speaker IPs before any removal
        let speaker_ips: Vec<String> = self
            .playback_sessions
            .iter()
            .filter(|r| r.key().stream_id == stream_id)
            .map(|r| r.key().speaker_ip.clone())
            .collect();

        if is_pcm {
            // PCM: Close HTTP first to unblock Sonos, then send SOAP commands.
            // Sonos blocks on HTTP reads for PCM streams, causing SOAP timeouts.
            //
            // IMPORTANT: We must close HTTP before SOAP, but keep sessions intact
            // so stop_speakers can determine role ordering (unjoin slaves first).
            self.stream_manager.remove_stream(stream_id);

            // Now stop speakers with group-aware ordering (sessions still intact)
            self.stop_speakers(&speaker_ips).await;

            // Finally clear sessions and emit stream ended event
            self.clear_sessions_and_emit_ended(stream_id);
        } else {
            // Compressed: Send SOAP stop first, then close HTTP.
            // Compressed codecs buffer in Sonos's decoder; stopping first prevents
            // playback of buffered audio after the stream is removed.
            self.stop_speakers(&speaker_ips).await;
            self.remove_stream(stream_id);
        }
    }

    /// Clears playback sessions for a stream and emits the Ended event.
    ///
    /// Used by PCM cleanup path where HTTP must close before SOAP commands,
    /// but sessions must remain intact for role-based stop ordering.
    fn clear_sessions_and_emit_ended(&self, stream_id: &str) {
        let keys_to_remove: Vec<PlaybackSessionKey> = self
            .playback_sessions
            .iter()
            .filter(|r| r.key().stream_id == stream_id)
            .map(|r| r.key().clone())
            .collect();

        for key in keys_to_remove {
            self.playback_sessions.remove(&key);
        }

        self.emit_event(StreamEvent::Ended {
            stream_id: stream_id.to_string(),
            timestamp: now_millis(),
        });
    }

    /// Sends stop commands to a list of speakers (best-effort).
    ///
    /// Stops playback on multiple speakers with group-aware cleanup.
    ///
    /// For grouped playback, the order matters:
    /// 1. Unjoin slaves first (make them standalone)
    /// 2. Restore slaves to their original groups (best-effort)
    /// 3. Stop coordinators
    /// 4. Switch coordinators to queue (cleanup)
    ///
    /// This prevents slaves from showing errors when coordinator stops first.
    async fn stop_speakers(&self, speaker_ips: &[String]) {
        // Separate speakers into coordinators and slaves based on their sessions
        // Also track which speakers need restoration to their original groups
        let mut coordinators: Vec<(String, Option<String>)> = Vec::new(); // (ip, original_coordinator_uuid)
        let mut slaves = Vec::new();
        // Track slaves that need restoration: (speaker_ip, original_coordinator_uuid)
        let mut slave_restoration_info: Vec<(String, String)> = Vec::new();

        for ip in speaker_ips {
            // Find session for this speaker
            if let Some(session) = self
                .playback_sessions
                .iter()
                .find(|r| r.key().speaker_ip == *ip)
            {
                match session.value().role {
                    GroupRole::Coordinator => {
                        coordinators.push((
                            ip.clone(),
                            session.value().original_coordinator_uuid.clone(),
                        ));
                    }
                    GroupRole::Slave => {
                        slaves.push(ip.clone());
                        // Capture restoration info before session removal
                        if let Some(ref orig_uuid) = session.value().original_coordinator_uuid {
                            slave_restoration_info.push((ip.clone(), orig_uuid.clone()));
                        }
                    }
                }
            } else {
                // No session found - treat as coordinator (direct stop, no restoration)
                coordinators.push((ip.clone(), None));
            }
        }

        log::debug!(
            "[GroupSync] stop_speakers: {} coordinators, {} slaves, {} slaves to restore",
            coordinators.len(),
            slaves.len(),
            slave_restoration_info.len()
        );

        // Step 1: Unjoin slaves first (making them standalone temporarily)
        for ip in &slaves {
            if let Err(e) = self.sonos.leave_group(ip).await {
                log::warn!("[GroupSync] Failed to unjoin slave {}: {}", ip, e);
            }
        }

        // Step 2: Restore slaves to their original groups (best-effort)
        for (speaker_ip, original_coordinator_uuid) in slave_restoration_info {
            self.restore_original_group(&speaker_ip, &original_coordinator_uuid)
                .await;
        }

        // Step 3: Stop coordinators and restore any that were originally slaves
        for (ip, original_coordinator_uuid) in &coordinators {
            if let Err(e) = self.sonos.stop(ip).await {
                log::warn!("[StreamCoordinator] Failed to stop {}: {}", ip, e);
            }

            // Switch to queue as cleanup (clears stale stream source in Sonos UI)
            if let Some(uuid) = self.sonos_state.get_coordinator_uuid_by_ip(ip) {
                if let Err(e) = self.sonos.switch_to_queue(ip, &uuid).await {
                    log::warn!(
                        "[StreamCoordinator] Failed to switch {} to queue: {}",
                        ip,
                        e
                    );
                }
            }

            // Restore coordinator to original group if it was a slave before streaming
            // (edge case: fallback coordinator selection picked a speaker from an existing group)
            if let Some(orig_uuid) = original_coordinator_uuid {
                self.restore_original_group(ip, orig_uuid).await;
            }
        }
    }

    /// Attempts to restore a speaker to its original Sonos group.
    ///
    /// This is a best-effort operation - if restoration fails, the speaker
    /// is left standalone (which is the current behavior). Restoration will
    /// fail silently in these cases:
    /// - Original coordinator is gone/unreachable
    /// - Original coordinator is now in a different state
    ///
    /// # Arguments
    /// * `speaker_ip` - IP of the speaker to restore
    /// * `original_coordinator_uuid` - UUID of the original group's coordinator
    async fn restore_original_group(&self, speaker_ip: &str, original_coordinator_uuid: &str) {
        log::info!(
            "[GroupSync] Restoring {} to original group (coordinator: {})",
            speaker_ip,
            original_coordinator_uuid
        );

        // Verify the original coordinator still exists in the current topology
        let coordinator_still_exists = self
            .sonos_state
            .groups
            .read()
            .iter()
            .any(|g| g.coordinator_uuid == original_coordinator_uuid);

        if !coordinator_still_exists {
            log::warn!(
                "[GroupSync] Original coordinator {} no longer exists, leaving {} standalone",
                original_coordinator_uuid,
                speaker_ip
            );
            return;
        }

        // Attempt to rejoin the original group
        match self
            .sonos
            .join_group(speaker_ip, original_coordinator_uuid)
            .await
        {
            Ok(()) => {
                log::info!(
                    "[GroupSync] Successfully restored {} to original group {}",
                    speaker_ip,
                    original_coordinator_uuid
                );
            }
            Err(e) => {
                log::warn!(
                    "[GroupSync] Failed to restore {} to original group: {} (leaving standalone)",
                    speaker_ip,
                    e
                );
            }
        }
    }

    /// Cleans up a stream if no playback sessions remain.
    ///
    /// Checks if any sessions exist for the given stream. If none remain,
    /// removes the stream from StreamManager and emits `StreamEvent::Ended`.
    ///
    /// This should be called after removing a session to ensure streams don't
    /// linger with zero listeners.
    fn cleanup_stream_if_no_sessions(&self, stream_id: &str) {
        let has_remaining_sessions = self
            .playback_sessions
            .iter()
            .any(|r| r.key().stream_id == stream_id);

        if !has_remaining_sessions {
            log::info!(
                "[StreamCoordinator] Last speaker removed from stream {}, ending stream",
                stream_id
            );
            self.stream_manager.remove_stream(stream_id);
            self.emit_event(StreamEvent::Ended {
                stream_id: stream_id.to_string(),
                timestamp: now_millis(),
            });
        }
    }

    /// Gets a stream by ID.
    pub fn get_stream(&self, id: &str) -> Option<Arc<StreamState>> {
        self.stream_manager.get_stream(id)
    }

    /// Pushes an audio frame to a stream.
    ///
    /// Returns `Some(true)` if this was the first frame (stream just became ready),
    /// `Some(false)` if the stream exists but this wasn't the first frame,
    /// `None` if the stream was not found.
    pub fn push_frame(&self, stream_id: &str, data: Bytes) -> Option<bool> {
        self.stream_manager
            .get_stream(stream_id)
            .map(|stream| stream.push_frame(data))
    }

    /// Updates metadata for a stream.
    pub fn update_metadata(&self, stream_id: &str, metadata: StreamMetadata) {
        if let Some(stream) = self.stream_manager.get_stream(stream_id) {
            stream.update_metadata(metadata);
        }
    }

    /// Selects the optimal coordinator from a list of speaker IPs.
    ///
    /// Selection strategy (in order of preference):
    /// 1. Speaker that is already a Sonos group coordinator (can handle grouping)
    /// 2. First speaker in the list (deterministic fallback)
    ///
    /// # Arguments
    /// * `speaker_ips` - IPs of speakers to choose from
    ///
    /// # Returns
    /// Tuple of (coordinator_ip, coordinator_uuid, remaining_slave_ips), or None if
    /// no valid coordinator can be determined (no UUIDs available).
    fn select_coordinator(&self, speaker_ips: &[String]) -> Option<(String, String, Vec<String>)> {
        // Try to find a speaker that's already a Sonos group coordinator
        for ip in speaker_ips {
            if let Some(uuid) = self.sonos_state.get_coordinator_uuid_by_ip(ip) {
                let slaves: Vec<_> = speaker_ips.iter().filter(|s| *s != ip).cloned().collect();
                log::info!(
                    "[GroupSync] Selected coordinator {} (uuid={}) - existing Sonos coordinator",
                    ip,
                    uuid
                );
                return Some((ip.clone(), uuid, slaves));
            }
        }

        // Fallback: use first speaker if we can get its UUID from member lookup
        let first = speaker_ips.first()?;
        let uuid = self.sonos_state.get_member_uuid_by_ip(first)?;
        let slaves: Vec<_> = speaker_ips.iter().skip(1).cloned().collect();
        log::info!(
            "[GroupSync] Selected coordinator {} (uuid={}) - first speaker fallback",
            first,
            uuid
        );
        Some((first.clone(), uuid, slaves))
    }

    /// Joins a slave speaker to an active coordinator for synchronized playback.
    ///
    /// This creates a playback session with `GroupRole::Slave` and uses the x-rincon
    /// protocol to sync the slave's playback timing to the coordinator.
    ///
    /// # Arguments
    /// * `slave_ip` - IP address of the speaker to join as slave
    /// * `coordinator_ip` - IP address of the coordinator speaker
    /// * `coordinator_uuid` - UUID of the coordinator (RINCON_xxx format)
    /// * `stream_id` - The stream ID being played
    /// * `codec` - Audio codec (for session tracking)
    async fn join_slave_to_coordinator(
        &self,
        slave_ip: &str,
        coordinator_ip: &str,
        coordinator_uuid: &str,
        stream_id: &str,
        codec: AudioCodec,
    ) -> PlaybackResult {
        log::debug!(
            "[GroupSync] Joining slave {} to coordinator {} (uuid={})",
            slave_ip,
            coordinator_ip,
            coordinator_uuid
        );

        let key = PlaybackSessionKey::new(stream_id, slave_ip);

        // Check for existing sessions on this speaker and handle appropriately
        if let Some(existing) = self.playback_sessions.get(&key) {
            // Session exists for same (stream, speaker) - check if already correctly configured
            let dominated_correctly = existing.role == GroupRole::Slave
                && existing.coordinator_uuid.as_deref() == Some(coordinator_uuid);

            if dominated_correctly {
                log::debug!(
                    "[GroupSync] Slave {} already joined to coordinator {}, skipping",
                    slave_ip,
                    coordinator_uuid
                );
                return PlaybackResult {
                    speaker_ip: slave_ip.to_string(),
                    success: true,
                    stream_url: Some(format!("x-rincon:{}", coordinator_uuid)),
                    error: None,
                };
            }

            // Coordinator changed or role changed (was Coordinator, now Slave) - need to re-join
            log::info!(
                "[GroupSync] Slave {} re-routing: role {:?} -> Slave, coordinator {:?} -> {}",
                slave_ip,
                existing.role,
                existing.coordinator_uuid,
                coordinator_uuid
            );
            drop(existing); // Release DashMap ref before mutation
            self.playback_sessions.remove(&key);

            // Leave current group/stop before re-joining
            if let Err(e) = self.sonos.leave_group(slave_ip).await {
                log::warn!(
                    "[GroupSync] Failed to unjoin {} before re-route: {}",
                    slave_ip,
                    e
                );
            }
            // No PlaybackStopped event - same stream continues with new coordinator
        } else {
            // Check if this speaker is playing a different stream - clean up first
            let existing_other_stream = self
                .playback_sessions
                .iter()
                .find(|r| r.key().speaker_ip == slave_ip)
                .map(|r| (r.key().clone(), r.value().stream_id.clone()));

            if let Some((old_key, old_stream_id)) = existing_other_stream {
                log::info!(
                    "[GroupSync] Slave {} switching from stream {} to {} - stopping old playback",
                    slave_ip,
                    old_stream_id,
                    stream_id
                );

                self.playback_sessions.remove(&old_key);

                // Best-effort unjoin/stop - ignore errors
                if let Err(e) = self.sonos.leave_group(slave_ip).await {
                    log::warn!("[GroupSync] Failed to unjoin slave {}: {}", slave_ip, e);
                }

                self.emit_event(StreamEvent::PlaybackStopped {
                    stream_id: old_stream_id,
                    speaker_ip: slave_ip.to_string(),
                    reason: None,
                    timestamp: now_millis(),
                });
            }
        }

        // Capture original group membership before joining the streaming group.
        // This allows us to restore the speaker to its original group after streaming ends.
        let original_coordinator_uuid = self
            .sonos_state
            .get_original_coordinator_for_slave(slave_ip);

        // Join the slave to the coordinator
        match self.sonos.join_group(slave_ip, coordinator_uuid).await {
            Ok(()) => {
                let rincon_uri = format!("x-rincon:{}", coordinator_uuid);

                self.playback_sessions.insert(
                    key,
                    PlaybackSession {
                        stream_id: stream_id.to_string(),
                        speaker_ip: slave_ip.to_string(),
                        stream_url: rincon_uri.clone(),
                        codec,
                        role: GroupRole::Slave,
                        coordinator_ip: Some(coordinator_ip.to_string()),
                        coordinator_uuid: Some(coordinator_uuid.to_string()),
                        original_coordinator_uuid,
                    },
                );

                self.emit_event(StreamEvent::PlaybackStarted {
                    stream_id: stream_id.to_string(),
                    speaker_ip: slave_ip.to_string(),
                    stream_url: rincon_uri.clone(),
                    timestamp: now_millis(),
                });

                log::info!(
                    "[GroupSync] Slave {} joined coordinator {} successfully",
                    slave_ip,
                    coordinator_ip
                );

                // Subscribe to RenderingControl for all speakers in this sync session
                // This enables per-speaker volume/mute events from the Sonos app
                self.subscribe_rendering_control_for_sync_session(stream_id)
                    .await;

                PlaybackResult {
                    speaker_ip: slave_ip.to_string(),
                    success: true,
                    stream_url: Some(rincon_uri),
                    error: None,
                }
            }
            Err(e) => {
                log::warn!(
                    "[GroupSync] Failed to join slave {} to coordinator {}: {}",
                    slave_ip,
                    coordinator_ip,
                    e
                );
                PlaybackResult {
                    speaker_ip: slave_ip.to_string(),
                    success: false,
                    stream_url: None,
                    error: Some(format!("Failed to join group: {}", e)),
                }
            }
        }
    }

    /// Starts playback of a stream on multiple Sonos speakers.
    ///
    /// When `sync_speakers` is true and multiple speakers are selected, uses Sonos's
    /// native group coordination:
    /// - One speaker becomes the "coordinator" and receives the actual stream URL
    /// - Other speakers become "slaves" that sync to the coordinator via x-rincon protocol
    /// - This ensures all speakers play audio in perfect sync
    ///
    /// When `sync_speakers` is false, each speaker receives independent streams
    /// (may have slight audio drift between speakers).
    ///
    /// For single speakers, plays directly without grouping regardless of sync setting.
    ///
    /// Returns results for each speaker (best-effort: continues on individual failures).
    /// Each successful speaker gets a `StreamEvent::PlaybackStarted` event.
    ///
    /// # Arguments
    /// * `speaker_ips` - IP addresses of the Sonos speakers
    /// * `stream_id` - The stream ID to play
    /// * `metadata` - Optional initial metadata to display on Sonos
    /// * `artwork_url` - URL for album artwork in Sonos DIDL-Lite metadata
    /// * `sync_speakers` - Whether to synchronize multi-speaker playback
    pub async fn start_playback_multi(
        &self,
        speaker_ips: &[String],
        stream_id: &str,
        metadata: Option<&StreamMetadata>,
        artwork_url: &str,
        sync_speakers: bool,
    ) -> Vec<PlaybackResult> {
        // Handle empty case
        if speaker_ips.is_empty() {
            return vec![];
        }

        // Get stream state for codec and audio format
        let stream_state = self.get_stream(stream_id);

        let codec = stream_state
            .as_ref()
            .map(|s| s.codec)
            .unwrap_or(AudioCodec::Aac);

        let audio_format = stream_state
            .as_ref()
            .map(|s| s.audio_format)
            .unwrap_or_default();

        let url_builder = self.network.url_builder();
        let stream_url = url_builder.stream_url(stream_id);

        // Single speaker: no grouping needed, use direct playback
        if speaker_ips.len() == 1 {
            let result = self
                .start_single_playback(SinglePlaybackParams {
                    speaker_ip: &speaker_ips[0],
                    stream_id,
                    stream_url: &stream_url,
                    codec,
                    audio_format: &audio_format,
                    artwork_url,
                    metadata,
                })
                .await;
            return vec![result];
        }

        // Multiple speakers: check sync preference
        if !sync_speakers {
            log::info!(
                "[GroupSync] Sync disabled, using independent streams for {} speakers",
                speaker_ips.len()
            );
            return self
                .start_playback_multi_legacy(MultiPlaybackParams {
                    speaker_ips,
                    stream_id,
                    stream_url: &stream_url,
                    codec,
                    audio_format: &audio_format,
                    artwork_url,
                    metadata,
                })
                .await;
        }

        // Sync enabled: use synchronized group playback
        // Try to select a coordinator for group sync
        let Some((coordinator_ip, coordinator_uuid, slave_ips)) =
            self.select_coordinator(speaker_ips)
        else {
            // Fallback: can't determine UUIDs, use legacy sequential approach
            log::warn!(
                "[GroupSync] Cannot determine coordinator UUID, falling back to sequential playback"
            );
            return self
                .start_playback_multi_legacy(MultiPlaybackParams {
                    speaker_ips,
                    stream_id,
                    stream_url: &stream_url,
                    codec,
                    audio_format: &audio_format,
                    artwork_url,
                    metadata,
                })
                .await;
        };

        log::info!(
            "[GroupSync] Starting synchronized playback: coordinator={}, slaves={:?}, stream={}",
            coordinator_ip,
            slave_ips,
            stream_id
        );

        let mut results = Vec::with_capacity(speaker_ips.len());

        // Step 1: Start the coordinator with the actual stream URL
        let coordinator_result = self
            .start_single_playback(SinglePlaybackParams {
                speaker_ip: &coordinator_ip,
                stream_id,
                stream_url: &stream_url,
                codec,
                audio_format: &audio_format,
                artwork_url,
                metadata,
            })
            .await;

        if !coordinator_result.success {
            // Coordinator failed - can't proceed with group sync
            log::error!(
                "[GroupSync] Coordinator {} failed to start, aborting group sync",
                coordinator_ip
            );
            results.push(coordinator_result);

            // Return failure results for all slaves too
            for slave_ip in &slave_ips {
                results.push(PlaybackResult {
                    speaker_ip: slave_ip.clone(),
                    success: false,
                    stream_url: None,
                    error: Some("Coordinator failed to start".to_string()),
                });
            }
            return results;
        }

        results.push(coordinator_result);

        // Step 2: Join all slaves to the coordinator
        for slave_ip in slave_ips {
            let result = self
                .join_slave_to_coordinator(
                    &slave_ip,
                    &coordinator_ip,
                    &coordinator_uuid,
                    stream_id,
                    codec,
                )
                .await;
            results.push(result);
        }

        log::info!(
            "[GroupSync] Synchronized playback started: {} speakers, stream={}",
            results.iter().filter(|r| r.success).count(),
            stream_id
        );

        results
    }

    /// Legacy playback method: sends stream URL to each speaker independently.
    ///
    /// Used as fallback when group coordination is not possible (e.g., UUID lookup fails).
    /// Note: This may result in audio sync drift between speakers.
    async fn start_playback_multi_legacy(
        &self,
        params: MultiPlaybackParams<'_>,
    ) -> Vec<PlaybackResult> {
        let MultiPlaybackParams {
            speaker_ips,
            stream_id,
            stream_url,
            codec,
            audio_format,
            artwork_url,
            metadata,
        } = params;

        let mut results = Vec::with_capacity(speaker_ips.len());

        for speaker_ip in speaker_ips {
            let result = self
                .start_single_playback(SinglePlaybackParams {
                    speaker_ip,
                    stream_id,
                    stream_url,
                    codec,
                    audio_format,
                    artwork_url,
                    metadata,
                })
                .await;
            results.push(result);
        }

        results
    }

    /// Starts playback on a single speaker.
    async fn start_single_playback(&self, params: SinglePlaybackParams<'_>) -> PlaybackResult {
        let SinglePlaybackParams {
            speaker_ip,
            stream_id,
            stream_url,
            codec,
            audio_format,
            artwork_url,
            metadata,
        } = params;

        log::debug!(
            "[Playback] start_single_playback called: speaker={}, stream={}",
            speaker_ip,
            stream_id
        );

        let key = PlaybackSessionKey::new(stream_id, speaker_ip);

        // Check if this exact (stream, speaker) pair already exists
        if let Some(existing) = self.playback_sessions.get(&key) {
            // If this is a Slave session, we need to reconfigure the transport.
            // A Slave's stream_url is x-rincon:... pointing to the coordinator.
            // To make this speaker an independent coordinator, we must:
            // 1. Detach from the current group
            // 2. Set the transport URI to the actual stream
            if existing.role == GroupRole::Slave {
                let old_coordinator = existing.coordinator_ip.clone();
                drop(existing); // Release DashMap borrow before mutation

                log::info!(
                    "[GroupSync] Promoting slave {} to coordinator for stream {} (was following {})",
                    speaker_ip,
                    stream_id,
                    old_coordinator.as_deref().unwrap_or("unknown")
                );

                // Best-effort leave_group - detach from coordinator
                if let Err(e) = self.sonos.leave_group(speaker_ip).await {
                    log::warn!(
                        "[GroupSync] Failed to detach slave {} from group: {}",
                        speaker_ip,
                        e
                    );
                }

                // Remove old slave session - coordinator session created below
                self.playback_sessions.remove(&key);

                // Fall through to play_uri setup below
            } else {
                // Coordinator session exists - check if Sonos is paused and needs a Play command.
                // This enables bi-directional control: user can resume from extension
                // after pausing from Sonos app.
                drop(existing); // Release DashMap borrow

                // Note: transport_states are keyed by speaker IP, not UUID.
                let transport_state = self
                    .sonos_state
                    .transport_states
                    .get(speaker_ip)
                    .map(|s| *s);

                // Send Play unless speaker is definitively already playing.
                // Use != Playing (not == Paused) to handle cache misses safely:
                // - If state is None: Play is safe, avoids stuck silence
                // - If state is Paused: Play is needed
                // - If state is Playing: skip to avoid duplicate command
                let already_playing = transport_state == Some(TransportState::Playing);

                if !already_playing {
                    log::info!(
                        "Speaker {} transport_state={:?}, sending Play command to resume stream {}",
                        speaker_ip,
                        transport_state,
                        stream_id
                    );
                    if let Err(e) = self.sonos.play(speaker_ip).await {
                        log::warn!("Failed to resume playback on {}: {}", speaker_ip, e);
                        return PlaybackResult {
                            speaker_ip: speaker_ip.to_string(),
                            success: false,
                            stream_url: None,
                            error: Some(format!("Failed to resume: {}", e)),
                        };
                    }
                } else {
                    log::debug!(
                        "Speaker {} already playing stream {}, skipping Play",
                        speaker_ip,
                        stream_id
                    );
                }

                return PlaybackResult {
                    speaker_ip: speaker_ip.to_string(),
                    success: true,
                    stream_url: Some(stream_url.to_string()),
                    error: None,
                };
            }
        }

        // Check if this speaker is already playing a DIFFERENT stream.
        // If so, we must explicitly stop the old playback first to avoid race conditions.
        // Without an explicit stop, Sonos may not cleanly switch sources when receiving
        // a new SetAVTransportURI while still consuming an active HTTP stream.
        let existing_session = self
            .playback_sessions
            .iter()
            .find(|r| r.key().speaker_ip == speaker_ip && r.key().stream_id != stream_id)
            .map(|r| (r.key().clone(), r.value().stream_id.clone()));

        if let Some((old_key, old_stream_id)) = existing_session {
            log::info!(
                "Speaker {} switching from stream {} to {} - stopping old playback first",
                speaker_ip,
                old_stream_id,
                stream_id
            );

            // Remove old session
            self.playback_sessions.remove(&old_key);

            // Best-effort stop - ignore errors (speaker might already be stopped)
            if let Err(e) = self.sonos.stop(speaker_ip).await {
                log::warn!("Failed to stop old playback on {}: {}", speaker_ip, e);
            }

            // Emit PlaybackStopped for the old stream so extension cleans up correctly
            // Reason is None here - extension will default to 'playback_stopped'
            self.emit_event(StreamEvent::PlaybackStopped {
                stream_id: old_stream_id,
                speaker_ip: speaker_ip.to_string(),
                reason: None,
                timestamp: now_millis(),
            });
        }

        log::info!("Starting playback: {} -> {}", speaker_ip, stream_url);

        match self
            .sonos
            .play_uri(
                speaker_ip,
                stream_url,
                codec,
                audio_format,
                metadata,
                artwork_url,
            )
            .await
        {
            Ok(()) => {
                // Look up speaker's UUID for cleanup operations
                let coordinator_uuid = self.sonos_state.get_member_uuid_by_ip(speaker_ip);

                // Capture original group membership for restoration after streaming ends.
                // This handles the edge case where a speaker that was a slave in an existing
                // Sonos group gets selected as the streaming coordinator (via fallback path).
                let original_coordinator_uuid = self
                    .sonos_state
                    .get_original_coordinator_for_slave(speaker_ip);

                // Record the playback session
                self.playback_sessions.insert(
                    key,
                    PlaybackSession {
                        stream_id: stream_id.to_string(),
                        speaker_ip: speaker_ip.to_string(),
                        stream_url: stream_url.to_string(),
                        codec,
                        role: GroupRole::Coordinator,
                        coordinator_ip: None,
                        coordinator_uuid,
                        original_coordinator_uuid,
                    },
                );

                // Broadcast playback started event
                self.emit_event(StreamEvent::PlaybackStarted {
                    stream_id: stream_id.to_string(),
                    speaker_ip: speaker_ip.to_string(),
                    stream_url: stream_url.to_string(),
                    timestamp: now_millis(),
                });

                PlaybackResult {
                    speaker_ip: speaker_ip.to_string(),
                    success: true,
                    stream_url: Some(stream_url.to_string()),
                    error: None,
                }
            }
            Err(e) => {
                log::warn!("Failed to start playback on {}: {}", speaker_ip, e);
                PlaybackResult {
                    speaker_ip: speaker_ip.to_string(),
                    success: false,
                    stream_url: None,
                    error: Some(e.to_string()),
                }
            }
        }
    }

    /// Starts playback of a stream on a single Sonos speaker.
    ///
    /// This is a convenience wrapper around `start_playback_multi` for single-speaker use.
    /// Maintains backward compatibility with existing code.
    ///
    /// # Arguments
    /// * `speaker_ip` - IP address of the Sonos speaker
    /// * `stream_id` - The stream ID to play
    /// * `metadata` - Optional initial metadata to display on Sonos
    /// * `artwork_url` - URL for album artwork in Sonos DIDL-Lite metadata
    pub async fn start_playback(
        &self,
        speaker_ip: &str,
        stream_id: &str,
        metadata: Option<&StreamMetadata>,
        artwork_url: &str,
    ) -> ThaumicResult<()> {
        let results = self
            .start_playback_multi(
                &[speaker_ip.to_string()],
                stream_id,
                metadata,
                artwork_url,
                false,
            )
            .await;

        if let Some(result) = results.first() {
            if result.success {
                Ok(())
            } else {
                Err(crate::error::ThaumicError::Soap(
                    result
                        .error
                        .clone()
                        .unwrap_or_else(|| "Unknown error".to_string()),
                ))
            }
        } else {
            Err(crate::error::ThaumicError::Soap(
                "No playback result".to_string(),
            ))
        }
    }

    /// Stops playback on a specific speaker for a specific stream.
    ///
    /// On success: removes the session(s), broadcasts `StreamEvent::PlaybackStopped` for each,
    /// returns the list of stopped speaker IPs.
    /// On failure (stop command fails or session not found): keeps session intact (if any),
    /// broadcasts `StreamEvent::PlaybackStopFailed`, returns empty list.
    /// Used for partial speaker removal in multi-group scenarios.
    ///
    /// # Arguments
    /// * `stream_id` - The stream ID
    /// * `speaker_ip` - IP address of the speaker to stop
    /// * `reason` - Optional reason for stopping (propagated to events)
    ///
    /// # Returns
    /// List of speaker IPs that were stopped. When stopping a coordinator, this includes
    /// all slaves that were also stopped. Empty if stop failed or session not found.
    pub async fn stop_playback_speaker(
        &self,
        stream_id: &str,
        speaker_ip: &str,
        reason: Option<SpeakerRemovalReason>,
    ) -> Vec<String> {
        let key = PlaybackSessionKey::new(stream_id, speaker_ip);

        // Get session to check role
        let session = match self.playback_sessions.get(&key) {
            Some(s) => s.clone(),
            None => {
                // Session not found - emit failure so client can clear pending state
                log::warn!(
                    "Stop requested for unknown session: stream={}, speaker={}",
                    stream_id,
                    speaker_ip
                );
                self.emit_event(StreamEvent::PlaybackStopFailed {
                    stream_id: stream_id.to_string(),
                    speaker_ip: speaker_ip.to_string(),
                    error: "Session not found".to_string(),
                    reason,
                    timestamp: now_millis(),
                });
                return Vec::new();
            }
        };

        match session.role {
            GroupRole::Slave => {
                // Slave: just unjoin this speaker, others continue playing
                self.stop_slave_speaker(stream_id, speaker_ip, reason).await
            }
            GroupRole::Coordinator => {
                // Coordinator: must unjoin all slaves first, then stop
                self.stop_coordinator_and_slaves(stream_id, speaker_ip, reason)
                    .await
            }
        }
    }

    /// Stops a slave speaker by unjoining it from the group.
    ///
    /// Only affects this speaker - the coordinator and other slaves continue playing.
    /// After unjoining, attempts to restore the speaker to its original Sonos group.
    ///
    /// # Returns
    /// List containing the stopped speaker IP on success, empty on failure.
    async fn stop_slave_speaker(
        &self,
        stream_id: &str,
        speaker_ip: &str,
        reason: Option<SpeakerRemovalReason>,
    ) -> Vec<String> {
        log::info!(
            "[GroupSync] Stopping slave speaker {} from stream {}",
            speaker_ip,
            stream_id
        );

        let key = PlaybackSessionKey::new(stream_id, speaker_ip);

        // Get restoration info before removing session
        let original_coordinator = self
            .playback_sessions
            .get(&key)
            .and_then(|s| s.original_coordinator_uuid.clone());

        // Unjoin the slave from the group
        match self.sonos.leave_group(speaker_ip).await {
            Ok(()) => {
                self.playback_sessions.remove(&key);

                // Unsubscribe from RenderingControl for this slave
                self.unsubscribe_rendering_control(speaker_ip).await;

                // Check if any slaves remain - if not, unsubscribe coordinator too
                let remaining_slaves = self
                    .playback_sessions
                    .iter()
                    .any(|r| r.key().stream_id == stream_id && r.value().role == GroupRole::Slave);

                if !remaining_slaves {
                    // Find and unsubscribe the coordinator
                    if let Some(coord_ip) = self
                        .playback_sessions
                        .iter()
                        .find(|r| {
                            r.key().stream_id == stream_id
                                && r.value().role == GroupRole::Coordinator
                        })
                        .map(|r| r.key().speaker_ip.clone())
                    {
                        self.unsubscribe_rendering_control(&coord_ip).await;
                    }
                }

                // Attempt to restore to original group (best-effort)
                if let Some(orig_uuid) = original_coordinator {
                    self.restore_original_group(speaker_ip, &orig_uuid).await;
                }

                self.emit_event(StreamEvent::PlaybackStopped {
                    stream_id: stream_id.to_string(),
                    speaker_ip: speaker_ip.to_string(),
                    reason,
                    timestamp: now_millis(),
                });

                // Clean up stream if this was the last session
                self.cleanup_stream_if_no_sessions(stream_id);

                vec![speaker_ip.to_string()]
            }
            Err(e) => {
                log::warn!("[GroupSync] Failed to unjoin slave {}: {}", speaker_ip, e);
                self.emit_event(StreamEvent::PlaybackStopFailed {
                    stream_id: stream_id.to_string(),
                    speaker_ip: speaker_ip.to_string(),
                    error: e.to_string(),
                    reason,
                    timestamp: now_millis(),
                });
                Vec::new()
            }
        }
    }

    /// Stops a coordinator speaker and all its associated slaves.
    ///
    /// This is a cascade operation:
    /// 1. Find all slaves joined to this coordinator
    /// 2. Unjoin each slave (make them standalone)
    /// 3. Restore each slave to their original Sonos group (best-effort)
    /// 4. Stop the coordinator
    ///
    /// # Returns
    /// List of stopped speaker IPs. On full success, includes slaves + coordinator.
    /// On partial failure (coordinator fails), includes only successfully stopped slaves.
    /// Empty only if no speakers were stopped.
    async fn stop_coordinator_and_slaves(
        &self,
        stream_id: &str,
        coordinator_ip: &str,
        reason: Option<SpeakerRemovalReason>,
    ) -> Vec<String> {
        log::info!(
            "[GroupSync] Stopping coordinator {} and its slaves from stream {}",
            coordinator_ip,
            stream_id
        );

        // Collect all stopped speaker IPs to return
        let mut stopped_ips: Vec<String> = Vec::new();

        // Find all slaves joined to this coordinator for this stream
        // Include original_coordinator_uuid for restoration after unjoining
        let slave_info: Vec<(PlaybackSessionKey, Option<String>)> = self
            .playback_sessions
            .iter()
            .filter(|r| {
                r.key().stream_id == stream_id
                    && r.value().role == GroupRole::Slave
                    && r.value().coordinator_ip.as_deref() == Some(coordinator_ip)
            })
            .map(|r| (r.key().clone(), r.value().original_coordinator_uuid.clone()))
            .collect();

        // Unjoin all slaves first, then restore to original groups
        for (slave_key, original_coordinator) in slave_info {
            log::debug!(
                "[GroupSync] Unjoining slave {} before stopping coordinator",
                slave_key.speaker_ip
            );

            // Best-effort unjoin - log but continue on failure
            if let Err(e) = self.sonos.leave_group(&slave_key.speaker_ip).await {
                log::warn!(
                    "[GroupSync] Failed to unjoin slave {} during coordinator stop: {}",
                    slave_key.speaker_ip,
                    e
                );
            }

            // Attempt to restore to original group (best-effort)
            if let Some(orig_uuid) = original_coordinator {
                self.restore_original_group(&slave_key.speaker_ip, &orig_uuid)
                    .await;
            }

            // Remove session and emit event regardless of SOAP result
            self.playback_sessions.remove(&slave_key);

            // Unsubscribe from RenderingControl for this slave
            self.unsubscribe_rendering_control(&slave_key.speaker_ip)
                .await;

            self.emit_event(StreamEvent::PlaybackStopped {
                stream_id: stream_id.to_string(),
                speaker_ip: slave_key.speaker_ip.clone(),
                reason,
                timestamp: now_millis(),
            });

            // Track this slave as stopped
            stopped_ips.push(slave_key.speaker_ip);
        }

        // Now stop the coordinator
        let coord_key = PlaybackSessionKey::new(stream_id, coordinator_ip);

        // Get session info before removing (needed for switch_to_queue and restoration)
        // Try session first, fallback to live topology if session didn't have coordinator_uuid
        let (coordinator_uuid, original_coordinator_uuid) = self
            .playback_sessions
            .get(&coord_key)
            .map(|s| {
                (
                    s.coordinator_uuid.clone(),
                    s.original_coordinator_uuid.clone(),
                )
            })
            .unwrap_or((None, None));

        let coordinator_uuid = coordinator_uuid
            .or_else(|| self.sonos_state.get_coordinator_uuid_by_ip(coordinator_ip));

        match self.sonos.stop(coordinator_ip).await {
            Ok(()) => {
                self.playback_sessions.remove(&coord_key);

                // Unsubscribe from RenderingControl for the coordinator
                self.unsubscribe_rendering_control(coordinator_ip).await;

                // Switch to queue as cleanup (clears stale stream source in Sonos UI)
                // This prevents unexpected resume when user interacts with Sonos app
                if let Some(uuid) = coordinator_uuid {
                    if let Err(e) = self.sonos.switch_to_queue(coordinator_ip, &uuid).await {
                        log::warn!(
                            "[GroupSync] Failed to switch coordinator {} to queue: {}",
                            coordinator_ip,
                            e
                        );
                    }
                }

                // Restore coordinator to original group if it was a slave before streaming
                // (edge case: fallback coordinator selection picked a speaker from an existing group)
                if let Some(orig_uuid) = original_coordinator_uuid {
                    self.restore_original_group(coordinator_ip, &orig_uuid)
                        .await;
                }

                self.emit_event(StreamEvent::PlaybackStopped {
                    stream_id: stream_id.to_string(),
                    speaker_ip: coordinator_ip.to_string(),
                    reason,
                    timestamp: now_millis(),
                });

                // Clean up stream if this was the last session
                self.cleanup_stream_if_no_sessions(stream_id);

                // Track coordinator as stopped
                stopped_ips.push(coordinator_ip.to_string());
                stopped_ips
            }
            Err(e) => {
                log::warn!(
                    "[GroupSync] Failed to stop coordinator {}: {}",
                    coordinator_ip,
                    e
                );
                self.emit_event(StreamEvent::PlaybackStopFailed {
                    stream_id: stream_id.to_string(),
                    speaker_ip: coordinator_ip.to_string(),
                    error: e.to_string(),
                    reason,
                    timestamp: now_millis(),
                });
                // Return slaves that were successfully stopped (sessions removed, events
                // emitted). Caller needs this to clean up latency monitors. Coordinator
                // is NOT included since it failed to stop.
                stopped_ips
            }
        }
    }

    /// Stops playback on a speaker (by speaker IP only, for backward compatibility).
    ///
    /// Finds the session by speaker IP and removes it.
    /// Broadcasts a `StreamEvent::PlaybackStopped` event.
    ///
    /// Reserved for future use (partial speaker removal from extension).
    #[allow(dead_code)]
    pub async fn stop_playback(&self, speaker_ip: &str) -> ThaumicResult<()> {
        // Find the session key for this speaker
        let key = self
            .playback_sessions
            .iter()
            .find(|r| r.key().speaker_ip == speaker_ip)
            .map(|r| r.key().clone());

        let stream_id = key.as_ref().map(|k| k.stream_id.clone());

        if let Some(key) = key {
            self.playback_sessions.remove(&key);
        }

        self.sonos.stop(speaker_ip).await?;

        // Broadcast playback stopped event (only if we had a session)
        if let Some(stream_id) = stream_id {
            self.emit_event(StreamEvent::PlaybackStopped {
                stream_id,
                speaker_ip: speaker_ip.to_string(),
                reason: None,
                timestamp: now_millis(),
            });
        }

        Ok(())
    }

    /// Gets all active playback sessions.
    pub fn get_all_sessions(&self) -> Vec<PlaybackSession> {
        self.playback_sessions
            .iter()
            .map(|r| r.value().clone())
            .collect()
    }

    /// Stops all playback and clears all streams.
    ///
    /// This performs a complete cleanup by calling `remove_stream_async()` for
    /// each active stream, which stops speakers and broadcasts ended events.
    ///
    /// Returns the number of streams that were cleared.
    pub async fn clear_all(&self) -> usize {
        let stream_ids = self.stream_manager.list_stream_ids();
        let count = stream_ids.len();

        for stream_id in stream_ids {
            self.remove_stream_async(&stream_id).await;
        }

        log::info!(
            "[StreamCoordinator] Cleared all: {} stream(s) removed",
            count
        );

        count
    }

    /// Returns the number of active streams.
    #[must_use]
    pub fn stream_count(&self) -> usize {
        self.stream_manager.stream_count()
    }

    /// Returns a reference to the stream manager.
    ///
    /// Used by services that need access to stream timing information
    /// (e.g., LatencyMonitor).
    #[must_use]
    pub fn stream_manager(&self) -> Arc<StreamManager> {
        Arc::clone(&self.stream_manager)
    }

    /// Handles a source change event for a speaker.
    ///
    /// When a speaker switches to another source (Spotify, AirPlay, etc.),
    /// this cleans up the playback session and emits `PlaybackStopped`.
    /// If this was the last speaker for the stream, the stream is also ended.
    ///
    /// Unlike `stop_playback_speaker`, this does NOT send a SOAP stop command
    /// since the speaker has already stopped playing our stream.
    ///
    /// # Arguments
    /// * `speaker_ip` - IP address of the speaker that changed source
    ///
    /// # Returns
    /// `true` if a session was found and removed, `false` otherwise.
    pub fn handle_source_changed(&self, speaker_ip: &str) -> bool {
        // Find the session for this speaker
        let key = self
            .playback_sessions
            .iter()
            .find(|r| r.key().speaker_ip == speaker_ip)
            .map(|r| r.key().clone());

        let Some(key) = key else {
            log::debug!(
                "Source changed on {} but no active playback session found",
                speaker_ip
            );
            return false;
        };

        let stream_id = key.stream_id.clone();

        // Remove the session (no SOAP command needed - speaker already stopped)
        self.playback_sessions.remove(&key);

        log::info!(
            "Removed playback session for {} due to source change (stream: {})",
            speaker_ip,
            stream_id
        );

        // Emit PlaybackStopped with source_changed reason
        self.emit_event(StreamEvent::PlaybackStopped {
            stream_id: stream_id.clone(),
            speaker_ip: speaker_ip.to_string(),
            reason: Some(SpeakerRemovalReason::SourceChanged),
            timestamp: now_millis(),
        });

        // Clean up stream if this was the last session
        self.cleanup_stream_if_no_sessions(&stream_id);

        true
    }

    /// Handles HTTP resume event from a speaker.
    ///
    /// Called by the HTTP layer when a speaker reconnects to an existing stream.
    /// This is the only place that sends Play commands on HTTP resume, maintaining
    /// separation of concerns (HTTP layer serves audio, coordinator controls playback).
    ///
    /// # Arguments
    /// * `speaker_ip` - IP address of the speaker that resumed HTTP connection
    ///
    /// # Returns
    /// `true` if a Play command was sent, `false` otherwise.
    pub async fn on_http_resume(&self, speaker_ip: &str) -> bool {
        // Send Play unless speaker is definitively already playing.
        // This handles Sonos-app resume where Sonos connects before transitioning to PLAYING.
        //
        // We use != Playing rather than == Paused because:
        // - If state is None (cache miss, service restart): Play is safe, avoids stuck silence
        // - If state is Paused: Play is needed
        // - If state is Stopped/Transitioning: Play is safe
        // - If state is Playing: skip to avoid duplicate command
        //
        // Sending Play to an already-playing speaker is harmless (Sonos no-ops it),
        // but NOT sending Play to a paused speaker causes stuck silence.
        let transport_state = self
            .sonos_state
            .transport_states
            .get(speaker_ip)
            .map(|s| *s);

        if transport_state != Some(TransportState::Playing) {
            log::info!(
                "[Resume] Speaker {} transport_state={:?} on HTTP resume, sending Play command",
                speaker_ip,
                transport_state
            );
            if let Err(e) = self.sonos.play(speaker_ip).await {
                log::warn!(
                    "[Resume] Play command on HTTP resume failed for {}: {}",
                    speaker_ip,
                    e
                );
            }
            true
        } else {
            log::debug!(
                "[Resume] Speaker {} already playing on HTTP resume, skipping Play",
                speaker_ip
            );
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─────────────────────────────────────────────────────────────────────────
    // GroupRole Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn group_role_default_is_coordinator() {
        assert_eq!(GroupRole::default(), GroupRole::Coordinator);
    }

    #[test]
    fn group_role_equality() {
        assert_eq!(GroupRole::Coordinator, GroupRole::Coordinator);
        assert_eq!(GroupRole::Slave, GroupRole::Slave);
        assert_ne!(GroupRole::Coordinator, GroupRole::Slave);
    }

    #[test]
    fn group_role_serializes_to_snake_case() {
        assert_eq!(
            serde_json::to_string(&GroupRole::Coordinator).unwrap(),
            "\"coordinator\""
        );
        assert_eq!(
            serde_json::to_string(&GroupRole::Slave).unwrap(),
            "\"slave\""
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PlaybackSessionKey Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn playback_session_key_equality() {
        let key1 = PlaybackSessionKey::new("stream1", "192.168.1.100");
        let key2 = PlaybackSessionKey::new("stream1", "192.168.1.100");
        let key3 = PlaybackSessionKey::new("stream1", "192.168.1.101");
        let key4 = PlaybackSessionKey::new("stream2", "192.168.1.100");

        assert_eq!(key1, key2);
        assert_ne!(key1, key3); // different speaker
        assert_ne!(key1, key4); // different stream
    }

    #[test]
    fn playback_session_key_hash_consistent() {
        use std::collections::HashMap;

        let mut map = HashMap::new();
        let key1 = PlaybackSessionKey::new("stream1", "192.168.1.100");
        map.insert(key1.clone(), "value1");

        let key2 = PlaybackSessionKey::new("stream1", "192.168.1.100");
        assert_eq!(map.get(&key2), Some(&"value1"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PlaybackSession Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn playback_session_coordinator_has_no_coordinator_ip() {
        let session = PlaybackSession {
            stream_id: "stream1".to_string(),
            speaker_ip: "192.168.1.100".to_string(),
            stream_url: "http://server:8080/stream/abc".to_string(),
            codec: AudioCodec::Aac,
            role: GroupRole::Coordinator,
            coordinator_ip: None,
            coordinator_uuid: Some("RINCON_XXX".to_string()),
            original_coordinator_uuid: None,
        };

        assert_eq!(session.role, GroupRole::Coordinator);
        assert!(session.coordinator_ip.is_none());
        assert!(session.original_coordinator_uuid.is_none());
    }

    #[test]
    fn playback_session_slave_has_coordinator_info() {
        let session = PlaybackSession {
            stream_id: "stream1".to_string(),
            speaker_ip: "192.168.1.101".to_string(),
            stream_url: "x-rincon:RINCON_XXX".to_string(),
            codec: AudioCodec::Aac,
            role: GroupRole::Slave,
            coordinator_ip: Some("192.168.1.100".to_string()),
            coordinator_uuid: Some("RINCON_XXX".to_string()),
            original_coordinator_uuid: None,
        };

        assert_eq!(session.role, GroupRole::Slave);
        assert_eq!(session.coordinator_ip, Some("192.168.1.100".to_string()));
        assert!(session.stream_url.starts_with("x-rincon:"));
    }

    #[test]
    fn playback_session_slave_stores_original_coordinator() {
        let session = PlaybackSession {
            stream_id: "stream1".to_string(),
            speaker_ip: "192.168.1.101".to_string(),
            stream_url: "x-rincon:RINCON_STREAMING".to_string(),
            codec: AudioCodec::Aac,
            role: GroupRole::Slave,
            coordinator_ip: Some("192.168.1.100".to_string()),
            coordinator_uuid: Some("RINCON_STREAMING".to_string()),
            original_coordinator_uuid: Some("RINCON_ORIGINAL".to_string()),
        };

        assert_eq!(session.role, GroupRole::Slave);
        assert_eq!(
            session.original_coordinator_uuid,
            Some("RINCON_ORIGINAL".to_string())
        );
    }

    #[test]
    fn playback_session_coordinator_can_have_original_group() {
        // Edge case: fallback coordinator selection picks a speaker that was
        // a slave in an existing Sonos group. It becomes the streaming coordinator
        // but should be restored to its original group after streaming ends.
        let session = PlaybackSession {
            stream_id: "stream1".to_string(),
            speaker_ip: "192.168.1.101".to_string(),
            stream_url: "http://server:8080/stream/abc".to_string(),
            codec: AudioCodec::Aac,
            role: GroupRole::Coordinator,
            coordinator_ip: None,
            coordinator_uuid: Some("RINCON_KITCHEN".to_string()),
            original_coordinator_uuid: Some("RINCON_LIVING".to_string()), // Was slave of Living Room
        };

        assert_eq!(session.role, GroupRole::Coordinator);
        assert_eq!(
            session.original_coordinator_uuid,
            Some("RINCON_LIVING".to_string())
        );
    }

    #[test]
    fn playback_session_serializes_correctly() {
        let session = PlaybackSession {
            stream_id: "stream1".to_string(),
            speaker_ip: "192.168.1.100".to_string(),
            stream_url: "http://server:8080/stream".to_string(),
            codec: AudioCodec::Aac,
            role: GroupRole::Coordinator,
            coordinator_ip: None,
            coordinator_uuid: Some("RINCON_XXX".to_string()),
            original_coordinator_uuid: None,
        };

        let json = serde_json::to_value(&session).unwrap();
        assert_eq!(json["role"], "coordinator");
        assert_eq!(json["streamId"], "stream1");
        assert_eq!(json["speakerIp"], "192.168.1.100");
        // coordinator_ip should be omitted when None (skip_serializing_if)
        assert!(json.get("coordinatorIp").is_none());
        // original_coordinator_uuid should be omitted when None (skip_serializing_if)
        assert!(json.get("originalCoordinatorUuid").is_none());
    }

    #[test]
    fn playback_session_slave_serializes_with_coordinator_ip() {
        let session = PlaybackSession {
            stream_id: "stream1".to_string(),
            speaker_ip: "192.168.1.101".to_string(),
            stream_url: "x-rincon:RINCON_XXX".to_string(),
            codec: AudioCodec::Aac,
            role: GroupRole::Slave,
            coordinator_ip: Some("192.168.1.100".to_string()),
            coordinator_uuid: Some("RINCON_XXX".to_string()),
            original_coordinator_uuid: Some("RINCON_ORIGINAL".to_string()),
        };

        let json = serde_json::to_value(&session).unwrap();
        assert_eq!(json["role"], "slave");
        assert_eq!(json["coordinatorIp"], "192.168.1.100");
        assert_eq!(json["originalCoordinatorUuid"], "RINCON_ORIGINAL");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // x-rincon URI Handling Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn x_rincon_uri_detection() {
        assert!("x-rincon:RINCON_XXX".starts_with("x-rincon:"));
        assert!("x-rincon:RINCON_542A1BD0029202400".starts_with("x-rincon:"));
        assert!(!"http://server:8080/stream".starts_with("x-rincon:"));
        assert!(!"x-rincon-mp3radio://server:8080/stream".starts_with("x-rincon:"));
        assert!(!"x-rincon-queue:RINCON_XXX#0".starts_with("x-rincon:"));
    }

    #[test]
    fn x_rincon_uri_not_transformed_for_pcm() {
        // This tests the fix for the bug where x-rincon URIs were incorrectly
        // transformed by build_sonos_stream_uri for PCM/FLAC codecs
        let rincon_uri = "x-rincon:RINCON_542A1BD0029202400";

        // The x-rincon URI should NOT be passed to build_sonos_stream_uri
        // because it would produce incorrect results like "x-rincon:RINCON_XXX.wav"
        // Instead, get_expected_stream should return it unchanged

        // Simulate the correct logic from get_expected_stream
        let result = if rincon_uri.starts_with("x-rincon:") {
            rincon_uri.to_string()
        } else {
            build_sonos_stream_uri(rincon_uri, AudioCodec::Pcm)
        };

        assert_eq!(result, "x-rincon:RINCON_542A1BD0029202400");
        assert!(!result.ends_with(".wav")); // Should NOT have .wav extension
    }

    #[test]
    fn regular_stream_url_transformed_for_pcm() {
        let stream_url = "http://192.168.1.50:8080/stream/abc123";

        let result = if stream_url.starts_with("x-rincon:") {
            stream_url.to_string()
        } else {
            build_sonos_stream_uri(stream_url, AudioCodec::Pcm)
        };

        assert!(result.ends_with(".wav"));
        assert_eq!(result, "http://192.168.1.50:8080/stream/abc123.wav");
    }

    #[test]
    fn regular_stream_url_transformed_for_aac() {
        let stream_url = "http://192.168.1.50:8080/stream/abc123";

        let result = if stream_url.starts_with("x-rincon:") {
            stream_url.to_string()
        } else {
            build_sonos_stream_uri(stream_url, AudioCodec::Aac)
        };

        assert!(result.starts_with("x-rincon-mp3radio://"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Volume/Mute Routing Tests
    // ─────────────────────────────────────────────────────────────────────────

    mod volume_routing {
        use super::*;
        use crate::error::SoapResult;
        use crate::sonos::traits::SonosVolumeControl;
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

        /// Creates a coordinator with a DashMap we can populate for testing.
        fn create_test_sessions() -> DashMap<PlaybackSessionKey, PlaybackSession> {
            DashMap::new()
        }

        /// Creates a PlaybackSession for testing with sensible defaults.
        ///
        /// - Coordinators get HTTP stream URLs
        /// - Slaves get x-rincon URLs and coordinator_ip set to "192.168.1.100"
        fn create_test_session(
            stream_id: &str,
            speaker_ip: &str,
            role: GroupRole,
        ) -> PlaybackSession {
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

        // ───────────────────────────────────────────────────────────────────
        // Tests for is_speaker_in_sync_session logic
        // ───────────────────────────────────────────────────────────────────

        #[test]
        fn sync_detection_returns_none_for_unknown_speaker() {
            let sessions = create_test_sessions();
            assert_eq!(
                is_speaker_in_sync_session_impl(&sessions, "192.168.1.100"),
                None
            );
        }

        #[test]
        fn sync_detection_returns_false_for_solo_coordinator() {
            let sessions = create_test_sessions();
            sessions.insert(
                PlaybackSessionKey::new("stream1", "192.168.1.100"),
                create_test_session("stream1", "192.168.1.100", GroupRole::Coordinator),
            );

            // Single coordinator = not a sync session
            assert_eq!(
                is_speaker_in_sync_session_impl(&sessions, "192.168.1.100"),
                Some(false)
            );
        }

        #[test]
        fn sync_detection_returns_true_when_slaves_exist() {
            let sessions = create_test_sessions();

            // Coordinator
            sessions.insert(
                PlaybackSessionKey::new("stream1", "192.168.1.100"),
                create_test_session("stream1", "192.168.1.100", GroupRole::Coordinator),
            );

            // Slave joined to coordinator
            sessions.insert(
                PlaybackSessionKey::new("stream1", "192.168.1.101"),
                create_test_session("stream1", "192.168.1.101", GroupRole::Slave),
            );

            // Both coordinator and slave are in sync session
            assert_eq!(
                is_speaker_in_sync_session_impl(&sessions, "192.168.1.100"),
                Some(true)
            );
            assert_eq!(
                is_speaker_in_sync_session_impl(&sessions, "192.168.1.101"),
                Some(true)
            );
        }

        // ───────────────────────────────────────────────────────────────────
        // Tests for volume/mute routing via StreamCoordinator
        // ───────────────────────────────────────────────────────────────────
        //
        // These tests exercise the actual StreamCoordinator::*_routed methods
        // to verify routing decisions are wired correctly end-to-end.

        use crate::context::NetworkContext;
        use crate::events::NoopEventEmitter;
        use crate::sonos::gena::GenaSubscriptionManager;
        use crate::sonos::traits::SonosPlayback;
        use crate::sonos::types::PositionInfo;
        use crate::state::{SonosState, StreamingConfig};

        /// Mock SonosPlayback for constructing StreamCoordinator in tests.
        struct MockSonosPlayback;

        #[async_trait]
        impl SonosPlayback for MockSonosPlayback {
            async fn play_uri(
                &self,
                _: &str,
                _: &str,
                _: AudioCodec,
                _: &AudioFormat,
                _: Option<&StreamMetadata>,
                _: &str,
            ) -> SoapResult<()> {
                Ok(())
            }
            async fn play(&self, _: &str) -> SoapResult<()> {
                Ok(())
            }
            async fn stop(&self, _: &str) -> SoapResult<()> {
                Ok(())
            }
            async fn switch_to_queue(&self, _: &str, _: &str) -> SoapResult<()> {
                Ok(())
            }
            async fn get_position_info(&self, _: &str) -> SoapResult<PositionInfo> {
                Ok(PositionInfo {
                    track: 1,
                    track_duration: "0:00:00".to_string(),
                    track_uri: String::new(),
                    rel_time: "0:00:00".to_string(),
                    rel_time_ms: 0,
                })
            }
            async fn join_group(&self, _: &str, _: &str) -> SoapResult<()> {
                Ok(())
            }
            async fn leave_group(&self, _: &str) -> SoapResult<()> {
                Ok(())
            }
        }

        /// Creates a StreamCoordinator with test dependencies.
        fn create_test_coordinator() -> StreamCoordinator {
            // Create a real GenaSubscriptionManager for tests (receiver is dropped)
            let (gena_manager, _rx) = GenaSubscriptionManager::new(reqwest::Client::new());
            StreamCoordinator::new(
                Arc::new(MockSonosPlayback),
                Arc::new(SonosState::default()),
                NetworkContext::for_test(),
                Arc::new(NoopEventEmitter),
                StreamingConfig::default(),
                Arc::new(gena_manager),
            )
        }

        #[tokio::test]
        async fn set_volume_routed_uses_speaker_control_in_sync_session() {
            let coordinator = create_test_coordinator();
            let mock = MockVolumeControl::new();

            // Set up sync session (coordinator + slave)
            coordinator.insert_test_session(create_test_session(
                "stream1",
                "192.168.1.100",
                GroupRole::Coordinator,
            ));
            coordinator.insert_test_session(create_test_session(
                "stream1",
                "192.168.1.101",
                GroupRole::Slave,
            ));

            // Call the actual routing method
            coordinator
                .set_volume_routed(&mock, "192.168.1.100", 75)
                .await
                .unwrap();

            assert!(mock.set_speaker_volume_called.load(Ordering::SeqCst));
            assert!(!mock.set_group_volume_called.load(Ordering::SeqCst));
        }

        #[tokio::test]
        async fn set_volume_routed_uses_group_control_for_solo_speaker() {
            let coordinator = create_test_coordinator();
            let mock = MockVolumeControl::new();

            // Solo coordinator (no slaves)
            coordinator.insert_test_session(create_test_session(
                "stream1",
                "192.168.1.100",
                GroupRole::Coordinator,
            ));

            coordinator
                .set_volume_routed(&mock, "192.168.1.100", 75)
                .await
                .unwrap();

            assert!(!mock.set_speaker_volume_called.load(Ordering::SeqCst));
            assert!(mock.set_group_volume_called.load(Ordering::SeqCst));
        }

        #[tokio::test]
        async fn set_volume_routed_uses_group_control_for_unknown_speaker() {
            let coordinator = create_test_coordinator();
            let mock = MockVolumeControl::new();
            // No sessions - speaker not in any session

            coordinator
                .set_volume_routed(&mock, "192.168.1.100", 75)
                .await
                .unwrap();

            // Unknown speaker defaults to group control
            assert!(!mock.set_speaker_volume_called.load(Ordering::SeqCst));
            assert!(mock.set_group_volume_called.load(Ordering::SeqCst));
        }

        #[tokio::test]
        async fn get_volume_routed_uses_speaker_control_in_sync_session() {
            let coordinator = create_test_coordinator();
            let mock = MockVolumeControl::new();

            // Set up sync session
            coordinator.insert_test_session(create_test_session(
                "stream1",
                "192.168.1.100",
                GroupRole::Coordinator,
            ));
            coordinator.insert_test_session(create_test_session(
                "stream1",
                "192.168.1.101",
                GroupRole::Slave,
            ));

            let _ = coordinator
                .get_volume_routed(&mock, "192.168.1.100")
                .await
                .unwrap();

            assert!(mock.get_speaker_volume_called.load(Ordering::SeqCst));
            assert!(!mock.get_group_volume_called.load(Ordering::SeqCst));
        }

        #[tokio::test]
        async fn get_volume_routed_uses_group_control_for_solo_speaker() {
            let coordinator = create_test_coordinator();
            let mock = MockVolumeControl::new();

            // Solo coordinator
            coordinator.insert_test_session(create_test_session(
                "stream1",
                "192.168.1.100",
                GroupRole::Coordinator,
            ));

            let _ = coordinator
                .get_volume_routed(&mock, "192.168.1.100")
                .await
                .unwrap();

            assert!(!mock.get_speaker_volume_called.load(Ordering::SeqCst));
            assert!(mock.get_group_volume_called.load(Ordering::SeqCst));
        }

        #[tokio::test]
        async fn set_mute_routed_uses_speaker_control_in_sync_session() {
            let coordinator = create_test_coordinator();
            let mock = MockVolumeControl::new();

            // Set up sync session
            coordinator.insert_test_session(create_test_session(
                "stream1",
                "192.168.1.100",
                GroupRole::Coordinator,
            ));
            coordinator.insert_test_session(create_test_session(
                "stream1",
                "192.168.1.101",
                GroupRole::Slave,
            ));

            coordinator
                .set_mute_routed(&mock, "192.168.1.100", true)
                .await
                .unwrap();

            assert!(mock.set_speaker_mute_called.load(Ordering::SeqCst));
            assert!(!mock.set_group_mute_called.load(Ordering::SeqCst));
        }

        #[tokio::test]
        async fn set_mute_routed_uses_group_control_for_solo_speaker() {
            let coordinator = create_test_coordinator();
            let mock = MockVolumeControl::new();

            // Solo coordinator
            coordinator.insert_test_session(create_test_session(
                "stream1",
                "192.168.1.100",
                GroupRole::Coordinator,
            ));

            coordinator
                .set_mute_routed(&mock, "192.168.1.100", true)
                .await
                .unwrap();

            assert!(!mock.set_speaker_mute_called.load(Ordering::SeqCst));
            assert!(mock.set_group_mute_called.load(Ordering::SeqCst));
        }

        #[tokio::test]
        async fn get_mute_routed_uses_speaker_control_in_sync_session() {
            let coordinator = create_test_coordinator();
            let mock = MockVolumeControl::new();

            // Set up sync session
            coordinator.insert_test_session(create_test_session(
                "stream1",
                "192.168.1.100",
                GroupRole::Coordinator,
            ));
            coordinator.insert_test_session(create_test_session(
                "stream1",
                "192.168.1.101",
                GroupRole::Slave,
            ));

            let _ = coordinator
                .get_mute_routed(&mock, "192.168.1.100")
                .await
                .unwrap();

            assert!(mock.get_speaker_mute_called.load(Ordering::SeqCst));
            assert!(!mock.get_group_mute_called.load(Ordering::SeqCst));
        }

        #[tokio::test]
        async fn get_mute_routed_uses_group_control_for_solo_speaker() {
            let coordinator = create_test_coordinator();
            let mock = MockVolumeControl::new();

            // Solo coordinator
            coordinator.insert_test_session(create_test_session(
                "stream1",
                "192.168.1.100",
                GroupRole::Coordinator,
            ));

            let _ = coordinator
                .get_mute_routed(&mock, "192.168.1.100")
                .await
                .unwrap();

            assert!(!mock.get_speaker_mute_called.load(Ordering::SeqCst));
            assert!(mock.get_group_mute_called.load(Ordering::SeqCst));
        }
    }
}
