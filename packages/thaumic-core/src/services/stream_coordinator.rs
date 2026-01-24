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

/// Tracks an active playback session linking a stream to a speaker.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSession {
    /// The stream ID being played.
    pub stream_id: String,
    /// The speaker IP address receiving the stream.
    pub speaker_ip: String,
    /// The full URL the speaker is fetching audio from.
    pub stream_url: String,
    /// The codec being used (for Sonos URI formatting).
    pub codec: AudioCodec,
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
    pub fn new(
        sonos: Arc<dyn SonosPlayback>,
        sonos_state: Arc<SonosState>,
        network: NetworkContext,
        emitter: Arc<dyn EventEmitter>,
        streaming_config: StreamingConfig,
    ) -> Self {
        Self {
            sonos,
            sonos_state,
            stream_manager: Arc::new(StreamManager::new(streaming_config)),
            network,
            playback_sessions: DashMap::new(),
            emitter,
        }
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
    ///
    /// Note: A speaker can only play one stream at a time, so we find the first
    /// session matching the speaker IP.
    #[must_use]
    pub fn get_expected_stream(&self, speaker_ip: &str) -> Option<String> {
        self.playback_sessions
            .iter()
            .find(|r| r.key().speaker_ip == speaker_ip)
            .map(|r| build_sonos_stream_uri(&r.value().stream_url, r.value().codec))
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
    /// 2. Send SOAP stop commands
    ///
    /// **Compressed codecs (AAC/MP3/FLAC):**
    /// 1. Send SOAP stop commands first (stops playback immediately)
    /// 2. Then close HTTP (Sonos has internal buffer that would otherwise drain)
    ///
    /// Speaker stop/switch failures are logged but don't prevent cleanup.
    pub async fn remove_stream_async(&self, stream_id: &str) {
        // Get codec and speaker IPs before removing the stream
        let stream_state = self.get_stream(stream_id);
        let is_pcm = stream_state
            .as_ref()
            .map(|s| s.codec == AudioCodec::Pcm)
            .unwrap_or(false);

        // Collect speaker IPs before removal
        let speaker_ips: Vec<String> = self
            .playback_sessions
            .iter()
            .filter(|r| r.key().stream_id == stream_id)
            .map(|r| r.key().speaker_ip.clone())
            .collect();

        if is_pcm {
            // PCM: Close HTTP first to unblock Sonos, then send SOAP commands.
            // Sonos blocks on HTTP reads for PCM streams, causing SOAP timeouts.
            self.remove_stream(stream_id);
            self.stop_speakers(&speaker_ips).await;
        } else {
            // Compressed: Send SOAP stop first, then close HTTP.
            // Compressed codecs buffer in Sonos's decoder; stopping first prevents
            // playback of buffered audio after the stream is removed.
            self.stop_speakers(&speaker_ips).await;
            self.remove_stream(stream_id);
        }
    }

    /// Sends stop commands to a list of speakers (best-effort).
    ///
    /// Sends `Stop` first to immediately halt playback (like the Sonos app),
    /// then `switch_to_queue` to clear the stale stream source from Sonos UI.
    ///
    /// The order matters: sending `switch_to_queue` first would cause Sonos to
    /// buffer/transition between sources, allowing buffered audio to continue.
    async fn stop_speakers(&self, speaker_ips: &[String]) {
        for ip in speaker_ips {
            // Send Stop FIRST - this immediately halts playback (like the Sonos app).
            // Sending switch_to_queue first would cause Sonos to buffer/transition
            // between sources, allowing buffered audio to continue playing.
            if let Err(e) = self.sonos.stop(ip).await {
                log::warn!("[StreamCoordinator] Failed to stop {}: {}", ip, e);
            }

            // Then switch to queue as cleanup (clears stale stream source in Sonos UI)
            if let Some(uuid) = self.sonos_state.get_coordinator_uuid_by_ip(ip) {
                if let Err(e) = self.sonos.switch_to_queue(ip, &uuid).await {
                    log::warn!(
                        "[StreamCoordinator] Failed to switch {} to queue: {}",
                        ip,
                        e
                    );
                }
            }
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

    /// Starts playback of a stream on multiple Sonos speakers (multi-group support).
    ///
    /// Returns results for each speaker (best-effort: continues on individual failures).
    /// Each successful speaker gets a `StreamEvent::PlaybackStarted` event.
    ///
    /// # Arguments
    /// * `speaker_ips` - IP addresses of the Sonos speakers (coordinators)
    /// * `stream_id` - The stream ID to play
    /// * `metadata` - Optional initial metadata to display on Sonos
    /// * `artwork_url` - URL for album artwork in Sonos DIDL-Lite metadata
    pub async fn start_playback_multi(
        &self,
        speaker_ips: &[String],
        stream_id: &str,
        metadata: Option<&StreamMetadata>,
        artwork_url: &str,
    ) -> Vec<PlaybackResult> {
        // Get stream state for codec and audio format
        let stream_state = self.get_stream(stream_id);

        // Get codec and audio format from stream state
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

        let mut results = Vec::with_capacity(speaker_ips.len());

        for speaker_ip in speaker_ips {
            let result = self
                .start_single_playback(SinglePlaybackParams {
                    speaker_ip,
                    stream_id,
                    stream_url: &stream_url,
                    codec,
                    audio_format: &audio_format,
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
        if self.playback_sessions.contains_key(&key) {
            // Session exists - check if Sonos is paused and needs a Play command.
            // This enables bi-directional control: user can resume from extension
            // after pausing from Sonos app.
            // Note: transport_states are keyed by speaker IP, not UUID.
            let transport_state = self
                .sonos_state
                .transport_states
                .get(speaker_ip)
                .map(|s| *s);

            log::debug!(
                "[Resume] Session exists for {} / {}, transport_state={:?}",
                speaker_ip,
                stream_id,
                transport_state
            );

            let is_paused = transport_state == Some(TransportState::Paused);

            if is_paused {
                log::info!(
                    "Speaker {} paused, sending Play command to resume stream {}",
                    speaker_ip,
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
                    "Speaker {} already playing stream {}, skipping",
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
                // Record the playback session
                self.playback_sessions.insert(
                    key,
                    PlaybackSession {
                        stream_id: stream_id.to_string(),
                        speaker_ip: speaker_ip.to_string(),
                        stream_url: stream_url.to_string(),
                        codec,
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
            .start_playback_multi(&[speaker_ip.to_string()], stream_id, metadata, artwork_url)
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
    /// On success: removes the session, broadcasts `StreamEvent::PlaybackStopped`, returns `true`.
    /// On failure (stop command fails or session not found): keeps session intact (if any),
    /// broadcasts `StreamEvent::PlaybackStopFailed`, returns `false`.
    /// Used for partial speaker removal in multi-group scenarios.
    ///
    /// # Arguments
    /// * `stream_id` - The stream ID
    /// * `speaker_ip` - IP address of the speaker to stop
    /// * `reason` - Optional reason for stopping (propagated to events)
    ///
    /// # Returns
    /// `true` if playback was stopped successfully, `false` if stop failed (session kept intact).
    pub async fn stop_playback_speaker(
        &self,
        stream_id: &str,
        speaker_ip: &str,
        reason: Option<SpeakerRemovalReason>,
    ) -> bool {
        let key = PlaybackSessionKey::new(stream_id, speaker_ip);

        if !self.playback_sessions.contains_key(&key) {
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
            return false;
        }

        match self.sonos.stop(speaker_ip).await {
            Ok(()) => {
                // Success: remove session and emit PlaybackStopped
                self.playback_sessions.remove(&key);
                self.emit_event(StreamEvent::PlaybackStopped {
                    stream_id: stream_id.to_string(),
                    speaker_ip: speaker_ip.to_string(),
                    reason,
                    timestamp: now_millis(),
                });
                true
            }
            Err(e) => {
                // Failure: keep session intact, emit PlaybackStopFailed
                log::warn!("Failed to stop playback on {}: {}", speaker_ip, e);
                self.emit_event(StreamEvent::PlaybackStopFailed {
                    stream_id: stream_id.to_string(),
                    speaker_ip: speaker_ip.to_string(),
                    error: e.to_string(),
                    reason,
                    timestamp: now_millis(),
                });
                false
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

        // Check if any sessions remain for this stream
        let has_remaining_sessions = self
            .playback_sessions
            .iter()
            .any(|r| r.key().stream_id == stream_id);

        if !has_remaining_sessions {
            // Last speaker removed - end the stream
            // Use sync remove_stream since speaker already stopped (no SOAP needed)
            log::info!(
                "Last speaker removed from stream {} due to source change, ending stream",
                stream_id
            );
            self.stream_manager.remove_stream(&stream_id);
            self.emit_event(StreamEvent::Ended {
                stream_id,
                timestamp: now_millis(),
            });
        }

        true
    }
}
