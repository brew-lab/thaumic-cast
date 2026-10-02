//! Thaumic Core - shared library for Thaumic Cast.
//!
//! This crate provides the core functionality for Thaumic Cast, a browser-to-Sonos
//! audio streaming system. It is designed to be used by both the desktop app (Tauri)
//! and a standalone headless server.
//!
//! # Architecture
//!
//! The top-level modules, as `docs/ARCHITECTURE.md` lists them (it also
//! gives the rules for which may import which):
//!
//! - [`api`]: the Axum router, REST handlers, the WebSocket handler and the stream handler
//! - [`services`]: orchestration: streams, speaker monitor, topology, discovery, GENA, sync groups
//! - [`stream`]: the data plane: stream state, codec facts, PCM cadence, delivery, framing, URLs
//! - [`sonos`]: UPnP: SOAP commands, zone topology, SSDP and mDNS discovery, GENA subscriptions
//! - [`events`]: the events sent to clients, the [`EventEmitter`](events::EventEmitter) trait
//! - [`model`]: the small value types and pure functions the layers above share
//! - [`state`]: `Config`, `StreamingConfig`, Sonos group and transport state, manual speakers
//! - [`companion_settings`]: resolves the three speaker settings once at start-up
//! - [`context`]: `NetworkContext`: the port, the advertised address, URL building
//! - [`bootstrap`]: the composition root that builds and wires every service
//! - [`streaming_runtime`]: a separate high-priority Tokio runtime for the HTTP server
//! - [`capture`]: traits for a platform audio source and sink, and capture diagnostics
//! - [`protocol_constants`]: fixed values from UPnP, GENA and the audio formats
//! - [`artwork`]: where the album art shown on the speaker comes from
//! - [`error`]: the crate's error types
//! - [`runtime`]: Tokio task spawning
//! - [`utils`]: small helpers shared across the crate
//!
//! The private `mdns_advertise` module advertises the server over mDNS.
//!
//! # Abstraction Traits
//!
//! The crate defines several traits to decouple core logic from platform-specific
//! implementations:
//!
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
pub mod capture;
pub mod companion_settings;
pub mod context;
pub mod error;
pub mod events;
mod mdns_advertise;
pub mod model;
pub mod protocol_constants;
pub mod runtime;
pub mod services;
pub mod sonos;
pub mod state;
pub mod stream;
pub mod streaming_runtime;
#[cfg(test)]
mod testing;
pub mod utils;

// Re-export commonly used types at the crate root
pub use artwork::{ArtworkConfig, ArtworkSource};
pub use companion_settings::{
    CompanionSettings, SettingNames, SettingOrigin, SettingOrigins, SpeakerEnv,
    SpeakerSettingValues,
};
pub use context::{IpDetector, LocalIpDetector, NetworkContext, NetworkError, UrlBuilder};
pub use error::{DiscoveryResult, ErrorCode, GenaResult, SoapResult, ThaumicError, ThaumicResult};
pub use events::{
    BroadcastEvent, BroadcastEventBridge, CompanionAudio, EventEmitter, LatencyEvent, NetworkEvent,
    NetworkHealth, SonosEvent, SpeakerRemovalReason, StreamEvent, TopologyEvent,
};
pub use runtime::TokioSpawner;
pub use services::DriftMode;
pub use state::{Config, ManualSpeakerConfig, SonosState, StreamingConfig};
pub use utils::{
    now_millis, priority_boost_disabled, validate_speaker_ip, IpValidationError,
    NO_PRIORITY_BOOST_ENV,
};

// Re-export Sonos types
pub use sonos::discovery::{probe_speaker_by_ip, Speaker};
pub use sonos::types::{TransportState, ZoneGroup};
pub use sonos::{SonosClient, SonosClientImpl, SonosPlayback, SonosService, SonosTopologyClient};

// Re-export service types
pub use services::playback_session_store::PlaybackSession;

// Re-export capture types
pub use capture::{
    AudioSink, AudioSource, BufferFlags, CaptureError, CaptureHandle, CaptureSourceFactory,
};

// Re-export stream types
pub use stream::{AudioCodec, AudioFormat, StreamMetadata};

// Re-export bootstrap types
pub use bootstrap::{bootstrap_services, bootstrap_services_with_network, BootstrappedServices};

// Re-export streaming runtime
pub use streaming_runtime::StreamingRuntime;

// Re-export API types
pub use api::{start_server, AppInfo, AppState, AppType, ServerError, WsConnectionManager};

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
