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

use crate::state::StreamingConfig;
use crate::stream::AudioFormat;

/// Supported audio codecs for the stream.
///
/// Note: `Pcm` outputs as WAV container (PCM + RIFF headers) for Sonos compatibility.
/// The MIME type and file extensions remain `audio/wav` and `.wav` because that's
/// what Sonos expects, but the actual codec is uncompressed PCM.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AudioCodec {
    Pcm,
    Aac,
    Mp3,
    Flac,
}

/// Cleanup ordering for stream teardown.
///
/// Sonos devices behave differently depending on the codec, which affects the
/// safe order for closing the HTTP stream vs sending SOAP stop commands.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CleanupOrder {
    /// Close the HTTP stream before sending SOAP stop commands.
    ///
    /// Required for PCM: Sonos blocks on HTTP reads for uncompressed audio,
    /// so SOAP commands would timeout if the HTTP connection is still open.
    HttpFirst,
    /// Send SOAP stop commands before closing the HTTP stream.
    ///
    /// Required for compressed codecs: Sonos has an internal decoder buffer,
    /// so stopping playback first prevents draining buffered audio after
    /// the stream source is gone.
    SoapFirst,
}

impl AudioCodec {
    /// Returns the cleanup ordering required for this codec during stream teardown.
    #[must_use]
    pub const fn cleanup_order(&self) -> CleanupOrder {
        match self {
            Self::Pcm => CleanupOrder::HttpFirst,
            _ => CleanupOrder::SoapFirst,
        }
    }

    /// Returns the codec as a short string identifier (e.g., "pcm", "aac").
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Pcm => "pcm",
            Self::Aac => "aac",
            Self::Mp3 => "mp3",
            Self::Flac => "flac",
        }
    }

    /// Returns the MIME type for this codec.
    ///
    /// Note: PCM returns "audio/wav" because it's served in a WAV container for Sonos.
    #[must_use]
    pub const fn mime_type(&self) -> &'static str {
        match self {
            Self::Pcm => "audio/wav", // WAV container for Sonos compatibility
            Self::Aac => "audio/aac",
            Self::Mp3 => "audio/mpeg",
            Self::Flac => "audio/flac",
        }
    }
}

/// Metadata for the current track.
///
/// DIDL-Lite uses static branding based on `source` (not per-track album/artwork
/// from MediaSession, which can't be updated via ICY metadata).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StreamMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    /// Source name derived from tab URL (e.g., "YouTube", "Spotify").
    /// Used to format album as "{source} • {APP_NAME}" in DIDL-Lite.
    pub source: Option<String>,
}

/// A playback epoch represents one Sonos streaming session per speaker.
///
/// Each time a Sonos speaker connects and starts consuming audio, a new epoch
/// begins. This maps to Sonos's RelTime=0 for that connection.
#[derive(Clone, Copy, Debug)]
pub struct PlaybackEpoch {
    /// Incrementing ID to detect epoch changes.
    pub id: u64,
    /// Timestamp of oldest audio frame being served (content T0).
    /// This is what RelTime=0 corresponds to.
    pub audio_epoch: Instant,
}

/// Receive jitter statistics, accumulated per reporting window.
///
/// Tracks inter-frame arrival timing to detect WebSocket delivery
/// irregularities from the browser extension.
#[derive(Clone)]
pub struct ReceiveStats {
    /// Number of frames received in this window.
    pub frames_received: u64,
    /// Minimum inter-frame gap in milliseconds (u64::MAX if no gaps recorded).
    pub min_gap_ms: u64,
    /// Maximum inter-frame gap in milliseconds.
    pub max_gap_ms: u64,
    /// Number of gaps exceeding 2× frame_duration_ms.
    pub gaps_over_threshold: u64,
    /// When this measurement window started.
    pub window_start: Instant,
}

impl ReceiveStats {
    fn new() -> Self {
        Self {
            frames_received: 0,
            min_gap_ms: u64::MAX,
            max_gap_ms: 0,
            gaps_over_threshold: 0,
            window_start: Instant::now(),
        }
    }
}

/// A frame with its capture timestamp.
pub struct TimestampedFrame {
    /// When the frame was received from the browser.
    pub captured_at: Instant,
    /// The audio data.
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
        remote_ip: IpAddr,
    ) {
        let now = Instant::now();

        // Fallback: if no prefill timestamp, use first_frame_at or connected_at
        let audio_epoch = audio_epoch
            .or_else(|| self.first_frame_at())
            .unwrap_or(connected_at);

        let id = self.epoch_counter.fetch_add(1, Ordering::Relaxed) + 1;

        let epoch = PlaybackEpoch { id, audio_epoch };

        // Calculate timing gaps for debugging
        let buffer_age = connected_at.duration_since(audio_epoch);
        let poll_delay = now.duration_since(connected_at);
        let audio_age_at_poll = now.duration_since(audio_epoch);

        let mut epochs = self.current_epoch_by_ip.lock();

        // TTL cleanup: remove stale epochs if we have too many
        if epochs.len() >= Self::MAX_EPOCHS {
            // Evict the epoch serving the oldest content
            if let Some(oldest_ip) = epochs
                .iter()
                .min_by_key(|(_, e)| e.audio_epoch)
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
    buffer: Arc<parking_lot::RwLock<VecDeque<TimestampedFrame>>>,
    /// Maximum frames to keep in buffer (ring buffer limit).
    buffer_frames: usize,
    /// Whether the stream has received its first frame (for STREAM_READY signaling)
    has_frames: AtomicBool,
    /// Timing information for latency measurement.
    pub timing: StreamTiming,
    /// Streaming buffer size in milliseconds (100-1000, default 200).
    /// Used to calculate cadence queue size for PCM streams.
    pub streaming_buffer_ms: u64,
    /// Frame duration in milliseconds for cadence timing.
    /// Determines silence frame duration and cadence tick interval.
    pub frame_duration_ms: u32,
    /// Timestamp of last push_frame call (for inter-frame jitter tracking).
    last_push_at: parking_lot::Mutex<Option<Instant>>,
    /// Receive jitter stats, reset periodically by the cadence pipeline.
    receive_stats: parking_lot::Mutex<ReceiveStats>,
}

impl StreamState {
    /// Creates a new StreamState instance.
    ///
    /// # Arguments
    /// * `id` - Unique stream identifier
    /// * `codec` - Output codec for HTTP Content-Type (what Sonos receives)
    /// * `audio_format` - Audio format configuration (sample rate, channels, bit depth)
    /// * `buffer_frames` - Maximum frames to buffer for late-joining clients
    /// * `channel_capacity` - Capacity of the broadcast channel for audio frames
    /// * `streaming_buffer_ms` - Streaming buffer size in milliseconds (100-1000)
    /// * `frame_duration_ms` - Frame duration in milliseconds for cadence timing
    pub fn new(
        id: String,
        codec: AudioCodec,
        audio_format: AudioFormat,
        buffer_frames: usize,
        channel_capacity: usize,
        streaming_buffer_ms: u64,
        frame_duration_ms: u32,
    ) -> Self {
        let (tx, _) = broadcast::channel(channel_capacity);
        log::debug!(
            "[Stream] Creating {} with codec {:?}, format {:?}, buffer: {}ms, frame: {}ms",
            id,
            codec,
            audio_format,
            streaming_buffer_ms,
            frame_duration_ms
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
            timing: StreamTiming::new(),
            streaming_buffer_ms,
            frame_duration_ms,
            last_push_at: parking_lot::Mutex::new(None),
            receive_stats: parking_lot::Mutex::new(ReceiveStats::new()),
        }
    }

    /// Pushes a new audio frame into the stream.
    ///
    /// The frame is timestamped, added to the buffer, and broadcast to HTTP clients.
    ///
    /// Returns `true` if this was the first frame (stream just became ready),
    /// `false` otherwise.
    pub fn push_frame(&self, frame: Bytes) -> bool {
        let captured_at = Instant::now();

        // Track inter-frame arrival jitter
        {
            let mut stats = self.receive_stats.lock();
            stats.frames_received += 1;

            if let Some(prev) = self.last_push_at.lock().replace(captured_at) {
                let gap_ms = captured_at.duration_since(prev).as_millis() as u64;
                stats.min_gap_ms = stats.min_gap_ms.min(gap_ms);
                stats.max_gap_ms = stats.max_gap_ms.max(gap_ms);
                if gap_ms > (self.frame_duration_ms as u64) * 2 {
                    stats.gaps_over_threshold += 1;
                }
            }
        }

        // Add to recent buffer (ring buffer behavior)
        // Clone the Bytes (cheap - just Arc bump) for buffer storage
        {
            let mut buffer = self.buffer.write();
            if buffer.len() >= self.buffer_frames {
                buffer.pop_front();
            }
            buffer.push_back(TimestampedFrame {
                captured_at,
                data: frame.clone(),
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
        if let Err(e) = self.tx.send(frame) {
            log::trace!("Failed to broadcast frame for stream {}: {}", self.id, e);
        }

        is_first_frame
    }

    /// Snapshots and resets receive jitter stats for the current window.
    ///
    /// Called periodically by the cadence pipeline to capture per-interval
    /// receive statistics without accumulating unbounded state.
    pub fn snapshot_and_reset_receive_stats(&self) -> ReceiveStats {
        let mut stats = self.receive_stats.lock();
        let snapshot = stats.clone();
        *stats = ReceiveStats::new();
        snapshot
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

/// Thread-safe registry of active audio streams.
///
/// Provides keyed storage and concurrency-limited creation of [`StreamState`]
/// instances. This is a low-level data structure — high-level orchestration
/// (playback, speaker control, events) lives in [`StreamCoordinator`].
pub struct StreamRegistry {
    streams: DashMap<String, Arc<StreamState>>,
    /// Streaming configuration (concurrency, buffering, channel capacity).
    config: StreamingConfig,
}

impl StreamRegistry {
    /// Creates a new StreamRegistry instance.
    ///
    /// # Arguments
    /// * `config` - Streaming configuration (concurrency, buffering, channel capacity)
    pub fn new(config: StreamingConfig) -> Self {
        Self {
            streams: DashMap::new(),
            config,
        }
    }

    /// Creates a new stream and returns its ID.
    ///
    /// # Arguments
    /// * `codec` - Output codec for HTTP Content-Type (what Sonos receives)
    /// * `audio_format` - Audio format configuration (sample rate, channels, bit depth)
    /// * `streaming_buffer_ms` - Streaming buffer size in milliseconds (100-1000)
    /// * `frame_duration_ms` - Frame duration in milliseconds for cadence timing
    pub fn create_stream(
        &self,
        codec: AudioCodec,
        audio_format: AudioFormat,
        streaming_buffer_ms: u64,
        frame_duration_ms: u32,
    ) -> Result<String, String> {
        if self.streams.len() >= self.config.max_concurrent_streams {
            return Err("Maximum number of concurrent streams reached".to_string());
        }

        let id = Uuid::new_v4().to_string();
        let state = Arc::new(StreamState::new(
            id.clone(),
            codec,
            audio_format,
            self.config.buffer_frames,
            self.config.channel_capacity,
            streaming_buffer_ms,
            frame_duration_ms,
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
