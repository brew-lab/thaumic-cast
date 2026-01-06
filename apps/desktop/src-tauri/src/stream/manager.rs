use bytes::Bytes;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::config::{MAX_CONCURRENT_STREAMS, STREAM_BUFFER_FRAMES, STREAM_CHANNEL_CAPACITY};
use crate::stream::transcoder::{Passthrough, Transcoder};

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

/// Timing information for latency measurement.
///
/// Tracks when audio frames arrive and how much audio has been sent,
/// enabling precise calculation of stream position for latency monitoring.
pub struct StreamTiming {
    /// When the first audio frame was received (for stream start time).
    first_frame_at: parking_lot::RwLock<Option<Instant>>,
    /// Total audio samples sent to Sonos (for calculating stream position).
    samples_sent: AtomicU64,
    /// Audio sample rate in Hz (e.g., 48000).
    sample_rate: AtomicU32,
    /// Number of audio channels (e.g., 2 for stereo).
    channels: AtomicU32,
    /// Bytes per sample (e.g., 2 for 16-bit audio).
    bytes_per_sample: AtomicU32,
}

impl StreamTiming {
    /// Creates a new StreamTiming instance.
    pub fn new() -> Self {
        Self {
            first_frame_at: parking_lot::RwLock::new(None),
            samples_sent: AtomicU64::new(0),
            sample_rate: AtomicU32::new(0),
            channels: AtomicU32::new(2),
            bytes_per_sample: AtomicU32::new(2),
        }
    }

    /// Sets the audio format parameters for sample counting.
    ///
    /// # Arguments
    /// * `sample_rate` - Sample rate in Hz (e.g., 48000)
    /// * `channels` - Number of audio channels (e.g., 2 for stereo)
    /// * `bytes_per_sample` - Bytes per sample (e.g., 2 for 16-bit)
    pub fn set_format(&self, sample_rate: u32, channels: u32, bytes_per_sample: u32) {
        self.sample_rate.store(sample_rate, Ordering::SeqCst);
        self.channels.store(channels, Ordering::SeqCst);
        self.bytes_per_sample
            .store(bytes_per_sample, Ordering::SeqCst);
        log::debug!(
            "[StreamTiming] Format set: {}Hz, {} channels, {} bytes/sample",
            sample_rate,
            channels,
            bytes_per_sample
        );
    }

    /// Records when the first frame was received.
    ///
    /// Returns `true` if this was the first call (timing just started),
    /// `false` if timing was already started.
    pub fn record_first_frame(&self) -> bool {
        let mut first_frame = self.first_frame_at.write();
        if first_frame.is_none() {
            *first_frame = Some(Instant::now());
            true
        } else {
            false
        }
    }

    /// Records that audio samples have been sent.
    ///
    /// # Arguments
    /// * `frame_bytes` - Size of the audio frame in bytes
    pub fn record_samples(&self, frame_bytes: usize) {
        let channels = self.channels.load(Ordering::Relaxed);
        let bytes_per_sample = self.bytes_per_sample.load(Ordering::Relaxed);

        if channels > 0 && bytes_per_sample > 0 {
            let bytes_per_frame = channels * bytes_per_sample;
            let samples = frame_bytes as u64 / bytes_per_frame as u64;
            self.samples_sent.fetch_add(samples, Ordering::Relaxed);
        }
    }

    /// Returns the current stream position in milliseconds.
    ///
    /// Calculated from the total samples sent and the sample rate.
    /// Returns 0 if sample rate is not set.
    #[must_use]
    pub fn position_ms(&self) -> u64 {
        let samples = self.samples_sent.load(Ordering::Relaxed);
        let rate = self.sample_rate.load(Ordering::Relaxed);
        if rate == 0 {
            return 0;
        }
        samples * 1000 / rate as u64
    }

    /// Returns the time since the first frame was received.
    ///
    /// Returns `None` if no frames have been received yet.
    #[must_use]
    pub fn elapsed_since_start(&self) -> Option<std::time::Duration> {
        self.first_frame_at.read().map(|start| start.elapsed())
    }

    /// Returns the sample rate in Hz.
    #[must_use]
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate.load(Ordering::Relaxed)
    }

    /// Returns the total samples sent.
    #[must_use]
    pub fn samples_sent(&self) -> u64 {
        self.samples_sent.load(Ordering::Relaxed)
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
    pub metadata: Arc<parking_lot::RwLock<StreamMetadata>>,
    /// Broadcast channel for distributing audio frames to HTTP clients
    pub tx: broadcast::Sender<Bytes>,
    /// Recent frames buffer to handle network jitter
    pub buffer: Arc<parking_lot::RwLock<VecDeque<Bytes>>>,
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
    /// * `transcoder` - Transcoder for converting input to output format
    pub fn new(id: String, codec: AudioCodec, transcoder: Arc<dyn Transcoder>) -> Self {
        let (tx, _) = broadcast::channel(STREAM_CHANNEL_CAPACITY);
        log::debug!(
            "[Stream] Creating {} with codec {:?}, transcoder: {}",
            id,
            codec,
            transcoder.description()
        );
        Self {
            id,
            codec,
            metadata: Arc::new(parking_lot::RwLock::new(StreamMetadata::default())),
            tx,
            buffer: Arc::new(parking_lot::RwLock::new(VecDeque::with_capacity(
                STREAM_BUFFER_FRAMES,
            ))),
            has_frames: AtomicBool::new(false),
            transcoder,
            timing: StreamTiming::new(),
        }
    }

    /// Creates a new StreamState with passthrough (no transcoding).
    ///
    /// Use this for pre-encoded formats where the browser has already
    /// performed encoding (AAC, FLAC, Vorbis).
    ///
    /// Currently unused - `ws.rs` creates transcoders explicitly via `resolve_codec()`.
    /// Kept for testing and potential future use where passthrough is the common case.
    #[allow(dead_code)]
    pub fn new_passthrough(id: String, codec: AudioCodec) -> Self {
        Self::new(id, codec, Arc::new(Passthrough))
    }

    /// Pushes a new audio frame into the stream.
    ///
    /// The frame is first passed through the transcoder (if any), then
    /// added to the buffer and broadcast to HTTP clients.
    ///
    /// Returns `true` if this was the first frame (stream just became ready),
    /// `false` otherwise.
    pub fn push_frame(&self, frame: Bytes) -> bool {
        // Record timing for the raw input frame (before transcoding)
        // This tracks the audio samples received from the source
        self.timing.record_samples(frame.len());

        // Transcode the frame (PCM → FLAC, or passthrough for pre-encoded)
        let output_frame = self.transcoder.transcode(&frame);

        // Add to recent buffer (ring buffer behavior)
        {
            let mut buffer = self.buffer.write();
            if buffer.len() >= STREAM_BUFFER_FRAMES {
                buffer.pop_front();
            }
            buffer.push_back(output_frame.clone());
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

    /// Subscribes to the stream, returning buffered frames and a live receiver.
    ///
    /// This method atomically captures the current buffer contents and creates
    /// a broadcast receiver, ensuring late-joining clients receive prefill data
    /// without duplicates or gaps.
    ///
    /// # Returns
    /// A tuple of (prefill_frames, live_receiver) where:
    /// - `prefill_frames`: A `Vec<Bytes>` containing buffered frames to send immediately
    /// - `live_receiver`: A `broadcast::Receiver<Bytes>` for subsequent live frames
    pub fn subscribe(&self) -> (Vec<Bytes>, broadcast::Receiver<Bytes>) {
        // Hold the buffer lock while subscribing to ensure atomicity.
        // This prevents races where a frame could appear in both prefill and rx:
        // - Any push_frame() that completes before we lock will have its frame in buffer
        //   AND will have already broadcast (so we won't receive it in rx)
        // - Any push_frame() that starts after we lock will block until we're done,
        //   then broadcast (so we'll receive it in rx, not in prefill)
        let buffer = self.buffer.read();
        let rx = self.tx.subscribe();
        let prefill: Vec<Bytes> = buffer.iter().cloned().collect();

        (prefill, rx)
    }
}

/// Manages all active audio streams in the application.
pub struct StreamManager {
    streams: DashMap<String, Arc<StreamState>>,
}

impl StreamManager {
    /// Creates a new StreamManager instance.
    pub fn new() -> Self {
        Self {
            streams: DashMap::new(),
        }
    }

    /// Creates a new stream with a custom transcoder and returns its ID.
    ///
    /// # Arguments
    /// * `codec` - Output codec for HTTP Content-Type (what Sonos receives)
    /// * `transcoder` - Transcoder for converting input to output format
    pub fn create_stream(
        &self,
        codec: AudioCodec,
        transcoder: Arc<dyn Transcoder>,
    ) -> Result<String, String> {
        if self.streams.len() >= MAX_CONCURRENT_STREAMS {
            return Err("Maximum number of concurrent streams reached".to_string());
        }

        let id = Uuid::new_v4().to_string();
        let state = Arc::new(StreamState::new(id.clone(), codec, transcoder));
        self.streams.insert(id.clone(), state);
        Ok(id)
    }

    /// Creates a new stream with passthrough (no transcoding) and returns its ID.
    ///
    /// Use this for pre-encoded formats where the browser has already
    /// performed encoding (AAC, FLAC, Vorbis).
    ///
    /// Currently unused - `StreamCoordinator::create_stream()` receives the transcoder
    /// from `ws.rs` which creates it via `resolve_codec()`.
    /// Kept for testing and potential future use where passthrough is the common case.
    #[allow(dead_code)]
    pub fn create_stream_passthrough(&self, codec: AudioCodec) -> Result<String, String> {
        self.create_stream(codec, Arc::new(Passthrough))
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

impl Default for StreamManager {
    fn default() -> Self {
        Self::new()
    }
}
