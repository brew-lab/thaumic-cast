//! Bridge implementation that maps domain events to broadcast transport.
//!
//! The [`BroadcastEventBridge`] lives at the boundary between domain services
//! and transport concerns, mapping typed domain events to the WebSocket
//! broadcast channel and optionally to the Tauri frontend.

use parking_lot::RwLock;
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast;

use super::emitter::EventEmitter;
use super::{BroadcastEvent, LatencyEvent, NetworkEvent, StreamEvent, TopologyEvent};
use crate::sonos::gena::SonosEvent;

/// Bridges domain events to the WebSocket broadcast channel and Tauri frontend.
///
/// This adapter implements [`EventEmitter`] by forwarding events to:
/// 1. A `tokio::sync::broadcast` channel that WebSocket handlers subscribe to
/// 2. The Tauri frontend via `AppHandle::emit()` (when configured)
///
/// # Thread Safety
///
/// The bridge is `Send + Sync` and can be shared across async tasks.
/// The underlying broadcast sender and RwLock handle concurrent access.
#[derive(Clone)]
pub struct BroadcastEventBridge {
    tx: broadcast::Sender<BroadcastEvent>,
    app_handle: std::sync::Arc<RwLock<Option<AppHandle>>>,
}

impl BroadcastEventBridge {
    /// Creates a new bridge wrapping the given broadcast sender.
    pub fn new(tx: broadcast::Sender<BroadcastEvent>) -> Self {
        Self {
            tx,
            app_handle: std::sync::Arc::new(RwLock::new(None)),
        }
    }

    /// Sets the Tauri app handle for emitting frontend events.
    ///
    /// This enables the bridge to emit events to the Tauri frontend
    /// in addition to the WebSocket broadcast channel.
    pub fn set_app_handle(&self, handle: AppHandle) {
        *self.app_handle.write() = Some(handle);
    }

    /// Emits an event to the Tauri frontend if the app handle is set.
    fn emit_to_tauri<T: serde::Serialize + Clone>(&self, event_name: &str, payload: T) {
        if let Some(handle) = self.app_handle.read().as_ref() {
            if let Err(e) = handle.emit(event_name, payload) {
                log::warn!(
                    "[EventBridge] Failed to emit {} to Tauri: {}",
                    event_name,
                    e
                );
            }
        }
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

    fn emit_network(&self, event: NetworkEvent) {
        if let Err(e) = self.tx.send(BroadcastEvent::Network(event)) {
            log::trace!("[EventBridge] No broadcast receivers: {}", e);
        }
    }

    fn emit_topology(&self, event: TopologyEvent) {
        // Emit to Tauri frontend for UI reactivity
        match &event {
            TopologyEvent::GroupsDiscovered { groups, .. } => {
                #[derive(serde::Serialize, Clone)]
                #[serde(rename_all = "camelCase")]
                struct DiscoveryCompletePayload {
                    group_count: usize,
                }
                self.emit_to_tauri(
                    "discovery-complete",
                    DiscoveryCompletePayload {
                        group_count: groups.len(),
                    },
                );
            }
        }

        // Emit to WebSocket broadcast channel
        if let Err(e) = self.tx.send(BroadcastEvent::Topology(event)) {
            log::trace!("[EventBridge] No broadcast receivers: {}", e);
        }
    }

    fn emit_latency(&self, event: LatencyEvent) {
        if let Err(e) = self.tx.send(BroadcastEvent::Latency(event)) {
            log::trace!("[EventBridge] No broadcast receivers: {}", e);
        }
    }
}
