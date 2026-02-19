//! Bridge implementation that maps domain events to broadcast transport.
//!
//! The [`BroadcastEventBridge`] lives at the boundary between domain services
//! and transport concerns, mapping typed domain events to the WebSocket
//! broadcast channel.

use std::sync::Arc;

use parking_lot::RwLock;
use tokio::sync::broadcast;

use super::emitter::EventEmitter;
use super::{BroadcastEvent, LatencyEvent, NetworkEvent, SonosEvent, StreamEvent, TopologyEvent};

/// Bridges domain events to the WebSocket broadcast channel.
///
/// This adapter implements [`EventEmitter`] by forwarding events to
/// a `tokio::sync::broadcast` channel that WebSocket handlers subscribe to.
///
/// For platform-specific emission (e.g., Tauri frontend), the bridge also
/// forwards to an optional external emitter that can be set after construction.
///
/// # Thread Safety
///
/// The bridge is `Send + Sync` and can be shared across async tasks.
/// The external emitter uses `RwLock` to allow setting it after construction.
#[derive(Clone)]
pub struct BroadcastEventBridge {
    tx: broadcast::Sender<BroadcastEvent>,
    /// Optional external emitter for platform-specific event delivery
    external_emitter: Arc<RwLock<Option<Arc<dyn EventEmitter>>>>,
}

impl BroadcastEventBridge {
    /// Creates a new bridge with the given channel capacity.
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self {
            tx,
            external_emitter: Arc::new(RwLock::new(None)),
        }
    }

    /// Creates a new bridge wrapping an existing broadcast sender.
    pub fn with_sender(tx: broadcast::Sender<BroadcastEvent>) -> Self {
        Self {
            tx,
            external_emitter: Arc::new(RwLock::new(None)),
        }
    }

    /// Sets an external emitter for platform-specific event delivery.
    ///
    /// This is typically used by the desktop app to forward events to the
    /// Tauri frontend in addition to the WebSocket broadcast.
    ///
    /// Can be called after construction, which is useful when the platform
    /// handle (e.g., Tauri AppHandle) isn't available until later.
    pub fn set_external_emitter(&self, emitter: Arc<dyn EventEmitter>) {
        *self.external_emitter.write() = Some(emitter);
    }

    /// Returns a new receiver for the broadcast channel.
    ///
    /// WebSocket handlers use this to subscribe to events.
    pub fn subscribe(&self) -> broadcast::Receiver<BroadcastEvent> {
        self.tx.subscribe()
    }

    /// Returns a reference to the broadcast sender.
    pub fn sender(&self) -> &broadcast::Sender<BroadcastEvent> {
        &self.tx
    }
}

impl EventEmitter for BroadcastEventBridge {
    fn emit_stream(&self, event: StreamEvent) {
        // Forward to external emitter if configured
        if let Some(ref emitter) = *self.external_emitter.read() {
            emitter.emit_stream(event.clone());
        }

        // Emit to WebSocket broadcast channel
        if let Err(e) = self.tx.send(BroadcastEvent::Stream(event)) {
            log::trace!("[EventBridge] No broadcast receivers: {}", e);
        }
    }

    fn emit_sonos(&self, event: SonosEvent) {
        // Forward to external emitter if configured
        if let Some(ref emitter) = *self.external_emitter.read() {
            emitter.emit_sonos(event.clone());
        }

        // Emit to WebSocket broadcast channel
        if let Err(e) = self.tx.send(BroadcastEvent::Sonos(event)) {
            log::trace!("[EventBridge] No broadcast receivers: {}", e);
        }
    }

    fn emit_network(&self, event: NetworkEvent) {
        // Forward to external emitter if configured
        if let Some(ref emitter) = *self.external_emitter.read() {
            emitter.emit_network(event.clone());
        }

        // Emit to WebSocket broadcast channel
        if let Err(e) = self.tx.send(BroadcastEvent::Network(event)) {
            log::trace!("[EventBridge] No broadcast receivers: {}", e);
        }
    }

    fn emit_topology(&self, event: TopologyEvent) {
        // Forward to external emitter if configured
        if let Some(ref emitter) = *self.external_emitter.read() {
            emitter.emit_topology(event.clone());
        }

        // Emit to WebSocket broadcast channel
        if let Err(e) = self.tx.send(BroadcastEvent::Topology(event)) {
            log::trace!("[EventBridge] No broadcast receivers: {}", e);
        }
    }

    fn emit_latency(&self, event: LatencyEvent) {
        // Forward to external emitter if configured
        if let Some(ref emitter) = *self.external_emitter.read() {
            emitter.emit_latency(event.clone());
        }

        // Emit to WebSocket broadcast channel
        if let Err(e) = self.tx.send(BroadcastEvent::Latency(event)) {
            log::trace!("[EventBridge] No broadcast receivers: {}", e);
        }
    }
}
