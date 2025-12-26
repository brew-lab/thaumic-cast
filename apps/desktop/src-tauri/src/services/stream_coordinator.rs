//! Stream lifecycle and playback orchestration service.
//!
//! Responsibilities:
//! - Create/remove audio streams (wraps StreamManager)
//! - Start/stop playback on Sonos speakers
//! - Track which stream is playing on which speaker
//! - Track expected stream URLs for source change detection
//! - Broadcast stream lifecycle events to WebSocket clients

use std::sync::Arc;

use bytes::Bytes;
use dashmap::DashMap;

use crate::context::NetworkContext;
use crate::error::ThaumicResult;
use crate::events::{EventEmitter, StreamEvent};
use crate::sonos::utils::normalize_sonos_uri;
use crate::sonos::SonosPlayback;
use crate::stream::{AudioCodec, StreamManager, StreamMetadata, StreamState};
use crate::utils::now_millis;

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
}

/// Service responsible for stream lifecycle and playback orchestration.
pub struct StreamCoordinator {
    /// Sonos client for playback control.
    sonos: Arc<dyn SonosPlayback>,
    stream_manager: Arc<StreamManager>,
    /// Network configuration (port, local IP).
    network: NetworkContext,
    /// Active playback sessions: speaker_ip -> PlaybackSession
    playback_sessions: DashMap<String, PlaybackSession>,
    /// Event emitter for stream lifecycle events.
    emitter: Arc<dyn EventEmitter>,
}

impl StreamCoordinator {
    /// Creates a new StreamCoordinator.
    ///
    /// # Arguments
    /// * `sonos` - Sonos client for playback control
    /// * `network` - Network configuration (port, local IP)
    /// * `emitter` - Event emitter for broadcasting stream events
    pub fn new(
        sonos: Arc<dyn SonosPlayback>,
        network: NetworkContext,
        emitter: Arc<dyn EventEmitter>,
    ) -> Self {
        Self {
            sonos,
            stream_manager: Arc::new(StreamManager::new()),
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
    /// Returns the stream URL in `x-rincon-mp3radio://` format if the speaker has
    /// an active playback session, or None otherwise.
    #[must_use]
    pub fn get_expected_stream(&self, speaker_ip: &str) -> Option<String> {
        self.playback_sessions
            .get(speaker_ip)
            .map(|session| normalize_sonos_uri(&session.stream_url))
    }

    /// Creates a new audio stream with the specified codec.
    ///
    /// Returns the stream ID on success. Broadcasts a `StreamEvent::Created` event.
    pub fn create_stream(&self, codec: AudioCodec) -> Result<String, String> {
        let stream_id = self.stream_manager.create_stream(codec)?;

        // Broadcast stream created event
        self.emit_event(StreamEvent::Created {
            stream_id: stream_id.clone(),
            timestamp: now_millis(),
        });

        Ok(stream_id)
    }

    /// Removes a stream and cleans up any associated playback session.
    ///
    /// Broadcasts a `StreamEvent::Ended` event.
    pub fn remove_stream(&self, stream_id: &str) {
        // Find and remove any playback session for this stream
        let speaker_ip = self
            .playback_sessions
            .iter()
            .find(|r| r.value().stream_id == stream_id)
            .map(|r| r.key().clone());

        if let Some(ip) = speaker_ip {
            self.playback_sessions.remove(&ip);
        }

        self.stream_manager.remove_stream(stream_id);

        // Broadcast stream ended event
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

    /// Starts playback of a stream on a Sonos speaker.
    ///
    /// This tells the speaker to fetch audio from our HTTP stream endpoint.
    /// The playback session is recorded for expected stream tracking.
    /// Broadcasts a `StreamEvent::PlaybackStarted` event.
    pub async fn start_playback(&self, speaker_ip: &str, stream_id: &str) -> ThaumicResult<()> {
        let stream_url = self.network.url_builder().stream_url(stream_id);

        log::info!("Starting playback: {} -> {}", speaker_ip, stream_url);

        // Tell Sonos to play our stream
        self.sonos.play_uri(speaker_ip, &stream_url, None).await?;

        // Record the playback session (includes expected stream URL)
        self.playback_sessions.insert(
            speaker_ip.to_string(),
            PlaybackSession {
                stream_id: stream_id.to_string(),
                speaker_ip: speaker_ip.to_string(),
                stream_url: stream_url.clone(),
            },
        );

        // Broadcast playback started event
        self.emit_event(StreamEvent::PlaybackStarted {
            stream_id: stream_id.to_string(),
            speaker_ip: speaker_ip.to_string(),
            stream_url,
            timestamp: now_millis(),
        });

        Ok(())
    }

    /// Stops playback on a speaker and clears the session.
    ///
    /// Broadcasts a `StreamEvent::PlaybackStopped` event.
    pub async fn stop_playback(&self, speaker_ip: &str) -> ThaumicResult<()> {
        self.sonos.stop(speaker_ip).await?;

        self.playback_sessions.remove(speaker_ip);

        // Broadcast playback stopped event
        self.emit_event(StreamEvent::PlaybackStopped {
            speaker_ip: speaker_ip.to_string(),
            timestamp: now_millis(),
        });

        Ok(())
    }

    /// Gets all active playback sessions.
    pub fn get_all_sessions(&self) -> Vec<PlaybackSession> {
        self.playback_sessions.iter().map(|r| r.clone()).collect()
    }

    /// Stops all playback and clears all streams.
    ///
    /// This performs a complete cleanup:
    /// 1. Sends STOP command to all speakers with active playback
    /// 2. Removes all playback session records (including expected stream tracking)
    /// 3. Clears all audio streams
    /// 4. Broadcasts `StreamEvent::Ended` for each cleared stream
    ///
    /// Returns the number of streams that were cleared.
    pub async fn clear_all(&self) -> usize {
        // Collect speaker IPs first to avoid holding lock during async calls
        let speaker_ips: Vec<String> = self
            .playback_sessions
            .iter()
            .map(|r| r.key().clone())
            .collect();

        // Collect stream IDs before clearing (for event broadcasting)
        let stream_ids = self.stream_manager.list_stream_ids();

        // Stop playback on each speaker (best effort - don't fail if one errors)
        for ip in &speaker_ips {
            if let Err(e) = self.stop_playback(ip).await {
                log::warn!(
                    "[StreamCoordinator] Failed to stop playback on {}: {}",
                    ip,
                    e
                );
            }
        }

        // Clear all remaining sessions and streams
        self.playback_sessions.clear();
        let count = self.stream_manager.clear_all();

        // Broadcast ended events for all cleared streams
        let timestamp = now_millis();
        for stream_id in stream_ids {
            self.emit_event(StreamEvent::Ended {
                stream_id,
                timestamp,
            });
        }

        log::info!(
            "[StreamCoordinator] Cleared all: {} speaker(s) stopped, {} stream(s) removed",
            speaker_ips.len(),
            count
        );

        count
    }

    /// Returns the number of active streams.
    #[must_use]
    pub fn stream_count(&self) -> usize {
        self.stream_manager.stream_count()
    }
}
