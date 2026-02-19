//! GENA event processing service.
//!
//! Responsibilities:
//! - Processing GENA NOTIFY requests
//! - Updating SonosState based on event types
//! - Broadcasting events to WebSocket clients

use std::sync::Arc;

use parking_lot::Mutex;
use tokio::sync::{mpsc, Notify};

use crate::events::{EventEmitter, SonosEvent};
use crate::runtime::TokioSpawner;
use crate::services::stream_coordinator::StreamCoordinator;
use crate::sonos::gena::GenaSubscriptionManager;
use crate::sonos::gena_parser;
use crate::sonos::services::SonosService;
use crate::state::SonosState;

/// Dependencies required for event processing.
///
/// Extracted to allow sharing between sync and async contexts.
#[derive(Clone)]
struct EventProcessorDeps {
    sonos_state: Arc<SonosState>,
    emitter: Arc<dyn EventEmitter>,
    refresh_notify: Arc<Notify>,
    stream_coordinator: Arc<StreamCoordinator>,
}

/// Processes GENA events and updates application state.
pub struct GenaEventProcessor {
    gena_manager: Arc<GenaSubscriptionManager>,
    deps: EventProcessorDeps,
    gena_event_rx: Arc<Mutex<Option<mpsc::Receiver<SonosEvent>>>>,
    /// Task spawner for background tasks.
    spawner: TokioSpawner,
}

impl GenaEventProcessor {
    /// Creates a new GenaEventProcessor.
    pub fn new(
        gena_manager: Arc<GenaSubscriptionManager>,
        stream_coordinator: Arc<StreamCoordinator>,
        sonos_state: Arc<SonosState>,
        emitter: Arc<dyn EventEmitter>,
        gena_event_rx: mpsc::Receiver<SonosEvent>,
        refresh_notify: Arc<Notify>,
        spawner: TokioSpawner,
    ) -> Self {
        Self {
            gena_manager,
            deps: EventProcessorDeps {
                sonos_state,
                emitter,
                refresh_notify,
                stream_coordinator,
            },
            gena_event_rx: Arc::new(Mutex::new(Some(gena_event_rx))),
            spawner,
        }
    }

    /// Handles a GENA NOTIFY event from an HTTP handler.
    ///
    /// Resolves the subscription, routes to the appropriate parser by service type,
    /// updates internal state, and broadcasts to WebSocket clients.
    pub fn handle_gena_notify(&self, sid: &str, body: &str) -> Vec<SonosEvent> {
        let Some((ip, service)) = self.gena_manager.resolve_sid(sid) else {
            return vec![];
        };

        let events = match service {
            SonosService::AVTransport => {
                let stream_coordinator = Arc::clone(&self.deps.stream_coordinator);
                let get_expected = move |ip: &str| stream_coordinator.get_expected_stream(ip);
                gena_parser::parse_av_transport_events(&ip, body, Some(get_expected))
            }
            SonosService::GroupRenderingControl => {
                gena_parser::parse_group_rendering_events(&ip, body)
            }
            SonosService::ZoneGroupTopology => gena_parser::parse_zone_topology_events(body),
            SonosService::RenderingControl => {
                let events = gena_parser::parse_rendering_control_events(&ip, body);
                log::info!(
                    "[GENA] RenderingControl NOTIFY from {}: {} event(s)",
                    ip,
                    events.len()
                );
                events
            }
        };

        for event in &events {
            self.process_event(event);
        }

        events
    }

    /// Processes a single GENA event: updates local state cache and broadcasts to clients.
    fn process_event(&self, event: &SonosEvent) {
        Self::process_event_with_deps(&self.deps, event);
    }

    /// Core event processing logic shared between sync and async contexts.
    fn process_event_with_deps(deps: &EventProcessorDeps, event: &SonosEvent) {
        match event {
            SonosEvent::TransportState {
                speaker_ip,
                state: transport_state,
                ..
            } => {
                log::info!(
                    "[GenaEventProcessor] Transport state: {} -> {:?}",
                    speaker_ip,
                    transport_state
                );
                deps.sonos_state
                    .transport_states
                    .insert(speaker_ip.clone(), *transport_state);
            }
            SonosEvent::GroupVolume {
                speaker_ip,
                volume,
                fixed,
                ..
            } => {
                log::info!(
                    "[GenaEventProcessor] Group volume change: {} -> {} (fixed: {:?})",
                    speaker_ip,
                    volume,
                    fixed
                );
                deps.sonos_state
                    .group_volumes
                    .insert(speaker_ip.clone(), *volume);
                if let Some(is_fixed) = fixed {
                    deps.sonos_state
                        .group_volume_fixed
                        .insert(speaker_ip.clone(), *is_fixed);
                }
            }
            SonosEvent::GroupMute {
                speaker_ip, muted, ..
            } => {
                log::info!(
                    "[GenaEventProcessor] Group mute change: {} -> {}",
                    speaker_ip,
                    muted
                );
                deps.sonos_state
                    .group_mutes
                    .insert(speaker_ip.clone(), *muted);
            }
            SonosEvent::ZoneGroupsUpdated { groups, .. } => {
                // GENA notification bodies can carry stale topology data
                // (e.g., still showing combined groups after an unjoin).
                // Instead of directly overwriting state with potentially stale
                // data, signal the topology monitor to do a fresh SOAP fetch.
                log::info!(
                    "[GenaEventProcessor] Zone groups changed ({} groups), requesting topology refresh",
                    groups.len()
                );
                deps.refresh_notify.notify_one();
            }
            SonosEvent::SourceChanged {
                speaker_ip,
                current_uri,
                expected_uri,
                ..
            } => {
                log::warn!(
                    "[GenaEventProcessor] Source changed on {}: current={}, expected={:?}",
                    speaker_ip,
                    current_uri,
                    expected_uri
                );
                // Clean up playback session - speaker is no longer playing our stream
                deps.stream_coordinator.handle_source_changed(speaker_ip);
            }
            SonosEvent::SubscriptionLost {
                speaker_ip,
                service,
                reason,
            } => {
                log::error!(
                    "[GenaEventProcessor] Subscription lost for {:?} on {}: {}",
                    service,
                    speaker_ip,
                    reason
                );
                // Trigger a topology refresh to attempt recovery
                deps.refresh_notify.notify_one();
            }
        }

        // Emit event to listeners
        deps.emitter.emit_sonos(event.clone());
    }

    /// Spawns a task to forward internal GENA events (e.g., SubscriptionLost) to WebSocket clients.
    ///
    /// This handles events emitted internally by `GenaSubscriptionManager` (via its mpsc channel),
    /// as opposed to events from HTTP NOTIFY which go through `handle_gena_notify()`.
    ///
    /// Both paths apply the same processing: state updates + broadcast to clients.
    pub fn start_event_forwarder(&self) {
        let deps = self.deps.clone();
        let gena_event_rx = self.gena_event_rx.clone();

        self.spawner.spawn(async move {
            let rx = gena_event_rx.lock().take();
            if let Some(mut rx) = rx {
                while let Some(event) = rx.recv().await {
                    Self::process_event_with_deps(&deps, &event);
                }
            }
        });
    }
}
