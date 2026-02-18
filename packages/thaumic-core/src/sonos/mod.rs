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
//! - `client` - `SonosClientImpl` concrete trait implementation
//! - `zone_groups` - Zone group topology parsing and retrieval
//! - `didl` - DIDL-Lite metadata formatting for Sonos display
//! - `playback` - Play, stop, and transport control commands
//! - `volume` - Group and per-speaker volume/mute control
//! - `grouping` - Group join/leave coordination
//! - `discovery` - Multi-method speaker discovery (SSDP multicast/broadcast + mDNS)
//! - `gena` - UPnP GENA event subscription lifecycle (coordinator)
//! - `gena_client` - GENA HTTP operations
//! - `gena_store` - GENA subscription state management
//! - `gena_parser` - GENA notification parsing and event construction
//! - `soap` - Low-level SOAP protocol implementation
//! - `utils` - Shared utility functions

pub mod client;
pub(crate) mod didl;
pub mod discovery;
pub mod gena;
pub mod gena_client;
pub mod gena_parser;
pub mod gena_store;
pub(crate) mod grouping;
pub(crate) mod playback;
pub(crate) mod retry;
pub mod services;
pub mod soap;
pub mod subscription_arbiter;
pub mod traits;
pub mod types;
pub mod utils;
pub(crate) mod volume;
pub(crate) mod zone_groups;

#[cfg(test)]
pub(crate) mod test_fixtures;

// Re-export domain types
pub use services::SonosService;

// Re-export trait abstractions
pub use traits::{SonosClient, SonosPlayback, SonosTopologyClient};

// Re-export concrete implementation
pub use client::SonosClientImpl;
