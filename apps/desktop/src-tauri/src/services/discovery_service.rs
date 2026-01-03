//! Sonos discovery and GENA subscription management service.
//!
//! This is a facade that orchestrates:
//! - [`TopologyMonitor`] - Background discovery and subscription management
//! - [`GenaEventProcessor`] - Event processing and state updates

use std::sync::Arc;

use reqwest::Client;
use tokio::sync::Notify;

use crate::context::NetworkContext;
use crate::events::EventEmitter;
use crate::sonos::gena::{GenaSubscriptionManager, SonosEvent};
use crate::sonos::SonosTopologyClient;
use crate::state::SonosState;

use super::gena_event_processor::GenaEventProcessor;
use super::stream_coordinator::StreamCoordinator;
use super::topology_monitor::TopologyMonitor;

/// Service responsible for Sonos speaker discovery and GENA event management.
///
/// This is a thin facade that composes [`TopologyMonitor`] and [`GenaEventProcessor`]
/// to provide a unified API for discovery and event handling.
pub struct DiscoveryService {
    topology_monitor: Arc<TopologyMonitor>,
    event_processor: Arc<GenaEventProcessor>,
    gena_manager: Arc<GenaSubscriptionManager>,
    sonos_state: Arc<SonosState>,
}

impl DiscoveryService {
    /// Creates a new DiscoveryService.
    ///
    /// # Arguments
    /// * `sonos` - Sonos client for discovery and topology operations
    /// * `stream_coordinator` - Reference to the stream coordinator for expected stream tracking
    /// * `sonos_state` - Shared Sonos state for groups and transport status
    /// * `emitter` - Event emitter for broadcasting events to clients
    /// * `network` - Network configuration (port, local IP)
    /// * `http_client` - HTTP client for GENA requests
    /// * `topology_refresh_interval_secs` - Interval between automatic topology refreshes
    pub fn new(
        sonos: Arc<dyn SonosTopologyClient>,
        stream_coordinator: Arc<StreamCoordinator>,
        sonos_state: Arc<SonosState>,
        emitter: Arc<dyn EventEmitter>,
        network: NetworkContext,
        http_client: Client,
        topology_refresh_interval_secs: u64,
    ) -> Self {
        let (gena_manager, gena_event_rx) = GenaSubscriptionManager::new(http_client);
        let gena_manager = Arc::new(gena_manager);
        let refresh_notify = Arc::new(Notify::new());

        let topology_monitor = Arc::new(TopologyMonitor::new(
            sonos,
            Arc::clone(&gena_manager),
            Arc::clone(&sonos_state),
            Arc::clone(&emitter),
            network,
            Arc::clone(&refresh_notify),
            topology_refresh_interval_secs,
        ));

        let event_processor = Arc::new(GenaEventProcessor::new(
            Arc::clone(&gena_manager),
            stream_coordinator,
            Arc::clone(&sonos_state),
            emitter,
            gena_event_rx,
            refresh_notify,
        ));

        Self {
            topology_monitor,
            event_processor,
            gena_manager,
            sonos_state,
        }
    }

    /// Returns a reference to the GENA manager.
    pub fn gena_manager(&self) -> &Arc<GenaSubscriptionManager> {
        &self.gena_manager
    }

    /// Returns a reference to the Sonos state.
    pub fn sonos_state(&self) -> &Arc<SonosState> {
        &self.sonos_state
    }

    /// Returns a reference to the topology monitor.
    pub fn topology_monitor(&self) -> &Arc<TopologyMonitor> {
        &self.topology_monitor
    }

    /// Triggers a manual topology refresh.
    pub fn trigger_refresh(&self) {
        self.topology_monitor.trigger_refresh();
    }

    /// Handles a GENA NOTIFY event from an HTTP handler.
    ///
    /// Parses the notification, updates internal state, and broadcasts to WebSocket clients.
    pub fn handle_gena_notify(&self, sid: &str, body: &str) -> Vec<SonosEvent> {
        self.event_processor.handle_gena_notify(sid, body)
    }

    /// Starts the GENA renewal background task.
    pub fn start_renewal_task(&self) {
        self.topology_monitor.start_renewal_task();
    }

    /// Starts the background topology monitor.
    ///
    /// This spawns tasks that:
    /// - Periodically discover speakers and update zone groups
    /// - Manage GENA subscriptions for all discovered speakers
    /// - Handle IP changes by re-subscribing
    /// - Respond to manual refresh requests
    /// - Forward GENA events to WebSocket clients
    pub fn start_topology_monitor(self: Arc<Self>) {
        self.event_processor.start_event_forwarder();
        Arc::clone(&self.topology_monitor).start_monitoring();
    }

    /// Cleans up all GENA subscriptions (for graceful shutdown).
    pub async fn shutdown(&self) {
        self.topology_monitor.shutdown().await;
    }
}
