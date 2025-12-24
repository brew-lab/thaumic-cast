//! Bridge implementation that maps domain events to broadcast transport.
//!
//! The [`BroadcastEventBridge`] lives at the boundary between domain services
//! and transport concerns, mapping typed domain events to the WebSocket
//! broadcast channel.

use tokio::sync::broadcast;

use super::emitter::EventEmitter;
use super::{BroadcastEvent, StreamEvent};
use crate::sonos::gena::SonosEvent;

/// Bridges domain events to the WebSocket broadcast channel.
///
/// This adapter implements [`EventEmitter`] by forwarding events to a
/// `tokio::sync::broadcast` channel that WebSocket handlers subscribe to.
///
/// # Thread Safety
///
/// The bridge is `Send + Sync` and can be shared across async tasks.
/// The underlying broadcast sender handles concurrent access.
#[derive(Clone)]
pub struct BroadcastEventBridge {
    tx: broadcast::Sender<BroadcastEvent>,
}

impl BroadcastEventBridge {
    /// Creates a new bridge wrapping the given broadcast sender.
    pub fn new(tx: broadcast::Sender<BroadcastEvent>) -> Self {
        Self { tx }
    }
}

impl EventEmitter for BroadcastEventBridge {
    fn emit_stream(&self, event: StreamEvent) {
        if let Err(e) = self.tx.send(BroadcastEvent::Stream(event)) {
            log::trace!("[EventBridge] No broadcast receivers: {}", e);
        }
    }

    fn emit_sonos(&self, event: SonosEvent) {
        if let Err(e) = self.tx.send(BroadcastEvent::Sonos(event)) {
            log::trace!("[EventBridge] No broadcast receivers: {}", e);
        }
    }
}
