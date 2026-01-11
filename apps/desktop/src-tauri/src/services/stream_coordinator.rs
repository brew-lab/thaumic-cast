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
use crate::events::{EventEmitter, StreamEvent};
use crate::sonos::utils::build_sonos_stream_uri;
use crate::sonos::SonosPlayback;
use crate::state::SonosState;
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
    pub codec: String,
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
    /// * `max_concurrent_streams` - Maximum number of concurrent streams allowed
    /// * `stream_buffer_frames` - Maximum frames to buffer for late-joining clients
    /// * `stream_channel_capacity` - Capacity of the broadcast channel for audio frames
    pub fn new(
        sonos: Arc<dyn SonosPlayback>,
        sonos_state: Arc<SonosState>,
        network: NetworkContext,
        emitter: Arc<dyn EventEmitter>,
        max_concurrent_streams: usize,
        stream_buffer_frames: usize,
        stream_channel_capacity: usize,
    ) -> Self {
        Self {
            sonos,
            sonos_state,
            stream_manager: Arc::new(StreamManager::new(
                max_concurrent_streams,
                stream_buffer_frames,
                stream_channel_capacity,
            )),
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
            .map(|r| build_sonos_stream_uri(&r.value().stream_url, &r.value().codec))
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
    ///
    /// Returns the stream ID on success. Broadcasts a `StreamEvent::Created` event.
    pub fn create_stream(
        &self,
        codec: AudioCodec,
        audio_format: AudioFormat,
        transcoder: Arc<dyn Transcoder>,
    ) -> Result<String, String> {
        let stream_id = self
            .stream_manager
            .create_stream(codec, audio_format, transcoder)?;

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
    /// This is the preferred method for stream removal. It:
    /// 1. Removes the stream (closes HTTP connections, broadcasts `StreamEvent::Ended`)
    /// 2. Switches each speaker's source to its queue (clears stale stream)
    /// 3. Sends STOP to each speaker as cleanup
    ///
    /// The stream is removed BEFORE sending SOAP commands because Sonos may block
    /// on HTTP reads, causing Stop commands to timeout. Removing the stream first
    /// closes HTTP connections, freeing Sonos to respond to SOAP commands.
    ///
    /// Speaker stop/switch failures are logged but don't prevent cleanup.
    pub async fn remove_stream_async(&self, stream_id: &str) {
        // Remove the stream FIRST to close HTTP connections and get speaker IPs.
        // This is critical because Sonos may block on HTTP reads, causing SOAP
        // commands to timeout. Removing the stream closes the broadcast channel,
        // which ends the HTTP response streams and frees Sonos to respond.
        let speaker_ips = self.remove_stream(stream_id);

        // Now stop each speaker and switch to queue (best-effort)
        // The HTTP connection is closed, so Sonos should respond quickly.
        for ip in &speaker_ips {
            // Switch to queue first - this is the reliable way to stop our stream
            if let Some(uuid) = self.sonos_state.get_coordinator_uuid_by_ip(ip) {
                if let Err(e) = self.sonos.switch_to_queue(ip, &uuid).await {
                    log::warn!(
                        "[StreamCoordinator] Failed to switch {} to queue: {}",
                        ip,
                        e
                    );
                }
            }

            // Then send Stop as cleanup (in case Sonos is in a weird state)
            if let Err(e) = self.sonos.stop(ip).await {
                log::warn!("[StreamCoordinator] Failed to stop {}: {}", ip, e);
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
    pub async fn start_playback_multi(
        &self,
        speaker_ips: &[String],
        stream_id: &str,
        metadata: Option<&StreamMetadata>,
    ) -> Vec<PlaybackResult> {
        // Get codec from stream state for proper Sonos URI formatting
        let codec = self
            .get_stream(stream_id)
            .map(|s| match s.codec {
                AudioCodec::Wav => "wav",
                AudioCodec::Flac => "flac",
                AudioCodec::Aac => "aac",
                AudioCodec::Mp3 => "mp3",
            })
            .unwrap_or("aac");

        let url_builder = self.network.url_builder();
        let stream_url = url_builder.stream_url(stream_id);
        let icon_url = url_builder.icon_url();

        let mut results = Vec::with_capacity(speaker_ips.len());

        for speaker_ip in speaker_ips {
            let result = self
                .start_single_playback(
                    speaker_ip,
                    stream_id,
                    &stream_url,
                    codec,
                    &icon_url,
                    metadata,
                )
                .await;
            results.push(result);
        }

        results
    }

    /// Starts playback on a single speaker.
    async fn start_single_playback(
        &self,
        speaker_ip: &str,
        stream_id: &str,
        stream_url: &str,
        codec: &str,
        icon_url: &str,
        metadata: Option<&StreamMetadata>,
    ) -> PlaybackResult {
        let key = PlaybackSessionKey::new(stream_id, speaker_ip);

        // Check if this exact (stream, speaker) pair already exists (no-op)
        if self.playback_sessions.contains_key(&key) {
            log::debug!(
                "Speaker {} already playing stream {}, skipping",
                speaker_ip,
                stream_id
            );
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
            self.emit_event(StreamEvent::PlaybackStopped {
                stream_id: old_stream_id,
                speaker_ip: speaker_ip.to_string(),
                timestamp: now_millis(),
            });
        }

        log::info!("Starting playback: {} -> {}", speaker_ip, stream_url);

        match self
            .sonos
            .play_uri(speaker_ip, stream_url, codec, metadata, icon_url)
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
                        codec: codec.to_string(),
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
    pub async fn start_playback(
        &self,
        speaker_ip: &str,
        stream_id: &str,
        metadata: Option<&StreamMetadata>,
    ) -> ThaumicResult<()> {
        let results = self
            .start_playback_multi(&[speaker_ip.to_string()], stream_id, metadata)
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
    /// Removes the session and broadcasts a `StreamEvent::PlaybackStopped` event.
    /// Used for partial speaker removal in multi-group scenarios.
    ///
    /// Reserved for future use (partial speaker removal from extension).
    ///
    /// # Arguments
    /// * `stream_id` - The stream ID
    /// * `speaker_ip` - IP address of the speaker to stop
    #[allow(dead_code)]
    pub async fn stop_playback_speaker(
        &self,
        stream_id: &str,
        speaker_ip: &str,
    ) -> ThaumicResult<()> {
        let key = PlaybackSessionKey::new(stream_id, speaker_ip);

        if self.playback_sessions.remove(&key).is_some() {
            // Best-effort stop - ignore errors (speaker might already be stopped)
            if let Err(e) = self.sonos.stop(speaker_ip).await {
                log::warn!("Failed to stop playback on {}: {}", speaker_ip, e);
            }

            // Broadcast playback stopped event
            self.emit_event(StreamEvent::PlaybackStopped {
                stream_id: stream_id.to_string(),
                speaker_ip: speaker_ip.to_string(),
                timestamp: now_millis(),
            });
        }

        Ok(())
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
}
