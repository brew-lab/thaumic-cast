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
use tokio::sync::Notify;

use crate::context::NetworkContext;
use crate::error::ThaumicResult;
use crate::events::{EventEmitter, SpeakerRemovalReason, StreamEvent};
use crate::sonos::subscription_arbiter::SubscriptionArbiter;
use crate::sonos::types::TransportState;
use crate::sonos::utils::build_sonos_stream_uri;
use crate::sonos::SonosPlayback;
use crate::state::{SonosState, StreamingConfig};
use crate::stream::{AudioCodec, AudioFormat, StreamManager, StreamMetadata, StreamState};
use crate::utils::now_millis;

use super::playback_session_store::{
    GroupRole, PlaybackResult, PlaybackSession, PlaybackSessionStore,
};
use super::sync_group_manager::SyncGroupManager;
use super::volume_router::VolumeRouter;

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

/// Service responsible for stream lifecycle and playback orchestration.
pub struct StreamCoordinator {
    /// Sonos client for playback control.
    sonos: Arc<dyn SonosPlayback>,
    /// Sonos state for UUID lookups.
    sonos_state: Arc<SonosState>,
    stream_manager: Arc<StreamManager>,
    /// Network configuration (port, local IP).
    network: NetworkContext,
    /// Active playback sessions with indexed lookups.
    sessions: Arc<PlaybackSessionStore>,
    /// Event emitter for stream lifecycle events.
    emitter: Arc<dyn EventEmitter>,
    /// Sync group lifecycle manager.
    sync_group: SyncGroupManager,
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
    /// * `arbiter` - Subscription arbiter for RenderingControl/GroupRenderingControl conflict resolution
    pub fn new(
        sonos: Arc<dyn SonosPlayback>,
        sonos_state: Arc<SonosState>,
        network: NetworkContext,
        emitter: Arc<dyn EventEmitter>,
        streaming_config: StreamingConfig,
        arbiter: Arc<SubscriptionArbiter>,
    ) -> Self {
        let sessions = Arc::new(PlaybackSessionStore::new());
        let stream_manager = Arc::new(StreamManager::new(streaming_config));
        let sync_group = SyncGroupManager::new(
            Arc::clone(&sessions),
            Arc::clone(&sonos),
            Arc::clone(&sonos_state),
            Arc::clone(&emitter),
            arbiter,
            Arc::clone(&stream_manager),
            network.clone(),
        );
        Self {
            sonos,
            sonos_state,
            stream_manager,
            network,
            sessions,
            emitter,
            sync_group,
        }
    }

    /// Sets the topology refresh notifier.
    pub fn set_topology_refresh(&mut self, notify: Arc<Notify>) {
        self.sync_group.set_topology_refresh(notify);
    }

    /// Emits a stream event to all listeners.
    fn emit_event(&self, event: StreamEvent) {
        self.emitter.emit_stream(event);
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
        self.sessions.get_by_speaker_ip(speaker_ip).map(|session| {
            // x-rincon URIs are already in final form (for slaves)
            if session.stream_url.starts_with("x-rincon:") {
                session.stream_url
            } else {
                build_sonos_stream_uri(&session.stream_url, session.codec)
            }
        })
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
        self.sessions.is_in_sync_session(speaker_ip)
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Volume/Mute Routing (delegated to VolumeRouter)
    // ─────────────────────────────────────────────────────────────────────────────

    /// Creates a VolumeRouter scoped to this coordinator's sessions.
    fn volume_router(&self) -> VolumeRouter<'_> {
        VolumeRouter::new(&self.sessions)
    }

    /// Gets volume with automatic routing based on sync session state.
    pub async fn get_volume_routed(
        &self,
        sonos: &dyn crate::sonos::traits::SonosVolumeControl,
        speaker_ip: &str,
    ) -> crate::error::SoapResult<u8> {
        self.volume_router()
            .get_volume_routed(sonos, speaker_ip)
            .await
    }

    /// Sets volume with automatic routing based on sync session state.
    pub async fn set_volume_routed(
        &self,
        sonos: &dyn crate::sonos::traits::SonosVolumeControl,
        speaker_ip: &str,
        volume: u8,
    ) -> crate::error::SoapResult<()> {
        self.volume_router()
            .set_volume_routed(sonos, speaker_ip, volume)
            .await
    }

    /// Gets mute state with automatic routing based on sync session state.
    pub async fn get_mute_routed(
        &self,
        sonos: &dyn crate::sonos::traits::SonosVolumeControl,
        speaker_ip: &str,
    ) -> crate::error::SoapResult<bool> {
        self.volume_router()
            .get_mute_routed(sonos, speaker_ip)
            .await
    }

    /// Sets mute state with automatic routing based on sync session state.
    pub async fn set_mute_routed(
        &self,
        sonos: &dyn crate::sonos::traits::SonosVolumeControl,
        speaker_ip: &str,
        mute: bool,
    ) -> crate::error::SoapResult<()> {
        self.volume_router()
            .set_mute_routed(sonos, speaker_ip, mute)
            .await
    }

    /// Resolves the sync session coordinator IP for a given speaker.
    pub fn resolve_sync_coordinator_ip(&self, speaker_ip: &str) -> Option<String> {
        self.volume_router().resolve_sync_coordinator_ip(speaker_ip)
    }

    /// Sets group volume for the entire sync session containing `speaker_ip`.
    pub async fn set_sync_group_volume(
        &self,
        sonos: &dyn crate::sonos::traits::SonosVolumeControl,
        speaker_ip: &str,
        volume: u8,
    ) -> crate::error::SoapResult<()> {
        self.volume_router()
            .set_sync_group_volume(sonos, speaker_ip, volume)
            .await
    }

    /// Sets group mute for the entire sync session containing `speaker_ip`.
    pub async fn set_sync_group_mute(
        &self,
        sonos: &dyn crate::sonos::traits::SonosVolumeControl,
        speaker_ip: &str,
        mute: bool,
    ) -> crate::error::SoapResult<()> {
        self.volume_router()
            .set_sync_group_mute(sonos, speaker_ip, mute)
            .await
    }

    /// Inserts a playback session for testing purposes.
    ///
    /// This allows tests to set up coordinator state without going through
    /// the full playback start flow, enabling isolated testing of routing logic.
    #[cfg(test)]
    pub(crate) fn insert_test_session(&self, session: PlaybackSession) {
        self.sessions.insert(session);
    }

    /// Creates a new audio stream with the specified output codec.
    ///
    /// # Arguments
    /// * `codec` - Output codec for HTTP Content-Type (what Sonos receives)
    /// * `audio_format` - Audio format configuration (sample rate, channels, bit depth)
    /// * `streaming_buffer_ms` - Streaming buffer size in milliseconds (100-1000)
    /// * `frame_duration_ms` - Frame duration in milliseconds for cadence timing
    ///
    /// Returns the stream ID on success. Broadcasts a `StreamEvent::Created` event.
    pub fn create_stream(
        &self,
        codec: AudioCodec,
        audio_format: AudioFormat,
        streaming_buffer_ms: u64,
        frame_duration_ms: u32,
    ) -> Result<String, String> {
        let stream_id = self.stream_manager.create_stream(
            codec,
            audio_format,
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
        let removed = self.sessions.remove_all_for_stream(stream_id);
        let speaker_ips: Vec<String> = removed.iter().map(|s| s.speaker_ip.clone()).collect();

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
        let speaker_ips = self.sessions.get_ips_for_stream(stream_id);

        if is_pcm {
            // PCM: Close HTTP first to unblock Sonos, then send SOAP commands.
            // Sonos blocks on HTTP reads for PCM streams, causing SOAP timeouts.
            //
            // IMPORTANT: We must close HTTP before SOAP, but keep sessions intact
            // so stop_speakers can determine role ordering (unjoin slaves first).
            self.stream_manager.remove_stream(stream_id);

            // Now stop speakers with group-aware ordering (sessions still intact)
            self.sync_group.stop_speakers(&speaker_ips).await;

            // Finally clear sessions and emit stream ended event
            self.clear_sessions_and_emit_ended(stream_id);
        } else {
            // Compressed: Send SOAP stop first, then close HTTP.
            // Compressed codecs buffer in Sonos's decoder; stopping first prevents
            // playback of buffered audio after the stream is removed.
            self.sync_group.stop_speakers(&speaker_ips).await;
            self.remove_stream(stream_id);
        }
    }

    /// Clears playback sessions for a stream and emits the Ended event.
    ///
    /// Used by PCM cleanup path where HTTP must close before SOAP commands,
    /// but sessions must remain intact for role-based stop ordering.
    fn clear_sessions_and_emit_ended(&self, stream_id: &str) {
        self.sessions.remove_all_for_stream(stream_id);

        self.emit_event(StreamEvent::Ended {
            stream_id: stream_id.to_string(),
            timestamp: now_millis(),
        });
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
            self.sync_group.select_coordinator(speaker_ips)
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

        // Step 2: Join all slaves to the coordinator concurrently
        let slave_results = self
            .sync_group
            .join_slaves_to_coordinator(
                &slave_ips,
                &coordinator_ip,
                &coordinator_uuid,
                stream_id,
                codec,
            )
            .await;
        results.extend(slave_results);

        let joined_count = results.iter().filter(|r| r.success).count();

        log::info!(
            "[GroupSync] Synchronized playback started: {} speakers, stream={}",
            joined_count,
            stream_id
        );

        if joined_count > 1 {
            self.sync_group.schedule_topology_refresh();
        }

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

        let futures: Vec<_> = speaker_ips
            .iter()
            .map(|speaker_ip| {
                self.start_single_playback(SinglePlaybackParams {
                    speaker_ip,
                    stream_id,
                    stream_url,
                    codec,
                    audio_format,
                    artwork_url,
                    metadata,
                })
            })
            .collect();

        futures::future::join_all(futures).await
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

        // Check if this exact (stream, speaker) pair already exists
        if let Some(existing) = self.sessions.get(stream_id, speaker_ip) {
            // If this is a Slave session, we need to reconfigure the transport.
            // A Slave's stream_url is x-rincon:... pointing to the coordinator.
            // To make this speaker an independent coordinator, we must:
            // 1. Detach from the current group
            // 2. Set the transport URI to the actual stream
            if existing.role == GroupRole::Slave {
                log::info!(
                    "[GroupSync] Promoting slave {} to coordinator for stream {} (was following {})",
                    speaker_ip,
                    stream_id,
                    existing.coordinator_ip.as_deref().unwrap_or("unknown")
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
                self.sessions.remove(stream_id, speaker_ip);

                // Fall through to play_uri setup below
            } else {
                // Coordinator session exists - check if Sonos is paused and needs a Play command.
                // This enables bi-directional control: user can resume from extension
                // after pausing from Sonos app.

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
            .sessions
            .find_other_stream(speaker_ip, stream_id)
            .map(|(key, session)| (key, session.stream_id));

        if let Some((old_key, old_stream_id)) = existing_session {
            log::info!(
                "Speaker {} switching from stream {} to {} - stopping old playback first",
                speaker_ip,
                old_stream_id,
                stream_id
            );

            // Remove old session
            self.sessions
                .remove(&old_key.stream_id, &old_key.speaker_ip);

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
                self.sessions.insert(PlaybackSession {
                    stream_id: stream_id.to_string(),
                    speaker_ip: speaker_ip.to_string(),
                    stream_url: stream_url.to_string(),
                    codec,
                    role: GroupRole::Coordinator,
                    coordinator_ip: None,
                    coordinator_uuid,
                    original_coordinator_uuid,
                });

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
        // Get session to check role
        let session = match self.sessions.get(stream_id, speaker_ip) {
            Some(s) => s,
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

        let is_sync =
            session.role == GroupRole::Slave || self.sessions.has_slaves_for_stream(stream_id);

        let stopped = match session.role {
            GroupRole::Slave => {
                // Slave: just unjoin this speaker, others continue playing
                self.sync_group
                    .stop_slave_speaker(stream_id, speaker_ip, reason)
                    .await
            }
            GroupRole::Coordinator => {
                // Check if there are slaves that can be promoted to coordinator
                let has_slaves = !self
                    .sessions
                    .get_slaves_for_coordinator(stream_id, speaker_ip)
                    .is_empty();

                if has_slaves {
                    match self
                        .sync_group
                        .promote_slave_to_coordinator(stream_id, speaker_ip, reason)
                        .await
                    {
                        Ok(stopped) => stopped,
                        Err(e) => {
                            log::warn!(
                                "[GroupSync] Promotion failed ({}), falling back to teardown",
                                e
                            );
                            self.sync_group
                                .stop_coordinator_and_slaves(stream_id, speaker_ip, reason)
                                .await
                        }
                    }
                } else {
                    // No slaves: just stop the coordinator
                    self.sync_group
                        .stop_coordinator_and_slaves(stream_id, speaker_ip, reason)
                        .await
                }
            }
        };

        if is_sync && !stopped.is_empty() {
            self.sync_group.schedule_topology_refresh();
        }

        stopped
    }

    /// Gets all active playback sessions.
    pub fn get_all_sessions(&self) -> Vec<PlaybackSession> {
        self.sessions.all_sessions()
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

        let futures: Vec<_> = stream_ids
            .iter()
            .map(|stream_id| self.remove_stream_async(stream_id))
            .collect();

        futures::future::join_all(futures).await;

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
        let Some(key) = self.sessions.get_key_by_speaker_ip(speaker_ip) else {
            log::debug!(
                "Source changed on {} but no active playback session found",
                speaker_ip
            );
            return false;
        };

        let stream_id = key.stream_id.clone();

        // Remove the session (no SOAP command needed - speaker already stopped)
        self.sessions.remove(&key.stream_id, &key.speaker_ip);

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
        self.sync_group.cleanup_stream_if_no_sessions(&stream_id);

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
    // Coordinator Promotion Tests
    // ─────────────────────────────────────────────────────────────────────────

    mod coordinator_promotion {
        use super::*;
        use crate::context::NetworkContext;
        use crate::error::SoapResult;
        use crate::events::{EventEmitter, NetworkEvent, SonosEvent, StreamEvent, TopologyEvent};
        use crate::sonos::gena::GenaSubscriptionManager;
        use crate::sonos::subscription_arbiter::SubscriptionArbiter;
        use crate::sonos::traits::SonosPlayback;
        use crate::sonos::types::{PositionInfo, ZoneGroup, ZoneGroupMember};
        use crate::state::{SonosState, StreamingConfig};
        use crate::stream::{AudioCodec, AudioFormat};
        use async_trait::async_trait;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Mutex};

        /// Event emitter that collects events for assertion.
        struct CollectingEventEmitter {
            events: Mutex<Vec<StreamEvent>>,
        }

        impl CollectingEventEmitter {
            fn new() -> Self {
                Self {
                    events: Mutex::new(Vec::new()),
                }
            }

            fn playback_stopped_ips(&self) -> Vec<String> {
                self.events
                    .lock()
                    .unwrap()
                    .iter()
                    .filter_map(|e| match e {
                        StreamEvent::PlaybackStopped { speaker_ip, .. } => Some(speaker_ip.clone()),
                        _ => None,
                    })
                    .collect()
            }
        }

        impl EventEmitter for CollectingEventEmitter {
            fn emit_stream(&self, event: StreamEvent) {
                self.events.lock().unwrap().push(event);
            }
            fn emit_sonos(&self, _: SonosEvent) {}
            fn emit_latency(&self, _: crate::events::LatencyEvent) {}
            fn emit_network(&self, _: NetworkEvent) {}
            fn emit_topology(&self, _: TopologyEvent) {}
        }

        /// Mock SonosPlayback that tracks call counts per method.
        struct TrackingSonosPlayback {
            play_uri_count: AtomicUsize,
            stop_count: AtomicUsize,
            leave_group_count: AtomicUsize,
            join_group_count: AtomicUsize,
            switch_to_queue_count: AtomicUsize,
            /// If set, play_uri returns this error.
            play_uri_fail: Mutex<Option<String>>,
        }

        impl TrackingSonosPlayback {
            fn new() -> Self {
                Self {
                    play_uri_count: AtomicUsize::new(0),
                    stop_count: AtomicUsize::new(0),
                    leave_group_count: AtomicUsize::new(0),
                    join_group_count: AtomicUsize::new(0),
                    switch_to_queue_count: AtomicUsize::new(0),
                    play_uri_fail: Mutex::new(None),
                }
            }

            fn with_play_uri_fail(self, msg: &str) -> Self {
                *self.play_uri_fail.lock().unwrap() = Some(msg.to_string());
                self
            }
        }

        #[async_trait]
        impl SonosPlayback for TrackingSonosPlayback {
            async fn play_uri(
                &self,
                _: &str,
                _: &str,
                _: AudioCodec,
                _: &AudioFormat,
                _: Option<&StreamMetadata>,
                _: &str,
            ) -> SoapResult<()> {
                self.play_uri_count.fetch_add(1, Ordering::SeqCst);
                if let Some(msg) = self.play_uri_fail.lock().unwrap().as_ref() {
                    return Err(crate::sonos::soap::SoapError::Fault(msg.clone()));
                }
                Ok(())
            }
            async fn play(&self, _: &str) -> SoapResult<()> {
                Ok(())
            }
            async fn stop(&self, _: &str) -> SoapResult<()> {
                self.stop_count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
            async fn switch_to_queue(&self, _: &str, _: &str) -> SoapResult<()> {
                self.switch_to_queue_count.fetch_add(1, Ordering::SeqCst);
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
                self.join_group_count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
            async fn leave_group(&self, _: &str) -> SoapResult<()> {
                self.leave_group_count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        }

        /// Creates a SonosState with members for UUID lookup.
        fn create_sonos_state_with_members(members: &[(&str, &str)]) -> Arc<SonosState> {
            let state = Arc::new(SonosState::default());
            let groups = members
                .iter()
                .map(|(ip, uuid)| ZoneGroup {
                    id: uuid.to_string(),
                    name: format!("Room {}", ip),
                    coordinator_uuid: uuid.to_string(),
                    coordinator_ip: ip.to_string(),
                    members: vec![ZoneGroupMember {
                        uuid: uuid.to_string(),
                        ip: ip.to_string(),
                        zone_name: format!("Room {}", ip),
                        model: "One".to_string(),
                    }],
                })
                .collect();
            *state.groups.write() = groups;
            state
        }

        /// Creates a StreamCoordinator with custom sonos mock and event emitter.
        ///
        /// Uses a 1ms timeout so GENA subscribe attempts against nonexistent
        /// speakers fail immediately instead of blocking on TCP SYN retries (~30s).
        fn create_coordinator_with(
            sonos: Arc<dyn SonosPlayback>,
            sonos_state: Arc<SonosState>,
            emitter: Arc<dyn EventEmitter>,
        ) -> StreamCoordinator {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_millis(1))
                .build()
                .unwrap();
            let (gena_manager, _rx) = GenaSubscriptionManager::new(client);
            let arbiter = Arc::new(SubscriptionArbiter::new(Arc::new(gena_manager)));
            StreamCoordinator::new(
                sonos,
                sonos_state,
                NetworkContext::for_test(),
                emitter,
                StreamingConfig::default(),
                arbiter,
            )
        }

        #[tokio::test]
        async fn promote_slave_when_coordinator_removed_with_slaves() {
            let sonos = Arc::new(TrackingSonosPlayback::new());
            let sonos_state = create_sonos_state_with_members(&[
                ("192.168.1.100", "RINCON_COORD"),
                ("192.168.1.101", "RINCON_SLAVE1"),
                ("192.168.1.102", "RINCON_SLAVE2"),
            ]);
            let emitter = Arc::new(CollectingEventEmitter::new());
            let coord = create_coordinator_with(
                Arc::clone(&sonos) as Arc<dyn SonosPlayback>,
                Arc::clone(&sonos_state),
                Arc::clone(&emitter) as Arc<dyn EventEmitter>,
            );

            // Create stream so get_stream() works
            let stream_id = coord
                .create_stream(AudioCodec::Aac, AudioFormat::default(), 200, 20)
                .unwrap();

            // Set up sessions with matching stream_id
            coord.insert_test_session(PlaybackSession {
                stream_id: stream_id.clone(),
                speaker_ip: "192.168.1.100".to_string(),
                stream_url: "http://127.0.0.1:0/stream/test/live".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Coordinator,
                coordinator_ip: None,
                coordinator_uuid: Some("RINCON_COORD".to_string()),
                original_coordinator_uuid: None,
            });
            coord.insert_test_session(PlaybackSession {
                stream_id: stream_id.clone(),
                speaker_ip: "192.168.1.101".to_string(),
                stream_url: "x-rincon:RINCON_COORD".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Slave,
                coordinator_ip: Some("192.168.1.100".to_string()),
                coordinator_uuid: Some("RINCON_COORD".to_string()),
                original_coordinator_uuid: None,
            });
            coord.insert_test_session(PlaybackSession {
                stream_id: stream_id.clone(),
                speaker_ip: "192.168.1.102".to_string(),
                stream_url: "x-rincon:RINCON_COORD".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Slave,
                coordinator_ip: Some("192.168.1.100".to_string()),
                coordinator_uuid: Some("RINCON_COORD".to_string()),
                original_coordinator_uuid: None,
            });

            // Remove the coordinator
            let stopped = coord
                .stop_playback_speaker(&stream_id, "192.168.1.100", None)
                .await;

            // Only the old coordinator should be "stopped"
            assert_eq!(stopped, vec!["192.168.1.100"]);

            // Only one PlaybackStopped event (for the old coordinator)
            // (plus the StreamEvent::Created from create_stream)
            assert_eq!(emitter.playback_stopped_ips(), vec!["192.168.1.100"]);

            // One slave should be promoted to coordinator (DashMap order is nondeterministic)
            let sessions = coord.get_all_sessions();
            let promoted = sessions
                .iter()
                .find(|s| s.role == GroupRole::Coordinator)
                .expect("one session should be promoted to coordinator");
            assert!(promoted.coordinator_ip.is_none());
            assert!(!promoted.stream_url.starts_with("x-rincon:"));
            // Promoted speaker should have its own UUID as coordinator_uuid
            assert!(promoted.coordinator_uuid.is_some());

            // Remaining slave should be re-pointed to the promoted coordinator
            let remaining = sessions
                .iter()
                .find(|s| s.role == GroupRole::Slave)
                .expect("one session should remain as slave");
            assert_eq!(
                remaining.coordinator_ip.as_deref(),
                Some(promoted.speaker_ip.as_str())
            );
            assert_eq!(remaining.coordinator_uuid, promoted.coordinator_uuid);
            assert_eq!(
                remaining.stream_url,
                format!("x-rincon:{}", promoted.coordinator_uuid.as_ref().unwrap())
            );

            // Old coordinator session should be gone
            assert!(coord
                .get_all_sessions()
                .iter()
                .all(|s| s.speaker_ip != "192.168.1.100"));

            // Verify SOAP calls: stop(old), leave_group(promoted), play_uri(promoted),
            // leave_group(remaining), join_group(remaining)
            assert_eq!(sonos.stop_count.load(Ordering::SeqCst), 1);
            assert_eq!(sonos.play_uri_count.load(Ordering::SeqCst), 1);
            assert_eq!(sonos.leave_group_count.load(Ordering::SeqCst), 2);
            assert_eq!(sonos.join_group_count.load(Ordering::SeqCst), 1);
        }

        #[tokio::test]
        async fn promote_with_single_slave_becomes_standalone() {
            let sonos = Arc::new(TrackingSonosPlayback::new());
            let sonos_state = create_sonos_state_with_members(&[
                ("192.168.1.100", "RINCON_COORD"),
                ("192.168.1.101", "RINCON_SLAVE1"),
            ]);
            let emitter = Arc::new(CollectingEventEmitter::new());
            let coord = create_coordinator_with(
                Arc::clone(&sonos) as Arc<dyn SonosPlayback>,
                Arc::clone(&sonos_state),
                Arc::clone(&emitter) as Arc<dyn EventEmitter>,
            );

            let stream_id = coord
                .create_stream(AudioCodec::Aac, AudioFormat::default(), 200, 20)
                .unwrap();

            coord.insert_test_session(PlaybackSession {
                stream_id: stream_id.clone(),
                speaker_ip: "192.168.1.100".to_string(),
                stream_url: "http://127.0.0.1:0/stream/test/live".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Coordinator,
                coordinator_ip: None,
                coordinator_uuid: Some("RINCON_COORD".to_string()),
                original_coordinator_uuid: None,
            });
            coord.insert_test_session(PlaybackSession {
                stream_id: stream_id.clone(),
                speaker_ip: "192.168.1.101".to_string(),
                stream_url: "x-rincon:RINCON_COORD".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Slave,
                coordinator_ip: Some("192.168.1.100".to_string()),
                coordinator_uuid: Some("RINCON_COORD".to_string()),
                original_coordinator_uuid: None,
            });

            let stopped = coord
                .stop_playback_speaker(&stream_id, "192.168.1.100", None)
                .await;

            assert_eq!(stopped, vec!["192.168.1.100"]);

            // Only 1 session remaining: the promoted slave
            let sessions = coord.get_all_sessions();
            assert_eq!(sessions.len(), 1);
            assert_eq!(sessions[0].speaker_ip, "192.168.1.101");
            assert_eq!(sessions[0].role, GroupRole::Coordinator);

            // No join_group calls since there are no remaining slaves to re-point
            assert_eq!(sonos.join_group_count.load(Ordering::SeqCst), 0);
        }

        #[tokio::test]
        async fn promotion_falls_back_to_teardown_on_play_uri_failure() {
            let sonos = Arc::new(TrackingSonosPlayback::new().with_play_uri_fail("SOAP fault"));
            let sonos_state = create_sonos_state_with_members(&[
                ("192.168.1.100", "RINCON_COORD"),
                ("192.168.1.101", "RINCON_SLAVE1"),
            ]);
            let emitter = Arc::new(CollectingEventEmitter::new());
            let coord = create_coordinator_with(
                Arc::clone(&sonos) as Arc<dyn SonosPlayback>,
                Arc::clone(&sonos_state),
                Arc::clone(&emitter) as Arc<dyn EventEmitter>,
            );

            let stream_id = coord
                .create_stream(AudioCodec::Aac, AudioFormat::default(), 200, 20)
                .unwrap();

            coord.insert_test_session(PlaybackSession {
                stream_id: stream_id.clone(),
                speaker_ip: "192.168.1.100".to_string(),
                stream_url: "http://127.0.0.1:0/stream/test/live".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Coordinator,
                coordinator_ip: None,
                coordinator_uuid: Some("RINCON_COORD".to_string()),
                original_coordinator_uuid: None,
            });
            coord.insert_test_session(PlaybackSession {
                stream_id: stream_id.clone(),
                speaker_ip: "192.168.1.101".to_string(),
                stream_url: "x-rincon:RINCON_COORD".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Slave,
                coordinator_ip: Some("192.168.1.100".to_string()),
                coordinator_uuid: Some("RINCON_COORD".to_string()),
                original_coordinator_uuid: None,
            });

            let stopped = coord
                .stop_playback_speaker(&stream_id, "192.168.1.100", None)
                .await;

            // Fallback teardown: both speakers should be stopped
            assert!(stopped.contains(&"192.168.1.100".to_string()));
            assert!(stopped.contains(&"192.168.1.101".to_string()));

            // All sessions should be cleaned up
            assert!(coord.get_all_sessions().is_empty());
        }

        #[tokio::test]
        async fn no_promotion_when_coordinator_has_no_slaves() {
            let sonos = Arc::new(TrackingSonosPlayback::new());
            let sonos_state = create_sonos_state_with_members(&[("192.168.1.100", "RINCON_COORD")]);
            let emitter = Arc::new(CollectingEventEmitter::new());
            let coord = create_coordinator_with(
                Arc::clone(&sonos) as Arc<dyn SonosPlayback>,
                Arc::clone(&sonos_state),
                Arc::clone(&emitter) as Arc<dyn EventEmitter>,
            );

            coord.insert_test_session(PlaybackSession {
                stream_id: "stream1".to_string(),
                speaker_ip: "192.168.1.100".to_string(),
                stream_url: "http://127.0.0.1:0/stream/test/live".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Coordinator,
                coordinator_ip: None,
                coordinator_uuid: Some("RINCON_COORD".to_string()),
                original_coordinator_uuid: None,
            });

            let stopped = coord
                .stop_playback_speaker("stream1", "192.168.1.100", None)
                .await;

            // Direct teardown, no promotion attempted
            assert_eq!(stopped, vec!["192.168.1.100"]);
            assert!(coord.get_all_sessions().is_empty());

            // No play_uri called (no promotion)
            assert_eq!(sonos.play_uri_count.load(Ordering::SeqCst), 0);
        }

        #[tokio::test]
        async fn promotion_falls_back_when_uuid_lookup_fails() {
            // SonosState has no members → UUID lookup fails → promotion fails → teardown
            let sonos = Arc::new(TrackingSonosPlayback::new());
            let sonos_state = Arc::new(SonosState::default()); // Empty - no UUID lookups work
            let emitter = Arc::new(CollectingEventEmitter::new());
            let coord = create_coordinator_with(
                Arc::clone(&sonos) as Arc<dyn SonosPlayback>,
                sonos_state,
                Arc::clone(&emitter) as Arc<dyn EventEmitter>,
            );

            coord.insert_test_session(PlaybackSession {
                stream_id: "stream1".to_string(),
                speaker_ip: "192.168.1.100".to_string(),
                stream_url: "http://127.0.0.1:0/stream/test/live".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Coordinator,
                coordinator_ip: None,
                coordinator_uuid: Some("RINCON_COORD".to_string()),
                original_coordinator_uuid: None,
            });
            coord.insert_test_session(PlaybackSession {
                stream_id: "stream1".to_string(),
                speaker_ip: "192.168.1.101".to_string(),
                stream_url: "x-rincon:RINCON_COORD".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Slave,
                coordinator_ip: Some("192.168.1.100".to_string()),
                coordinator_uuid: Some("RINCON_COORD".to_string()),
                original_coordinator_uuid: None,
            });

            let stopped = coord
                .stop_playback_speaker("stream1", "192.168.1.100", None)
                .await;

            // Fallback teardown: both should be stopped
            assert!(stopped.contains(&"192.168.1.100".to_string()));
            assert!(stopped.contains(&"192.168.1.101".to_string()));
            assert!(coord.get_all_sessions().is_empty());
        }

        #[tokio::test]
        async fn promoted_session_preserves_original_group_from_slave_session() {
            // Regression: promoted session must use the slave's stored
            // original_coordinator_uuid, NOT re-query the Sonos topology.
            // The topology reflects the *streaming* group (slave of Kitchen),
            // but the slave session correctly stored None (was standalone before).
            // Re-querying would return Kitchen's UUID, causing recombination on stop.

            let sonos = Arc::new(TrackingSonosPlayback::new());
            // Topology shows Office as slave of Kitchen (the streaming group)
            let sonos_state = Arc::new(SonosState::default());
            {
                let mut groups = sonos_state.groups.write();
                *groups = vec![ZoneGroup {
                    id: "streaming_group".to_string(),
                    name: "Kitchen".to_string(),
                    coordinator_uuid: "RINCON_KITCHEN".to_string(),
                    coordinator_ip: "192.168.1.100".to_string(),
                    members: vec![
                        ZoneGroupMember {
                            uuid: "RINCON_KITCHEN".to_string(),
                            ip: "192.168.1.100".to_string(),
                            zone_name: "Kitchen".to_string(),
                            model: "One".to_string(),
                        },
                        ZoneGroupMember {
                            uuid: "RINCON_OFFICE".to_string(),
                            ip: "192.168.1.101".to_string(),
                            zone_name: "Office".to_string(),
                            model: "One".to_string(),
                        },
                    ],
                }];
            }

            let emitter = Arc::new(CollectingEventEmitter::new());
            let coord = create_coordinator_with(
                Arc::clone(&sonos) as Arc<dyn SonosPlayback>,
                Arc::clone(&sonos_state),
                Arc::clone(&emitter) as Arc<dyn EventEmitter>,
            );

            let stream_id = coord
                .create_stream(AudioCodec::Aac, AudioFormat::default(), 200, 20)
                .unwrap();

            // Slave session has original_coordinator_uuid: None (was standalone before streaming)
            coord.insert_test_session(PlaybackSession {
                stream_id: stream_id.clone(),
                speaker_ip: "192.168.1.100".to_string(),
                stream_url: "http://127.0.0.1:0/stream/test/live".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Coordinator,
                coordinator_ip: None,
                coordinator_uuid: Some("RINCON_KITCHEN".to_string()),
                original_coordinator_uuid: None,
            });
            coord.insert_test_session(PlaybackSession {
                stream_id: stream_id.clone(),
                speaker_ip: "192.168.1.101".to_string(),
                stream_url: "x-rincon:RINCON_KITCHEN".to_string(),
                codec: AudioCodec::Aac,
                role: GroupRole::Slave,
                coordinator_ip: Some("192.168.1.100".to_string()),
                coordinator_uuid: Some("RINCON_KITCHEN".to_string()),
                // Key: Office was standalone before streaming, so no original group
                original_coordinator_uuid: None,
            });

            // Remove Kitchen (coordinator) → Office promoted
            coord
                .stop_playback_speaker(&stream_id, "192.168.1.100", None)
                .await;

            // The promoted session must have original_coordinator_uuid: None
            // (from the slave session), NOT Some("RINCON_KITCHEN") (from topology)
            let promoted = coord
                .get_all_sessions()
                .into_iter()
                .find(|s| s.speaker_ip == "192.168.1.101")
                .expect("promoted session should exist");
            assert_eq!(promoted.role, GroupRole::Coordinator);
            assert_eq!(
                promoted.original_coordinator_uuid, None,
                "Promoted session should preserve slave's original_coordinator_uuid (None), \
                 not re-query topology which would return Kitchen's UUID"
            );
        }
    }
}
