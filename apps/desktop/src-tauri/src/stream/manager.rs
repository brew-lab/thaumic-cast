use bytes::Bytes;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Instant;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::stream::transcoder::Transcoder;
use crate::stream::AudioFormat;

/// Supported audio codecs for the stream
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AudioCodec {
    Wav,
    Aac,
    Mp3,
    Flac,
}

/// Metadata for the current track.
///
/// Note: `album` and `artwork` from MediaSession are not used in DIDL-Lite
/// formatting because they get stuck (ICY metadata doesn't support updates
/// for these fields). Instead, we use static branding based on `source`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StreamMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub artwork: Option<String>,
    /// Source name derived from tab URL (e.g., "YouTube", "Spotify").
    /// Used to format album as "{source} • Thaumic Cast" in DIDL-Lite.
    pub source: Option<String>,
}

/// A playback epoch represents one Sonos streaming session per speaker.
///
/// Each time a Sonos speaker connects and starts consuming audio, a new epoch
/// begins. This maps to Sonos's RelTime=0 for that connection.
#[derive(Clone, Copy, Debug)]
#[allow(dead_code)] // Telemetry fields for debugging
pub struct PlaybackEpoch {
    /// Incrementing ID to detect epoch changes.
    pub id: u64,
    /// Timestamp of oldest audio frame being served (content T0).
    /// This is what RelTime=0 corresponds to.
    pub audio_epoch: Instant,
    /// When the Sonos HTTP request arrived (telemetry).
    pub connected_at: Instant,
    /// When the first audio chunk was actually polled (telemetry).
    pub first_audio_polled_at: Instant,
    /// Remote IP that started this epoch.
    pub remote_ip: IpAddr,
}

/// A frame with its capture timestamp (before transcoding).
pub struct TimestampedFrame {
    /// When the frame was received from browser (pre-transcode).
    pub captured_at: Instant,
    /// The transcoded audio data.
    pub data: Bytes,
}

/// Timing information for latency measurement.
///
/// Tracks when the first audio frame arrives and manages per-speaker playback
/// epochs for accurate latency calculation.
pub struct StreamTiming {
    /// When browser started sending (first frame received, pre-transcode).
    /// Used as fallback if no prefill is available.
    first_frame_at: OnceLock<Instant>,

    /// Current playback epoch per remote IP.
    /// Each Sonos speaker gets its own epoch to prevent stray requests
    /// from clobbering the real speaker's timing.
    current_epoch_by_ip: parking_lot::Mutex<HashMap<IpAddr, PlaybackEpoch>>,

    /// Monotonic epoch counter (shared across all IPs).
    epoch_counter: AtomicU64,
}

impl StreamTiming {
    /// Creates a new StreamTiming instance.
    pub fn new() -> Self {
        Self {
            first_frame_at: OnceLock::new(),
            current_epoch_by_ip: parking_lot::Mutex::new(HashMap::new()),
            epoch_counter: AtomicU64::new(0),
        }
    }

    /// Records when the first frame was received from browser.
    ///
    /// Returns `true` if this was the first call (timing just started),
    /// `false` if timing was already started.
    pub fn record_first_frame(&self) -> bool {
        self.first_frame_at.set(Instant::now()).is_ok()
    }

    /// Returns when first frame was received (used as fallback for epoch T0).
    pub fn first_frame_at(&self) -> Option<Instant> {
        self.first_frame_at.get().copied()
    }

    /// Maximum number of epochs to keep (prevents unbounded HashMap growth).
    const MAX_EPOCHS: usize = 20;

    /// Starts a new playback epoch for a specific remote IP.
    ///
    /// Called on first audio chunk polled from the stream body.
    /// Creates a new epoch with incremented ID, which signals the latency
    /// monitor to reset its session state for this speaker.
    pub fn start_new_epoch(
        &self,
        audio_epoch: Option<Instant>,
        connected_at: Instant,
        first_audio_polled_at: Instant,
        remote_ip: IpAddr,
    ) {
        // Fallback: if no prefill timestamp, use first_frame_at or connected_at
        let audio_epoch = audio_epoch
            .or_else(|| self.first_frame_at())
            .unwrap_or(connected_at);

        let id = self.epoch_counter.fetch_add(1, Ordering::Relaxed) + 1;

        let epoch = PlaybackEpoch {
            id,
            audio_epoch,
            connected_at,
            first_audio_polled_at,
            remote_ip,
        };

        // Calculate timing gaps for debugging
        let buffer_age = connected_at.duration_since(audio_epoch);
        let poll_delay = first_audio_polled_at.duration_since(connected_at);
        let audio_age_at_poll = first_audio_polled_at.duration_since(audio_epoch);

        let mut epochs = self.current_epoch_by_ip.lock();

        // TTL cleanup: remove stale epochs if we have too many
        if epochs.len() >= Self::MAX_EPOCHS {
            // Find and remove the oldest epoch by first_audio_polled_at
            if let Some(oldest_ip) = epochs
                .iter()
                .min_by_key(|(_, e)| e.first_audio_polled_at)
                .map(|(ip, _)| *ip)
            {
                epochs.remove(&oldest_ip);
                log::debug!("[StreamTiming] Removed stale epoch for IP {}", oldest_ip);
            }
        }

        epochs.insert(remote_ip, epoch);

        log::info!(
            "[StreamTiming] Epoch #{} started: remote={}, buffer_age={:?}, poll_delay={:?}, audio_age_at_poll={:?}",
            id,
            remote_ip,
            buffer_age,
            poll_delay,
            audio_age_at_poll,
        );
    }

    /// Returns the current epoch for a specific IP if one exists.
    pub fn current_epoch_for(&self, ip: IpAddr) -> Option<PlaybackEpoch> {
        self.current_epoch_by_ip.lock().get(&ip).copied()
    }
}

impl Default for StreamTiming {
    fn default() -> Self {
        Self::new()
    }
}

/// State for a single active audio stream
pub struct StreamState {
    pub id: String,
    /// Output codec for HTTP Content-Type header.
    /// This is what Sonos receives, which may differ from input format.
    pub codec: AudioCodec,
    /// Audio format configuration (sample rate, channels, bit depth).
    /// Used for WAV header generation and silence frame creation.
    pub audio_format: AudioFormat,
    pub metadata: Arc<parking_lot::RwLock<StreamMetadata>>,
    /// Broadcast channel for distributing audio frames to HTTP clients
    pub tx: broadcast::Sender<Bytes>,
    /// Recent frames buffer with timestamps for epoch calculation.
    /// Stores transcoded frames with their pre-transcode capture time.
    buffer: Arc<parking_lot::RwLock<VecDeque<TimestampedFrame>>>,
    /// Maximum frames to keep in buffer (ring buffer limit).
    buffer_frames: usize,
    /// Whether the stream has received its first frame (for STREAM_READY signaling)
    has_frames: AtomicBool,
    /// Transcoder for converting input format to output format.
    /// For PCM input, this passes through raw data (WAV header added by HTTP handler).
    /// For pre-encoded formats (AAC, FLAC), this is also a passthrough.
    transcoder: Arc<dyn Transcoder>,
    /// Timing information for latency measurement.
    pub timing: StreamTiming,
}

impl StreamState {
    /// Creates a new StreamState instance with a custom transcoder.
    ///
    /// # Arguments
    /// * `id` - Unique stream identifier
    /// * `codec` - Output codec for HTTP Content-Type (what Sonos receives)
    /// * `audio_format` - Audio format configuration (sample rate, channels, bit depth)
    /// * `transcoder` - Transcoder for converting input to output format
    /// * `buffer_frames` - Maximum frames to buffer for late-joining clients
    /// * `channel_capacity` - Capacity of the broadcast channel for audio frames
    pub fn new(
        id: String,
        codec: AudioCodec,
        audio_format: AudioFormat,
        transcoder: Arc<dyn Transcoder>,
        buffer_frames: usize,
        channel_capacity: usize,
    ) -> Self {
        let (tx, _) = broadcast::channel(channel_capacity);
        log::debug!(
            "[Stream] Creating {} with codec {:?}, format {:?}, transcoder: {}",
            id,
            codec,
            audio_format,
            transcoder.description()
        );
        Self {
            id,
            codec,
            audio_format,
            metadata: Arc::new(parking_lot::RwLock::new(StreamMetadata::default())),
            tx,
            buffer: Arc::new(parking_lot::RwLock::new(VecDeque::with_capacity(
                buffer_frames,
            ))),
            buffer_frames,
            has_frames: AtomicBool::new(false),
            transcoder,
            timing: StreamTiming::new(),
        }
    }

    /// Pushes a new audio frame into the stream.
    ///
    /// The frame is first timestamped (before transcoding), then passed through
    /// the transcoder and added to the buffer and broadcast to HTTP clients.
    ///
    /// Returns `true` if this was the first frame (stream just became ready),
    /// `false` otherwise.
    pub fn push_frame(&self, frame: Bytes) -> bool {
        // Timestamp BEFORE transcoding to capture true content arrival time
        let captured_at = Instant::now();

        // Transcode the frame (PCM → FLAC, or passthrough for pre-encoded)
        let output_frame = self.transcoder.transcode(frame);

        // Add to recent buffer (ring buffer behavior)
        // Clone the Bytes (cheap - just Arc bump) for buffer storage
        {
            let mut buffer = self.buffer.write();
            if buffer.len() >= self.buffer_frames {
                buffer.pop_front();
            }
            buffer.push_back(TimestampedFrame {
                captured_at,
                data: output_frame.clone(),
            });
        }

        // Signal ready on first frame (compare_exchange ensures only first frame triggers)
        let is_first_frame = self
            .has_frames
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();

        if is_first_frame {
            self.timing.record_first_frame();
            log::debug!("[Stream] {} is now ready (first frame received)", self.id);
        }

        // Broadcast to all active HTTP listeners
        if let Err(e) = self.tx.send(output_frame) {
            log::trace!("Failed to broadcast frame for stream {}: {}", self.id, e);
        }

        is_first_frame
    }

    /// Updates the metadata for the stream.
    pub fn update_metadata(&self, metadata: StreamMetadata) {
        *self.metadata.write() = metadata;
    }

    /// Returns the number of frames currently in the buffer.
    #[must_use]
    pub fn buffer_len(&self) -> usize {
        self.buffer.read().len()
    }

    /// Subscribes to the stream, returning epoch candidate, buffered frames, and live receiver.
    ///
    /// This method atomically captures the current buffer contents and creates
    /// a broadcast receiver, ensuring late-joining clients receive prefill data
    /// without duplicates or gaps.
    ///
    /// # Returns
    /// A tuple of (epoch_candidate, prefill_frames, live_receiver) where:
    /// - `epoch_candidate`: Timestamp of oldest buffered frame (None if buffer empty)
    /// - `prefill_frames`: A `Vec<Bytes>` containing buffered frames to send immediately
    /// - `live_receiver`: A `broadcast::Receiver<Bytes>` for subsequent live frames
    pub fn subscribe(&self) -> (Option<Instant>, Vec<Bytes>, broadcast::Receiver<Bytes>) {
        // Hold the buffer lock while subscribing to ensure atomicity.
        // This prevents races where a frame could appear in both prefill and rx:
        // - Any push_frame() that completes before we lock will have its frame in buffer
        //   AND will have already broadcast (so we won't receive it in rx)
        // - Any push_frame() that starts after we lock will block until we're done,
        //   then broadcast (so we'll receive it in rx, not in prefill)
        let buffer = self.buffer.read();
        let rx = self.tx.subscribe();

        // Epoch candidate = timestamp of oldest frame we'll serve (T0 for this connection)
        let epoch_candidate = buffer.front().map(|f| f.captured_at);
        let prefill: Vec<Bytes> = buffer.iter().map(|f| f.data.clone()).collect();

        (epoch_candidate, prefill, rx)
    }
}

impl Drop for StreamState {
    fn drop(&mut self) {
        log::info!(
            "[Stream] {} broadcast sender dropped (channel closing)",
            self.id
        );
    }
}

/// Manages all active audio streams in the application.
pub struct StreamManager {
    streams: DashMap<String, Arc<StreamState>>,
    /// Maximum number of concurrent streams allowed.
    max_concurrent_streams: usize,
    /// Maximum frames to buffer for late-joining clients.
    stream_buffer_frames: usize,
    /// Capacity of the broadcast channel for audio frames.
    stream_channel_capacity: usize,
}

impl StreamManager {
    /// Creates a new StreamManager instance.
    ///
    /// # Arguments
    /// * `max_concurrent_streams` - Maximum number of concurrent streams allowed
    /// * `stream_buffer_frames` - Maximum frames to buffer for late-joining clients
    /// * `stream_channel_capacity` - Capacity of the broadcast channel for audio frames
    pub fn new(
        max_concurrent_streams: usize,
        stream_buffer_frames: usize,
        stream_channel_capacity: usize,
    ) -> Self {
        Self {
            streams: DashMap::new(),
            max_concurrent_streams,
            stream_buffer_frames,
            stream_channel_capacity,
        }
    }

    /// Creates a new stream with a custom transcoder and returns its ID.
    ///
    /// # Arguments
    /// * `codec` - Output codec for HTTP Content-Type (what Sonos receives)
    /// * `audio_format` - Audio format configuration (sample rate, channels, bit depth)
    /// * `transcoder` - Transcoder for converting input to output format
    pub fn create_stream(
        &self,
        codec: AudioCodec,
        audio_format: AudioFormat,
        transcoder: Arc<dyn Transcoder>,
    ) -> Result<String, String> {
        if self.streams.len() >= self.max_concurrent_streams {
            return Err("Maximum number of concurrent streams reached".to_string());
        }

        let id = Uuid::new_v4().to_string();
        let state = Arc::new(StreamState::new(
            id.clone(),
            codec,
            audio_format,
            transcoder,
            self.stream_buffer_frames,
            self.stream_channel_capacity,
        ));
        self.streams.insert(id.clone(), state);
        Ok(id)
    }

    /// Retrieves an active stream by its ID.
    pub fn get_stream(&self, id: &str) -> Option<Arc<StreamState>> {
        self.streams.get(id).map(|r| Arc::clone(r.value()))
    }

    /// Removes a stream from the manager.
    pub fn remove_stream(&self, id: &str) {
        self.streams.remove(id);
    }

    /// Returns the number of active streams.
    #[must_use]
    pub fn stream_count(&self) -> usize {
        self.streams.len()
    }

    /// Returns a list of all active stream IDs.
    #[must_use]
    pub fn list_stream_ids(&self) -> Vec<String> {
        self.streams.iter().map(|r| r.key().clone()).collect()
    }
}
