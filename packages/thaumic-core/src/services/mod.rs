//! Application services layer.
//!
//! This module contains the business logic services that orchestrate
//! between the API layer and infrastructure (sonos/, stream/).

pub mod discovery_service;
pub mod gena_event_processor;
pub mod latency_monitor;
pub mod stream_coordinator;
pub mod topology_monitor;
pub mod volume;

pub use discovery_service::DiscoveryService;
pub use latency_monitor::LatencyMonitor;
pub use stream_coordinator::{OriginalGroup, PlaybackResult, PlaybackSession, StreamCoordinator};
pub use topology_monitor::{TopologyMonitor, TopologyMonitorConfig};
pub use volume::{
    set_multi_speaker_mute, set_multi_speaker_volume, MultiSpeakerMuteResult,
    MultiSpeakerVolumeResult,
};
