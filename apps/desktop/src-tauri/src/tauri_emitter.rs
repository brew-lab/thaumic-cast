//! Tauri-specific event emitter for forwarding events to the desktop frontend.
//!
//! This module provides [`TauriEventEmitter`] which implements the
//! [`EventEmitter`] trait from `thaumic-core` and emits events to the
//! Tauri frontend via `AppHandle::emit()`.

use std::sync::Arc;

use parking_lot::RwLock;
use tauri::{AppHandle, Emitter};
use thaumic_core::{
    EventEmitter, LatencyEvent, NetworkEvent, SonosEvent, StreamEvent, TopologyEvent,
};

/// Event emitter that forwards events to the Tauri frontend.
///
/// This adapter implements [`EventEmitter`] by emitting events to the
/// Tauri frontend via `AppHandle::emit()`. It's designed to be set as the
/// external emitter on `BroadcastEventBridge` after the Tauri app is set up.
///
/// # Thread Safety
///
/// Uses `RwLock` internally to allow setting the app handle after construction.
pub struct TauriEventEmitter {
    app_handle: Arc<RwLock<Option<AppHandle>>>,
}

impl TauriEventEmitter {
    /// Creates a new TauriEventEmitter without an app handle.
    ///
    /// Call `set_app_handle()` after Tauri setup to enable event emission.
    pub fn new() -> Self {
        Self {
            app_handle: Arc::new(RwLock::new(None)),
        }
    }

    /// Sets the Tauri app handle for emitting frontend events.
    pub fn set_app_handle(&self, handle: AppHandle) {
        *self.app_handle.write() = Some(handle);
    }

    /// Emits an event to the Tauri frontend if the app handle is set.
    fn emit_to_tauri<T: serde::Serialize + Clone>(&self, event_name: &str, payload: T) {
        if let Some(handle) = self.app_handle.read().as_ref() {
            if let Err(e) = handle.emit(event_name, payload) {
                log::warn!(
                    "[TauriEventEmitter] Failed to emit {} to Tauri: {}",
                    event_name,
                    e
                );
            }
        }
    }
}

impl Default for TauriEventEmitter {
    fn default() -> Self {
        Self::new()
    }
}

impl EventEmitter for TauriEventEmitter {
    fn emit_stream(&self, event: StreamEvent) {
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
    }

    fn emit_network(&self, event: NetworkEvent) {
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
    }

    fn emit_topology(&self, event: TopologyEvent) {
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
    }

    fn emit_latency(&self, _event: LatencyEvent) {
        // Latency events are not forwarded to the Tauri frontend
        // They're only sent to the extension via WebSocket
    }
}
