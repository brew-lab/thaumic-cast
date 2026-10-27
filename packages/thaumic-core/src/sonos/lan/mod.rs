//! The Sonos local Control API: a WebSocket on port 1443, used when the
//! household has UPnP switched off and port 1400 refuses control.
//!
//! - `protocol` - frames, commands, error codes and the groups shape
//! - `socket` - one WebSocket to one speaker: replies by `cmdId`, events out
//! - `tls` - TCP and TLS to port 1443, with the speaker's certificate
//!   checked for the player we meant to reach
//! - `hub` - the household's sockets: open on use, reconnect with backoff,
//!   follow a moved group, confirm group changes by reading them back
//! - `client` - the household as the services see it: detection, the
//!   topology from `getGroups`, volume and mute
//! - `volume` - the volume namespaces, and their events as GENA's
//! - `events` - the pump that hands socket events to GENA's channel

pub mod client;
pub mod events;
pub mod hub;
pub mod protocol;
pub mod socket;
pub mod tls;
pub mod volume;

#[cfg(test)]
pub(crate) mod fake;

pub use client::LanClient;
pub use hub::{HubReply, LanHub};
pub use protocol::{Command, Frame, Groups, SpeakerIdentity, Target};
pub use socket::{LanConnector, LanEvent, LanSocket, Reply};
pub use tls::TlsConnector;
