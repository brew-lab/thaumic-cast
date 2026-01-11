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
        // Emit to Tauri frontend for UI reactivity
        match &event {
            StreamEvent::Created { stream_id, .. } => {
                #[derive(serde::Serialize, Clone)]
                #[serde(rename_all = "camelCase")]
                struct StreamCreatedPayload {
                    stream_id: String,
                }
                self.emit_to_tauri(
                    "stream-created",
                    StreamCreatedPayload {
                        stream_id: stream_id.clone(),
                    },
                );
            }
            StreamEvent::Ended { stream_id, .. } => {
                #[derive(serde::Serialize, Clone)]
                #[serde(rename_all = "camelCase")]
                struct StreamEndedPayload {
                    stream_id: String,
                }
                self.emit_to_tauri(
                    "stream-ended",
                    StreamEndedPayload {
                        stream_id: stream_id.clone(),
                    },
                );
            }
            StreamEvent::PlaybackStarted {
                stream_id,
                speaker_ip,
                ..
            } => {
                #[derive(serde::Serialize, Clone)]
                #[serde(rename_all = "camelCase")]
                struct PlaybackStartedPayload {
                    stream_id: String,
                    speaker_ip: String,
                }
                self.emit_to_tauri(
                    "playback-started",
                    PlaybackStartedPayload {
                        stream_id: stream_id.clone(),
                        speaker_ip: speaker_ip.clone(),
                    },
                );
            }
            StreamEvent::PlaybackStopped {
                stream_id,
                speaker_ip,
                ..
            } => {
                #[derive(serde::Serialize, Clone)]
                #[serde(rename_all = "camelCase")]
                struct PlaybackStoppedPayload {
                    stream_id: String,
                    speaker_ip: String,
                }
                self.emit_to_tauri(
                    "playback-stopped",
                    PlaybackStoppedPayload {
                        stream_id: stream_id.clone(),
                        speaker_ip: speaker_ip.clone(),
                    },
                );
            }
        }

        // Emit to WebSocket broadcast channel
        if let Err(e) = self.tx.send(BroadcastEvent::Stream(event)) {
            log::trace!("[EventBridge] No broadcast receivers: {}", e);
        }
    }

    fn emit_sonos(&self, event: SonosEvent) {
        // Emit transport state changes to Tauri frontend for UI reactivity
        if let SonosEvent::TransportState {
            speaker_ip, state, ..
        } = &event
        {
            #[derive(serde::Serialize, Clone)]
            #[serde(rename_all = "camelCase")]
            struct TransportStatePayload {
                speaker_ip: String,
                state: String,
            }
            self.emit_to_tauri(
                "transport-state-changed",
                TransportStatePayload {
                    speaker_ip: speaker_ip.clone(),
                    state: state.to_string(),
                },
            );
        }

        // Emit to WebSocket broadcast channel
        if let Err(e) = self.tx.send(BroadcastEvent::Sonos(event)) {
            log::trace!("[EventBridge] No broadcast receivers: {}", e);
        }
    }

    fn emit_network(&self, event: NetworkEvent) {
        // Emit to Tauri frontend for UI reactivity
        match &event {
            NetworkEvent::HealthChanged { health, reason, .. } => {
                #[derive(serde::Serialize, Clone)]
                #[serde(rename_all = "camelCase")]
                struct NetworkHealthPayload {
                    health: String,
                    reason: Option<String>,
                }
                self.emit_to_tauri(
                    "network-health-changed",
                    NetworkHealthPayload {
                        health: format!("{:?}", health).to_lowercase(),
                        reason: reason.clone(),
                    },
                );
            }
        }

        // Emit to WebSocket broadcast channel
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
