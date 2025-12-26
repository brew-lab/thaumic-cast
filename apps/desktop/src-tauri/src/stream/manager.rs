use bytes::Bytes;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::config::{MAX_CONCURRENT_STREAMS, STREAM_BUFFER_FRAMES, STREAM_CHANNEL_CAPACITY};

/// Supported audio codecs for the stream
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AudioCodec {
    Wav,
    Aac,
    Mp3,
    Flac,
}

/// Metadata for the current track
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StreamMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub artwork: Option<String>,
}

/// State for a single active audio stream
pub struct StreamState {
    pub id: String,
    pub codec: AudioCodec,
    pub metadata: Arc<parking_lot::RwLock<StreamMetadata>>,
    /// Broadcast channel for distributing audio frames to HTTP clients
    pub tx: broadcast::Sender<Bytes>,
    /// Recent frames buffer to handle network jitter
    pub buffer: Arc<parking_lot::RwLock<VecDeque<Bytes>>>,
    /// Whether the stream has received its first frame (for STREAM_READY signaling)
    has_frames: AtomicBool,
}

impl StreamState {
    /// Creates a new StreamState instance.
    pub fn new(id: String, codec: AudioCodec) -> Self {
        let (tx, _) = broadcast::channel(STREAM_CHANNEL_CAPACITY);
        Self {
            id,
            codec,
            metadata: Arc::new(parking_lot::RwLock::new(StreamMetadata::default())),
            tx,
            buffer: Arc::new(parking_lot::RwLock::new(VecDeque::with_capacity(
                STREAM_BUFFER_FRAMES,
            ))),
            has_frames: AtomicBool::new(false),
        }
    }

    /// Pushes a new audio frame into the stream.
    ///
    /// Returns `true` if this was the first frame (stream just became ready),
    /// `false` otherwise.
    pub fn push_frame(&self, frame: Bytes) -> bool {
        // Add to recent buffer (ring buffer behavior)
        {
            let mut buffer = self.buffer.write();
            if buffer.len() >= STREAM_BUFFER_FRAMES {
                buffer.pop_front();
            }
            buffer.push_back(frame.clone());
        }

        // Signal ready on first frame (compare_exchange ensures only first frame triggers)
        let is_first_frame = self
            .has_frames
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();

        if is_first_frame {
            log::debug!("[Stream] {} is now ready (first frame received)", self.id);
        }

        // Broadcast to all active HTTP listeners
        if let Err(e) = self.tx.send(frame) {
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

    /// Creates a new stream and returns its ID.
    pub fn create_stream(&self, codec: AudioCodec) -> Result<String, String> {
        if self.streams.len() >= MAX_CONCURRENT_STREAMS {
            return Err("Maximum number of concurrent streams reached".to_string());
        }

        let id = Uuid::new_v4().to_string();
        let state = Arc::new(StreamState::new(id.clone(), codec));
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

    /// Removes all active streams.
    ///
    /// Returns the number of streams that were cleared.
    pub fn clear_all(&self) -> usize {
        let count = self.streams.len();
        self.streams.clear();
        log::info!("[StreamManager] Cleared {} stream(s)", count);
        count
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
