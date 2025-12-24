//! Application services layer.
//!
//! This module contains the business logic services that orchestrate
//! between the API layer and infrastructure (sonos/, stream/).

pub mod app_lifecycle;
pub mod discovery_service;
pub mod gena_event_processor;
pub mod stream_coordinator;
pub mod topology_monitor;

pub use app_lifecycle::AppLifecycle;
pub use discovery_service::DiscoveryService;
pub use stream_coordinator::StreamCoordinator;
