//! Tauri-specific event emitter for forwarding events to the desktop frontend.
//!
//! This module provides [`TauriEventEmitter`] which implements the
//! [`EventEmitter`] trait from `thaumic-core` and emits events to the
//! Tauri frontend via `AppHandle::emit()`.

use std::sync::Arc;

use parking_lot::RwLock;
use tauri::{AppHandle, Emitter};
use thaumic_core::events::frontend_event;
use thaumic_core::{
    BroadcastEvent, EventEmitter, LatencyEvent, NetworkEvent, SonosEvent, StreamEvent,
    TopologyEvent,
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

    /// Emits the frontend's event for `event`, if it has one and the app
    /// handle is set. The names and payloads are core's
    /// [`frontend_event`], shared with the real-app test bridge.
    fn emit_to_tauri(&self, event: &BroadcastEvent) {
        let Some((event_name, payload)) = frontend_event(event) else {
            return;
        };
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
        self.emit_to_tauri(&BroadcastEvent::Stream(event));
    }

    fn emit_sonos(&self, event: SonosEvent) {
        self.emit_to_tauri(&BroadcastEvent::Sonos(event));
    }

    fn emit_network(&self, event: NetworkEvent) {
        self.emit_to_tauri(&BroadcastEvent::Network(event));
    }

    fn emit_topology(&self, event: TopologyEvent) {
        self.emit_to_tauri(&BroadcastEvent::Topology(event));
    }

    fn emit_latency(&self, event: LatencyEvent) {
        self.emit_to_tauri(&BroadcastEvent::Latency(event));
    }
}
