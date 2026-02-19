//! Error types for Tauri commands.
//!
//! This module provides `CommandError` for Tauri command handlers,
//! with conversions from thaumic-core error types.

use serde::Serialize;
use thaumic_core::ThaumicError;

/// Structured error type for Tauri commands.
///
/// Provides machine-readable error codes alongside human-readable messages,
/// enabling the frontend to handle errors programmatically.
#[derive(Debug, Serialize)]
pub struct CommandError {
    /// Machine-readable error code (e.g., "discovery_failed", "network_error").
    pub code: &'static str,
    /// Human-readable error message.
    pub message: String,
}

impl From<ThaumicError> for CommandError {
    fn from(err: ThaumicError) -> Self {
        Self {
            code: err.code(),
            message: err.to_string(),
        }
    }
}

impl From<thaumic_core::sonos::discovery::DiscoveryError> for CommandError {
    fn from(err: thaumic_core::sonos::discovery::DiscoveryError) -> Self {
        use thaumic_core::sonos::discovery::DiscoveryError;
        let code = match &err {
            DiscoveryError::SocketBind(_) => "socket_bind_failed",
            DiscoveryError::NoInterfaces => "no_network_interfaces",
            DiscoveryError::MdnsDaemon(_) => "mdns_daemon_failed",
            DiscoveryError::AllMethodsFailed(_) => "all_discovery_methods_failed",
            DiscoveryError::IpUnreachable(_) => "ip_unreachable",
            DiscoveryError::NotSonosDevice(_) => "not_sonos_device",
        };
        Self {
            code,
            message: err.to_string(),
        }
    }
}
