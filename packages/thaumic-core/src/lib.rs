//! Thaumic Core - shared library for Thaumic Cast.
//!
//! This crate provides the core functionality for Thaumic Cast, a browser-to-Sonos
//! audio streaming system. It is designed to be used by both the desktop app (Tauri)
//! and a standalone headless server.
//!
//! # Architecture
//!
//! The crate is organized into several modules:
//!
//! - [`runtime`]: Task spawning abstraction for async runtime independence
//! - [`events`]: Event system for real-time client communication
//! - [`context`]: Network configuration and URL building
//! - [`state`]: Core application state and configuration
//! - [`sonos`]: Sonos speaker control and discovery (UPnP/SOAP)
//! - [`stream`]: Audio streaming and transcoding
//! - [`error`]: Centralized error types
//!
//! # Abstraction Traits
//!
//! The crate defines several traits to decouple core logic from platform-specific
//! implementations:
//!
//! - [`TaskSpawner`](runtime::TaskSpawner): Spawning background tasks
//! - [`EventEmitter`](events::EventEmitter): Emitting domain events
//! - [`IpDetector`](context::IpDetector): Local IP detection
//!
//! Each trait has default implementations suitable for the standalone server.
//! The desktop app provides Tauri-specific implementations.

// Allow missing docs for now during migration - will be cleaned up later
#![allow(missing_docs)]
#![warn(clippy::all)]

pub mod api;
pub mod artwork;
pub mod bootstrap;
pub mod context;
pub mod error;
pub mod events;
mod mdns_advertise;
pub mod protocol_constants;
pub mod runtime;
pub mod services;
pub mod sonos;
pub mod state;
pub mod stream;
pub mod streaming_runtime;
pub mod utils;

// Re-export commonly used types at the crate root
pub use artwork::{ArtworkConfig, ArtworkSource};
pub use context::{IpDetector, LocalIpDetector, NetworkContext, NetworkError, UrlBuilder};
pub use error::{DiscoveryResult, ErrorCode, GenaResult, SoapResult, ThaumicError, ThaumicResult};
pub use events::{
    BroadcastEvent, BroadcastEventBridge, EventEmitter, LatencyEvent, NetworkEvent, NetworkHealth,
    SonosEvent, SpeakerRemovalReason, StreamEvent, TopologyEvent,
};
pub use runtime::{TaskSpawner, TokioSpawner};
pub use state::{Config, ManualSpeakerConfig, SonosState, StreamingConfig};
pub use utils::{now_millis, validate_speaker_ip, IpValidationError};

// Re-export Sonos types
pub use sonos::discovery::{probe_speaker_by_ip, Speaker};
pub use sonos::types::{TransportState, ZoneGroup};
pub use sonos::{SonosClient, SonosClientImpl, SonosPlayback, SonosService, SonosTopologyClient};

// Re-export service types
pub use services::playback_session_store::PlaybackSession;

// Re-export stream types
pub use stream::{AudioCodec, AudioFormat, StreamMetadata, TaggedFrame};

// Re-export bootstrap types
pub use bootstrap::{bootstrap_services, bootstrap_services_with_network, BootstrappedServices};

// Re-export streaming runtime
pub use streaming_runtime::StreamingRuntime;

// Re-export API types
pub use api::{start_server, AppState, AppStateBuilder, ServerError, WsConnectionManager};

/// Default artwork for Sonos album art display.
///
/// This image is embedded at compile time and served via the `/artwork.jpg` HTTP endpoint
/// when no custom artwork is configured. The [`ArtworkConfig`] resolution chain uses this
/// as the final fallback.
///
/// # Platform Note: Android TLS Requirement
///
/// The Android Sonos app blocks `http://` URLs for album art, requiring HTTPS.
/// The iOS app works with both HTTP and HTTPS.
///
/// For album art to display on Android, host the image on an HTTPS endpoint
/// (e.g., a CDN or cloud storage) and configure via [`ArtworkConfig::url`].
///
/// Reference: <https://github.com/amp64/sonosbugtracker/issues/33>
pub static DEFAULT_ARTWORK: &[u8] = include_bytes!("../assets/artwork-template.jpg");
