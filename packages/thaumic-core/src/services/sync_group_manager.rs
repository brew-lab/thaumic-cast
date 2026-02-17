//! Sync group lifecycle management for multi-room Sonos playback.
//!
//! Responsibilities:
//! - Coordinator selection for synchronized playback
//! - Slave joining/unjoining via x-rincon protocol
//! - Stop orchestration (ordered slave unjoin → coordinator stop)
//! - Coordinator promotion (slave takeover when coordinator removed)
//! - Original group restoration after streaming ends

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Notify;

use crate::context::NetworkContext;
use crate::events::{EventEmitter, SpeakerRemovalReason, StreamEvent};
use crate::sonos::subscription_arbiter::SubscriptionArbiter;
use crate::sonos::SonosPlayback;
use crate::state::SonosState;
use crate::stream::{AudioCodec, StreamManager};
use crate::utils::now_millis;

use super::playback_session_store::{
    GroupRole, PlaybackResult, PlaybackSession, PlaybackSessionKey, PlaybackSessionStore,
};

/// Manages sync group lifecycle for multi-room Sonos playback.
///
/// Handles the x-rincon protocol coordination: selecting coordinators,
/// joining/unjoining slaves, promoting slaves on coordinator removal,
/// and restoring speakers to their original groups after streaming.
pub(crate) struct SyncGroupManager {
    sessions: Arc<PlaybackSessionStore>,
    sonos: Arc<dyn SonosPlayback>,
    sonos_state: Arc<SonosState>,
    emitter: Arc<dyn EventEmitter>,
    arbiter: Arc<SubscriptionArbiter>,
    stream_manager: Arc<StreamManager>,
    network: NetworkContext,
    topology_refresh: Option<Arc<Notify>>,
}

impl SyncGroupManager {
    /// Creates a new SyncGroupManager.
    pub fn new(
        sessions: Arc<PlaybackSessionStore>,
        sonos: Arc<dyn SonosPlayback>,
        sonos_state: Arc<SonosState>,
        emitter: Arc<dyn EventEmitter>,
        arbiter: Arc<SubscriptionArbiter>,
        stream_manager: Arc<StreamManager>,
        network: NetworkContext,
    ) -> Self {
        Self {
            sessions,
            sonos,
            sonos_state,
            emitter,
            arbiter,
            stream_manager,
            network,
            topology_refresh: None,
        }
    }

    /// Sets the topology refresh notifier.
    pub fn set_topology_refresh(&mut self, notify: Arc<Notify>) {
        self.topology_refresh = Some(notify);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Private helpers
    // ─────────────────────────────────────────────────────────────────────────────

    /// Emits a stream event to all listeners.
    fn emit_event(&self, event: StreamEvent) {
        self.emitter.emit_stream(event);
    }

    /// Schedules a delayed topology refresh.
    ///
    /// Sonos needs time to propagate zone group changes internally after
    /// accepting a join/unjoin command. A direct SOAP query immediately after
    /// would return stale data.
    pub(crate) fn schedule_topology_refresh(&self) {
        if let Some(ref notify) = self.topology_refresh {
            let notify = Arc::clone(notify);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(500)).await;
                notify.notify_one();
            });
        }
    }

    /// Enters a sync session for all speakers in the given stream.
    async fn enter_sync_session(&self, stream_id: &str) {
        let callback_url = self.network.gena_callback_url();
        let speaker_ips = self.sessions.get_ips_for_stream(stream_id);
        self.arbiter
            .enter_sync_session(&speaker_ips, &callback_url)
            .await;
    }

    /// Leaves a sync session for a single speaker.
    async fn leave_sync_session(&self, speaker_ip: &str) {
        let callback_url = self.network.gena_callback_url();
        self.arbiter
            .leave_sync_session(speaker_ip, &callback_url)
            .await;
    }

    /// Cleans up a stream if no playback sessions remain.
    fn cleanup_stream_if_no_sessions(&self, stream_id: &str) {
        let has_remaining_sessions = self.sessions.has_sessions_for_stream(stream_id);

        if !has_remaining_sessions {
            log::info!(
                "[SyncGroupManager] Last speaker removed from stream {}, ending stream",
                stream_id
            );
            self.stream_manager.remove_stream(stream_id);
            self.emit_event(StreamEvent::Ended {
                stream_id: stream_id.to_string(),
                timestamp: now_millis(),
            });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Coordinator selection
    // ─────────────────────────────────────────────────────────────────────────────

    /// Selects a coordinator speaker for synchronized playback.
    ///
    /// Prefers speakers that are already Sonos group coordinators (have a coordinator UUID).
    /// Falls back to the first speaker with any resolvable UUID.
    ///
    /// # Returns
    /// Tuple of (coordinator_ip, coordinator_uuid, remaining_slave_ips), or None if
    /// no valid coordinator can be determined (no UUIDs available).
    pub fn select_coordinator(
        &self,
        speaker_ips: &[String],
    ) -> Option<(String, String, Vec<String>)> {
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

    // ─────────────────────────────────────────────────────────────────────────────
    // Slave joining
    // ─────────────────────────────────────────────────────────────────────────────

    /// Joins a slave speaker to an active coordinator for synchronized playback.
    ///
    /// This creates a playback session with `GroupRole::Slave` and uses the x-rincon
    /// protocol to sync the slave's playback timing to the coordinator.
    pub async fn join_slave_to_coordinator(
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

        // Check for existing sessions on this speaker and handle appropriately
        if let Some(existing) = self.sessions.get(stream_id, slave_ip) {
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
            self.sessions.remove(stream_id, slave_ip);

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
                .sessions
                .find_other_stream(slave_ip, stream_id)
                .map(|(key, session)| (key, session.stream_id));

            if let Some((old_key, old_stream_id)) = existing_other_stream {
                log::info!(
                    "[GroupSync] Slave {} switching from stream {} to {} - stopping old playback",
                    slave_ip,
                    old_stream_id,
                    stream_id
                );

                self.sessions
                    .remove(&old_key.stream_id, &old_key.speaker_ip);

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
        let original_coordinator_uuid = self
            .sonos_state
            .get_original_coordinator_for_slave(slave_ip);

        // Join the slave to the coordinator
        match self.sonos.join_group(slave_ip, coordinator_uuid).await {
            Ok(()) => {
                let rincon_uri = format!("x-rincon:{}", coordinator_uuid);

                self.sessions.insert(PlaybackSession {
                    stream_id: stream_id.to_string(),
                    speaker_ip: slave_ip.to_string(),
                    stream_url: rincon_uri.clone(),
                    codec,
                    role: GroupRole::Slave,
                    coordinator_ip: Some(coordinator_ip.to_string()),
                    coordinator_uuid: Some(coordinator_uuid.to_string()),
                    original_coordinator_uuid,
                });

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

    /// Joins multiple slaves to a coordinator concurrently.
    ///
    /// Parallelizes the individual `join_slave_to_coordinator` calls via `join_all`,
    /// then enters a sync session once if any joins succeeded.
    pub(crate) async fn join_slaves_to_coordinator(
        &self,
        slave_ips: &[String],
        coordinator_ip: &str,
        coordinator_uuid: &str,
        stream_id: &str,
        codec: AudioCodec,
    ) -> Vec<PlaybackResult> {
        let futures: Vec<_> = slave_ips
            .iter()
            .map(|slave_ip| {
                self.join_slave_to_coordinator(
                    slave_ip,
                    coordinator_ip,
                    coordinator_uuid,
                    stream_id,
                    codec,
                )
            })
            .collect();

        let results = futures::future::join_all(futures).await;

        let any_succeeded = results.iter().any(|r| r.success);
        if any_succeeded {
            self.enter_sync_session(stream_id).await;
        }

        results
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Stop orchestration
    // ─────────────────────────────────────────────────────────────────────────────

    /// Sends stop commands to a list of speakers (best-effort).
    ///
    /// For grouped playback, the order matters:
    /// 1. Unjoin slaves first (make them standalone)
    /// 2. Restore slaves to their original groups (best-effort)
    /// 3. Stop coordinators
    /// 4. Switch coordinators to queue (cleanup)
    pub async fn stop_speakers(&self, speaker_ips: &[String]) {
        let mut coordinators: Vec<(String, Option<String>)> = Vec::new();
        let mut slaves = Vec::new();
        let mut slave_restoration_info: Vec<(String, String)> = Vec::new();

        for ip in speaker_ips {
            if let Some(session) = self.sessions.get_by_speaker_ip(ip) {
                match session.role {
                    GroupRole::Coordinator => {
                        coordinators.push((ip.clone(), session.original_coordinator_uuid.clone()));
                    }
                    GroupRole::Slave => {
                        slaves.push(ip.clone());
                        if let Some(ref orig_uuid) = session.original_coordinator_uuid {
                            slave_restoration_info.push((ip.clone(), orig_uuid.clone()));
                        }
                    }
                }
            } else {
                coordinators.push((ip.clone(), None));
            }
        }

        log::debug!(
            "[GroupSync] stop_speakers: {} coordinators, {} slaves, {} slaves to restore",
            coordinators.len(),
            slaves.len(),
            slave_restoration_info.len()
        );

        // Block 1 (parallel across slaves): leave_group → restore → leave_sync_session
        {
            let futures: Vec<_> = slaves
                .iter()
                .map(|ip| {
                    let restoration = slave_restoration_info
                        .iter()
                        .find(|(s, _)| s == ip)
                        .map(|(_, uuid)| uuid.clone());

                    async move {
                        if let Err(e) = self.sonos.leave_group(ip).await {
                            log::warn!("[GroupSync] Failed to unjoin slave {}: {}", ip, e);
                        }
                        if let Some(orig_uuid) = restoration {
                            self.restore_original_group(ip, &orig_uuid).await;
                        }
                        self.leave_sync_session(ip).await;
                    }
                })
                .collect();

            futures::future::join_all(futures).await;
        }

        // Block 2 (parallel across coordinators, AFTER block 1):
        // stop → switch_to_queue → restore → leave_sync_session
        {
            let futures: Vec<_> = coordinators
                .iter()
                .map(|(ip, original_coordinator_uuid)| async move {
                    if let Err(e) = self.sonos.stop(ip).await {
                        log::warn!("[GroupSync] Failed to stop {}: {}", ip, e);
                    }

                    if let Some(uuid) = self.sonos_state.get_coordinator_uuid_by_ip(ip) {
                        if let Err(e) = self.sonos.switch_to_queue(ip, &uuid).await {
                            log::warn!("[GroupSync] Failed to switch {} to queue: {}", ip, e);
                        }
                    }

                    if let Some(orig_uuid) = original_coordinator_uuid {
                        self.restore_original_group(ip, orig_uuid).await;
                    }

                    self.leave_sync_session(ip).await;
                })
                .collect();

            futures::future::join_all(futures).await;
        }

        if !slaves.is_empty() {
            self.schedule_topology_refresh();
        }
    }

    /// Attempts to restore a speaker to its original Sonos group.
    ///
    /// Best-effort operation - if restoration fails, the speaker is left standalone.
    pub async fn restore_original_group(&self, speaker_ip: &str, original_coordinator_uuid: &str) {
        log::info!(
            "[GroupSync] Restoring {} to original group (coordinator: {})",
            speaker_ip,
            original_coordinator_uuid
        );

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

    /// Stops a slave speaker by unjoining it from the group.
    ///
    /// Only affects this speaker - the coordinator and other slaves continue playing.
    ///
    /// # Returns
    /// List containing the stopped speaker IP on success, empty on failure.
    pub async fn stop_slave_speaker(
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

        let original_coordinator = self
            .sessions
            .get(stream_id, speaker_ip)
            .and_then(|s| s.original_coordinator_uuid);

        match self.sonos.leave_group(speaker_ip).await {
            Ok(()) => {
                self.sessions.remove(stream_id, speaker_ip);

                self.leave_sync_session(speaker_ip).await;

                let remaining_slaves = self.sessions.has_slaves_for_stream(stream_id);

                if !remaining_slaves {
                    if let Some(coord_ip) = self.sessions.find_coordinator_ip_for_stream(stream_id)
                    {
                        self.leave_sync_session(&coord_ip).await;
                    }
                }

                if let Some(orig_uuid) = original_coordinator {
                    self.restore_original_group(speaker_ip, &orig_uuid).await;
                }

                self.emit_event(StreamEvent::PlaybackStopped {
                    stream_id: stream_id.to_string(),
                    speaker_ip: speaker_ip.to_string(),
                    reason,
                    timestamp: now_millis(),
                });

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
    /// Cascade operation:
    /// 1. Unjoin each slave
    /// 2. Restore each slave to their original group
    /// 3. Stop the coordinator
    ///
    /// # Returns
    /// List of stopped speaker IPs.
    pub async fn stop_coordinator_and_slaves(
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

        let mut stopped_ips: Vec<String> = Vec::new();

        let slave_info: Vec<(PlaybackSessionKey, Option<String>)> = self
            .sessions
            .get_slaves_for_coordinator(stream_id, coordinator_ip)
            .into_iter()
            .map(|(key, session)| (key, session.original_coordinator_uuid))
            .collect();

        // Unjoin all slaves concurrently, then restore to original groups
        let slave_futures: Vec<_> = slave_info
            .into_iter()
            .map(|(slave_key, original_coordinator)| async move {
                log::debug!(
                    "[GroupSync] Unjoining slave {} before stopping coordinator",
                    slave_key.speaker_ip
                );

                if let Err(e) = self.sonos.leave_group(&slave_key.speaker_ip).await {
                    log::warn!(
                        "[GroupSync] Failed to unjoin slave {} during coordinator stop: {}",
                        slave_key.speaker_ip,
                        e
                    );
                }

                if let Some(orig_uuid) = original_coordinator {
                    self.restore_original_group(&slave_key.speaker_ip, &orig_uuid)
                        .await;
                }

                self.sessions
                    .remove(&slave_key.stream_id, &slave_key.speaker_ip);

                self.leave_sync_session(&slave_key.speaker_ip).await;

                self.emit_event(StreamEvent::PlaybackStopped {
                    stream_id: stream_id.to_string(),
                    speaker_ip: slave_key.speaker_ip.clone(),
                    reason,
                    timestamp: now_millis(),
                });

                slave_key.speaker_ip
            })
            .collect();

        let slave_ips = futures::future::join_all(slave_futures).await;
        stopped_ips.extend(slave_ips);

        // Get session info before removing
        let (coordinator_uuid, original_coordinator_uuid) = self
            .sessions
            .get(stream_id, coordinator_ip)
            .map(|s| (s.coordinator_uuid, s.original_coordinator_uuid))
            .unwrap_or((None, None));

        let coordinator_uuid = coordinator_uuid
            .or_else(|| self.sonos_state.get_coordinator_uuid_by_ip(coordinator_ip));

        match self.sonos.stop(coordinator_ip).await {
            Ok(()) => {
                self.sessions.remove(stream_id, coordinator_ip);

                self.leave_sync_session(coordinator_ip).await;

                if let Some(uuid) = coordinator_uuid {
                    if let Err(e) = self.sonos.switch_to_queue(coordinator_ip, &uuid).await {
                        log::warn!(
                            "[GroupSync] Failed to switch coordinator {} to queue: {}",
                            coordinator_ip,
                            e
                        );
                    }
                }

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

                self.cleanup_stream_if_no_sessions(stream_id);

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
                stopped_ips
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Coordinator promotion
    // ─────────────────────────────────────────────────────────────────────────────

    /// Promotes a slave to coordinator when the current coordinator is removed.
    ///
    /// Instead of tearing down the entire group, picks a slave to become the new
    /// coordinator and re-points remaining slaves to it.
    ///
    /// # Returns
    /// List of stopped speaker IPs (only the old coordinator).
    /// On failure, returns `Err` so the caller can fall back to full teardown.
    pub async fn promote_slave_to_coordinator(
        &self,
        stream_id: &str,
        coordinator_ip: &str,
        reason: Option<SpeakerRemovalReason>,
    ) -> Result<Vec<String>, String> {
        // 1. Gather info from coordinator session
        let coord_session = self
            .sessions
            .get(stream_id, coordinator_ip)
            .ok_or("Coordinator session not found")?;

        let stream_url = coord_session.stream_url.clone();
        let codec = coord_session.codec;
        let coordinator_uuid = coord_session.coordinator_uuid.clone();
        let original_coordinator_uuid = coord_session.original_coordinator_uuid.clone();
        drop(coord_session);

        // 2. Gather slave sessions
        let slave_sessions = self
            .sessions
            .get_slaves_for_coordinator(stream_id, coordinator_ip);

        if slave_sessions.is_empty() {
            return Err("No slaves found to promote".to_string());
        }

        // 3. Pick first slave to promote — preserve its original group info
        let promoted_ip = slave_sessions[0].0.speaker_ip.clone();
        let promoted_original_coordinator = slave_sessions[0].1.original_coordinator_uuid.clone();
        let promoted_uuid = self
            .sonos_state
            .get_member_uuid_by_ip(&promoted_ip)
            .ok_or_else(|| format!("No UUID for promoted slave {}", promoted_ip))?;

        // 4. Get stream state for audio_format, metadata, artwork_url
        let stream_state = self
            .stream_manager
            .get_stream(stream_id)
            .ok_or("Stream state not found")?;
        let audio_format = stream_state.audio_format;
        let metadata = stream_state.metadata.read().clone();
        let artwork_url = self.network.url_builder().artwork_url();

        log::info!(
            "[GroupSync] Promoting slave {} (uuid={}) to coordinator, replacing {} (stream={})",
            promoted_ip,
            promoted_uuid,
            coordinator_ip,
            stream_id
        );

        // 5. Stop old coordinator
        if let Err(e) = self.sonos.stop(coordinator_ip).await {
            log::warn!(
                "[GroupSync] Failed to stop old coordinator {}: {}",
                coordinator_ip,
                e
            );
            // Continue - the speaker may already be stopped
        }

        self.sessions.remove(stream_id, coordinator_ip);
        self.leave_sync_session(coordinator_ip).await;

        if let Some(ref uuid) = coordinator_uuid {
            if let Err(e) = self.sonos.switch_to_queue(coordinator_ip, uuid).await {
                log::warn!(
                    "[GroupSync] Failed to switch old coordinator {} to queue: {}",
                    coordinator_ip,
                    e
                );
            }
        }

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

        // 6. Promote the chosen slave
        if let Err(e) = self.sonos.leave_group(&promoted_ip).await {
            log::warn!(
                "[GroupSync] Failed to unjoin promoted slave {}: {}",
                promoted_ip,
                e
            );
            // Continue - may already be detached if coordinator stopped
        }

        self.sonos
            .play_uri(
                &promoted_ip,
                &stream_url,
                codec,
                &audio_format,
                Some(&metadata),
                &artwork_url,
            )
            .await
            .map_err(|e| {
                format!(
                    "Failed to start stream on promoted slave {}: {}",
                    promoted_ip, e
                )
            })?;

        // Update promoted slave's session to coordinator role
        self.sessions.insert(PlaybackSession {
            stream_id: stream_id.to_string(),
            speaker_ip: promoted_ip.clone(),
            stream_url: stream_url.clone(),
            codec,
            role: GroupRole::Coordinator,
            coordinator_ip: None,
            coordinator_uuid: Some(promoted_uuid.clone()),
            original_coordinator_uuid: promoted_original_coordinator,
        });

        log::info!(
            "[GroupSync] Promoted {} to coordinator successfully",
            promoted_ip
        );

        // 7. Re-point remaining slaves to new coordinator
        let remaining_slaves: Vec<(PlaybackSessionKey, PlaybackSession)> = slave_sessions
            .into_iter()
            .filter(|(key, _)| key.speaker_ip != promoted_ip)
            .collect();

        let repoint_futures: Vec<_> = remaining_slaves
            .iter()
            .map(|(slave_key, slave_session)| async {
                log::debug!(
                    "[GroupSync] Re-pointing slave {} to new coordinator {}",
                    slave_key.speaker_ip,
                    promoted_ip
                );

                if let Err(e) = self.sonos.leave_group(&slave_key.speaker_ip).await {
                    log::warn!(
                        "[GroupSync] Failed to unjoin slave {} during re-point: {}",
                        slave_key.speaker_ip,
                        e
                    );
                    return;
                }

                if let Err(e) = self
                    .sonos
                    .join_group(&slave_key.speaker_ip, &promoted_uuid)
                    .await
                {
                    log::warn!(
                        "[GroupSync] Failed to re-point slave {} to new coordinator {}: {}",
                        slave_key.speaker_ip,
                        promoted_ip,
                        e
                    );
                    return;
                }

                // Update session to point to new coordinator
                let rincon_uri = format!("x-rincon:{}", promoted_uuid);
                self.sessions.insert(PlaybackSession {
                    stream_id: stream_id.to_string(),
                    speaker_ip: slave_key.speaker_ip.clone(),
                    stream_url: rincon_uri,
                    codec,
                    role: GroupRole::Slave,
                    coordinator_ip: Some(promoted_ip.clone()),
                    coordinator_uuid: Some(promoted_uuid.clone()),
                    original_coordinator_uuid: slave_session.original_coordinator_uuid.clone(),
                });
            })
            .collect();

        futures::future::join_all(repoint_futures).await;

        // 8. Cleanup stream if no sessions remain (edge case)
        self.cleanup_stream_if_no_sessions(stream_id);

        Ok(vec![coordinator_ip.to_string()])
    }
}
