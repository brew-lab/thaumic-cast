use bytes::Bytes;
use parking_lot::RwLock;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::broadcast;

use crate::sonos::StreamMetadata;

const MAX_BUFFER_FRAMES: usize = 300; // ~10 seconds at 30fps MP3 frames
const MAX_SUBSCRIBERS: usize = 5;
const CHANNEL_CAPACITY: usize = 100;

/// ICY metadata interval (bytes between metadata blocks)
pub const ICY_METAINT: usize = 8192;

/// State for a single active stream
pub struct StreamState {
    pub id: String,
    buffer: RwLock<VecDeque<Bytes>>,
    sender: broadcast::Sender<Bytes>,
    subscriber_count: RwLock<usize>,
    metadata: RwLock<Option<StreamMetadata>>,
    speaker_ip: RwLock<Option<String>>,
}

impl StreamState {
    pub fn new(id: String) -> Self {
        let (sender, _) = broadcast::channel(CHANNEL_CAPACITY);
        Self {
            id,
            buffer: RwLock::new(VecDeque::with_capacity(MAX_BUFFER_FRAMES)),
            sender,
            subscriber_count: RwLock::new(0),
            metadata: RwLock::new(None),
            speaker_ip: RwLock::new(None),
        }
    }

    /// Set stream metadata for ICY injection
    pub fn set_metadata(&self, metadata: StreamMetadata) {
        *self.metadata.write() = Some(metadata);
    }

    /// Get current stream metadata
    pub fn get_metadata(&self) -> Option<StreamMetadata> {
        self.metadata.read().clone()
    }

    /// Set the speaker IP for this stream
    pub fn set_speaker_ip(&self, ip: String) {
        *self.speaker_ip.write() = Some(ip);
    }

    /// Get the speaker IP for this stream
    pub fn get_speaker_ip(&self) -> Option<String> {
        self.speaker_ip.read().clone()
    }

    /// Push a frame to the stream buffer and broadcast to subscribers
    pub fn push_frame(&self, frame: Bytes) {
        let mut buffer = self.buffer.write();

        // Add to buffer
        buffer.push_back(frame.clone());

        // Evict oldest frames if over limit
        while buffer.len() > MAX_BUFFER_FRAMES {
            buffer.pop_front();
        }

        // Broadcast to all subscribers (ignoring errors for dropped receivers)
        let _ = self.sender.send(frame);
    }

    /// Subscribe to receive frames from this stream
    pub fn subscribe(&self) -> Result<StreamSubscription, &'static str> {
        let mut count = self.subscriber_count.write();
        if *count >= MAX_SUBSCRIBERS {
            return Err("Max subscribers reached");
        }
        *count += 1;

        // Get buffered frames for pre-fill
        let buffer = self.buffer.read();
        let buffered_frames: Vec<Bytes> = buffer.iter().cloned().collect();

        Ok(StreamSubscription {
            receiver: self.sender.subscribe(),
            buffered_frames,
        })
    }

    /// Unsubscribe (decrement counter)
    pub fn unsubscribe(&self) {
        let mut count = self.subscriber_count.write();
        if *count > 0 {
            *count -= 1;
        }
    }

    pub fn subscriber_count(&self) -> usize {
        *self.subscriber_count.read()
    }
}

/// A subscription to a stream with pre-filled buffer
pub struct StreamSubscription {
    pub receiver: broadcast::Receiver<Bytes>,
    pub buffered_frames: Vec<Bytes>,
}

/// Event payload emitted when active_streams count changes
#[derive(Debug, Clone, Serialize)]
pub struct StreamsChangedPayload {
    pub active_streams: u64,
}

/// Manages all active streams
pub struct StreamManager {
    streams: RwLock<HashMap<String, Arc<StreamState>>>,
    app_handle: RwLock<Option<tauri::AppHandle>>,
}

impl StreamManager {
    pub fn new() -> Self {
        Self {
            streams: RwLock::new(HashMap::new()),
            app_handle: RwLock::new(None),
        }
    }

    /// Set the app handle for emitting events
    pub fn set_app_handle(&self, handle: tauri::AppHandle) {
        *self.app_handle.write() = Some(handle);
    }

    /// Emit streams-changed event
    fn emit_streams_changed(&self) {
        let count = self.streams.read().len() as u64;
        if let Some(ref handle) = *self.app_handle.read() {
            let payload = StreamsChangedPayload {
                active_streams: count,
            };
            if let Err(e) = handle.emit("streams-changed", &payload) {
                log::warn!("[StreamManager] Failed to emit streams-changed: {}", e);
            }
        }
    }

    /// Get or create a stream by ID
    pub fn get_or_create(&self, id: &str) -> Arc<StreamState> {
        let mut streams = self.streams.write();

        if let Some(stream) = streams.get(id) {
            return Arc::clone(stream);
        }

        let stream = Arc::new(StreamState::new(id.to_string()));
        streams.insert(id.to_string(), Arc::clone(&stream));
        drop(streams); // Release lock before emitting
        self.emit_streams_changed();
        self.streams.read().get(id).unwrap().clone()
    }

    /// Get an existing stream by ID
    pub fn get(&self, id: &str) -> Option<Arc<StreamState>> {
        self.streams.read().get(id).cloned()
    }

    /// Remove a stream
    pub fn remove(&self, id: &str) {
        let removed = self.streams.write().remove(id).is_some();
        if removed {
            self.emit_streams_changed();
        }
    }

    /// Get the number of active streams
    pub fn count(&self) -> usize {
        self.streams.read().len()
    }

    /// Find a stream by speaker IP
    pub fn get_by_speaker_ip(&self, speaker_ip: &str) -> Option<Arc<StreamState>> {
        self.streams
            .read()
            .values()
            .find(|s| s.get_speaker_ip().as_deref() == Some(speaker_ip))
            .cloned()
    }

}

impl Default for StreamManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Format metadata as an ICY metadata block
/// Format: [1 byte length (N*16)] [StreamTitle='...'; padded to N*16 bytes]
pub fn format_icy_metadata(metadata: Option<&StreamMetadata>) -> Vec<u8> {
    let title = match metadata {
        Some(m) => match (&m.artist, &m.title) {
            (Some(artist), Some(title)) => format!("{} - {}", artist, title),
            (None, Some(title)) => title.clone(),
            (Some(artist), None) => artist.clone(),
            (None, None) => String::new(),
        },
        None => String::new(),
    };

    if title.is_empty() {
        // Empty metadata block (just a zero byte)
        return vec![0];
    }

    // Escape single quotes in title
    let title = title.replace('\'', "\\'");
    let meta_str = format!("StreamTitle='{}';", title);
    let meta_bytes = meta_str.as_bytes();

    // Calculate number of 16-byte blocks needed
    let len_blocks = (meta_bytes.len() + 15) / 16;
    let padded_len = len_blocks * 16;

    let mut result = Vec::with_capacity(padded_len + 1);
    result.push(len_blocks as u8);
    result.extend_from_slice(meta_bytes);
    result.resize(padded_len + 1, 0); // Pad with zeros
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stream_manager_create() {
        let manager = StreamManager::new();
        let stream = manager.get_or_create("test-stream");
        assert_eq!(stream.id, "test-stream");
        assert_eq!(manager.count(), 1);
    }

    #[test]
    fn test_stream_buffer() {
        let stream = StreamState::new("test".to_string());

        // Push some frames
        for i in 0..5 {
            stream.push_frame(Bytes::from(vec![i as u8]));
        }

        // Subscribe and check buffer
        let sub = stream.subscribe().unwrap();
        assert_eq!(sub.buffered_frames.len(), 5);
    }

    #[test]
    fn test_max_buffer_eviction() {
        let stream = StreamState::new("test".to_string());

        // Push more than MAX_BUFFER_FRAMES
        for i in 0..(MAX_BUFFER_FRAMES + 50) {
            stream.push_frame(Bytes::from(vec![i as u8]));
        }

        let sub = stream.subscribe().unwrap();
        assert_eq!(sub.buffered_frames.len(), MAX_BUFFER_FRAMES);
    }
}
