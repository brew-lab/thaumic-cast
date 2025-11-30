use bytes::Bytes;
use parking_lot::RwLock;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use tokio::sync::broadcast;

const MAX_BUFFER_FRAMES: usize = 300; // ~10 seconds at 30fps MP3 frames
const MAX_SUBSCRIBERS: usize = 5;
const CHANNEL_CAPACITY: usize = 100;

/// State for a single active stream
pub struct StreamState {
    pub id: String,
    buffer: RwLock<VecDeque<Bytes>>,
    sender: broadcast::Sender<Bytes>,
    subscriber_count: RwLock<usize>,
}

impl StreamState {
    pub fn new(id: String) -> Self {
        let (sender, _) = broadcast::channel(CHANNEL_CAPACITY);
        Self {
            id,
            buffer: RwLock::new(VecDeque::with_capacity(MAX_BUFFER_FRAMES)),
            sender,
            subscriber_count: RwLock::new(0),
        }
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

/// Manages all active streams
pub struct StreamManager {
    streams: RwLock<HashMap<String, Arc<StreamState>>>,
}

impl StreamManager {
    pub fn new() -> Self {
        Self {
            streams: RwLock::new(HashMap::new()),
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
        stream
    }

    /// Get an existing stream by ID
    pub fn get(&self, id: &str) -> Option<Arc<StreamState>> {
        self.streams.read().get(id).cloned()
    }

    /// Remove a stream
    pub fn remove(&self, id: &str) {
        self.streams.write().remove(id);
    }

    /// Get the number of active streams
    pub fn count(&self) -> usize {
        self.streams.read().len()
    }
}

impl Default for StreamManager {
    fn default() -> Self {
        Self::new()
    }
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
