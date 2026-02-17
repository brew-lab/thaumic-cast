//! Sonos speaker control and discovery.
//!
//! This module provides functionality for discovering and controlling Sonos speakers
//! on the local network using UPnP/SOAP protocols.
//!
//! # Module Structure
//!
//! - `types` - Domain types for zone groups and speakers
//! - `services` - UPnP service definitions (URNs, paths)
//! - `traits` - Trait abstractions for testability
//! - `client` - High-level Sonos commands (play, stop, volume, mute, zone groups)
//! - `discovery` - Multi-method speaker discovery (SSDP multicast/broadcast + mDNS)
//! - `gena` - UPnP GENA event subscription lifecycle (coordinator)
//! - `gena_client` - GENA HTTP operations
//! - `gena_store` - GENA subscription state management
//! - `gena_event_builder` - GENA notification event construction
//! - `gena_parser` - GENA XML notification parsing
//! - `soap` - Low-level SOAP protocol implementation
//! - `utils` - Shared utility functions

pub mod client;
pub mod discovery;
pub mod gena;
pub mod gena_client;
pub mod gena_event_builder;
pub mod gena_parser;
pub mod gena_store;
pub mod services;
pub mod soap;
pub mod subscription_arbiter;
pub mod traits;
pub mod types;
pub mod utils;

#[cfg(test)]
pub(crate) mod test_fixtures;

// Re-export domain types
pub use services::SonosService;

// Re-export trait abstractions
pub use traits::{SonosClient, SonosPlayback, SonosTopologyClient};

// Re-export concrete implementation
pub use client::SonosClientImpl;
