//! Application services layer.
//!
//! This module contains the business logic services that orchestrate
//! between the API layer and infrastructure (sonos/, stream/).

pub mod discovery_service;
pub mod gena_event_processor;
pub mod latency_monitor;
pub mod playback_session_store;
pub mod stream_coordinator;
pub(crate) mod sync_group_manager;
pub mod topology_monitor;
pub(crate) mod volume_router;

pub use discovery_service::DiscoveryService;
pub use latency_monitor::LatencyMonitor;
pub use playback_session_store::{GroupRole, PlaybackResult, PlaybackSession};
pub use stream_coordinator::StreamCoordinator;
pub use topology_monitor::{TopologyMonitor, TopologyMonitorConfig};
