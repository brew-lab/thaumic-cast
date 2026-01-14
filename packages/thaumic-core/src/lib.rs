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
//! - [`lifecycle`]: Application lifecycle control (restart, shutdown)
//! - [`events`]: Event system for real-time client communication
//! - [`context`]: Network configuration and URL building
//! - [`state`]: Core application state and configuration
//!
//! # Abstraction Traits
//!
//! The crate defines several traits to decouple core logic from platform-specific
//! implementations:
//!
//! - [`TaskSpawner`](runtime::TaskSpawner): Spawning background tasks
//! - [`EventEmitter`](events::EventEmitter): Emitting domain events
//! - [`Lifecycle`](lifecycle::Lifecycle): Application lifecycle control
//! - [`IpDetector`](context::IpDetector): Local IP detection
//!
//! Each trait has default implementations suitable for the standalone server.
//! The desktop app provides Tauri-specific implementations.
//!
//! # Example (Standalone Server)
//!
//! ```ignore
//! use std::net::{IpAddr, Ipv4Addr};
//! use thaumic_core::{
//!     context::NetworkContext,
//!     state::{Config, CoreState},
//!     runtime::TokioSpawner,
//! };
//!
//! #[tokio::main]
//! async fn main() {
//!     let config = Config::default();
//!     let network_ctx = NetworkContext::explicit(
//!         8080,
//!         IpAddr::V4(Ipv4Addr::new(192, 168, 1, 100)),
//!     );
//!     let spawner = TokioSpawner::current();
//!
//!     let state = CoreState::new(config, network_ctx);
//!     // Start server...
//! }
//! ```

#![warn(missing_docs)]
#![warn(clippy::all)]

pub mod context;
pub mod events;
pub mod lifecycle;
pub mod runtime;
pub mod state;

// Re-export commonly used types at the crate root
pub use context::{IpDetector, LocalIpDetector, NetworkContext, NetworkError, UrlBuilder};
pub use events::{
    BroadcastEvent, EventEmitter, LatencyEvent, LoggingEventEmitter, NetworkEvent, NetworkHealth,
    NoopEventEmitter, SonosEvent, StreamEvent, TopologyEvent,
};
pub use lifecycle::{Lifecycle, NoopLifecycle, ServerLifecycle};
pub use runtime::{TaskSpawner, TokioSpawner};
pub use state::{Config, CoreState, StreamingConfig};
