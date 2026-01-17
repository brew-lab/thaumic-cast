//! Centralized error types for the Thaumic Cast core library.
//!
//! This module provides a unified error handling system that:
//! - Defines structured error types using `thiserror`
//! - Maps errors to appropriate HTTP status codes
//! - Implements `IntoResponse` for automatic JSON error responses

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use thiserror::Error;

use crate::sonos::discovery::DiscoveryError;
use crate::sonos::gena::GenaError;
use crate::sonos::soap::SoapError;

/// Trait for error types that provide machine-readable error codes.
///
/// Implement this trait to provide consistent error codes across different
/// error conversion paths.
pub trait ErrorCode {
    /// Returns a machine-readable error code for API responses.
    fn code(&self) -> &'static str;
}

impl ErrorCode for DiscoveryError {
    fn code(&self) -> &'static str {
        match self {
            Self::SocketBind(_) => "socket_bind_failed",
            Self::SendSearch(_) => "ssdp_send_failed",
            Self::NoInterfaces => "no_network_interfaces",
            Self::MdnsDaemon(_) => "mdns_daemon_failed",
            Self::AllMethodsFailed(_) => "all_discovery_methods_failed",
            Self::IpUnreachable(_) => "ip_unreachable",
            Self::NotSonosDevice(_) => "not_sonos_device",
        }
    }
}

impl ErrorCode for SoapError {
    fn code(&self) -> &'static str {
        match self {
            Self::Http(_) => "http_request_failed",
            Self::HttpStatus(_, _) => "http_error_status",
            Self::Fault(_) => "soap_fault",
            Self::Parse => "soap_parse_error",
        }
    }
}

impl ErrorCode for GenaError {
    fn code(&self) -> &'static str {
        match self {
            Self::Http(_) => "http_request_failed",
            Self::SubscriptionFailed(_) => "gena_subscription_failed",
            Self::RenewalFailed(_) => "gena_renewal_failed",
            Self::MissingSid => "gena_missing_sid",
        }
    }
}

/// Application-wide error type for the Thaumic Cast server.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "type", content = "details")]
pub enum ThaumicError {
    /// Speaker discovery failed (SSDP/network issues).
    #[error("Discovery failed: {0}")]
    Discovery(String),

    /// SOAP request to Sonos speaker failed.
    #[error("SOAP request failed: {0}")]
    Soap(String),

    /// Speaker not found or unreachable.
    #[error("Speaker not found: {0}")]
    SpeakerNotFound(String),

    /// Requested stream ID does not exist.
    #[error("Stream not found: {0}")]
    StreamNotFound(String),

    /// Client sent an invalid or malformed request.
    #[error("Invalid request: {0}")]
    InvalidRequest(String),

    /// Invalid IP address for speaker configuration.
    ///
    /// Used for IP validation errors (IPv6, loopback, broadcast, etc.).
    /// Returns `"invalid_ip"` error code for API compatibility.
    #[error("Invalid IP: {0}")]
    InvalidIp(String),

    /// Network-related error (IP detection, connection issues).
    #[error("Network error: {0}")]
    Network(String),

    /// Internal server error.
    #[error("Internal error: {0}")]
    Internal(String),

    /// Server configuration error (missing required settings).
    #[error("Configuration error: {0}")]
    Configuration(String),

    /// Data directory not configured (required for persistence).
    ///
    /// Returns `"data_dir_not_configured"` for API compatibility.
    #[error("Data directory not configured: {0}")]
    DataDirNotConfigured(String),
}

impl ThaumicError {
    /// Returns a machine-readable error code for API responses.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Discovery(_) => "discovery_failed",
            Self::Soap(_) => "soap_error",
            Self::SpeakerNotFound(_) => "speaker_not_found",
            Self::StreamNotFound(_) => "stream_not_found",
            Self::InvalidRequest(_) => "invalid_request",
            Self::InvalidIp(_) => "invalid_ip",
            Self::Network(_) => "network_error",
            Self::Internal(_) => "internal_error",
            Self::Configuration(_) => "configuration_error",
            Self::DataDirNotConfigured(_) => "data_dir_not_configured",
        }
    }

    /// Maps the error to an appropriate HTTP status code.
    pub fn status_code(&self) -> StatusCode {
        match self {
            Self::SpeakerNotFound(_) | Self::StreamNotFound(_) => StatusCode::NOT_FOUND,
            Self::InvalidRequest(_) | Self::InvalidIp(_) => StatusCode::BAD_REQUEST,
            Self::Configuration(_) | Self::DataDirNotConfigured(_) => {
                StatusCode::SERVICE_UNAVAILABLE
            }
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Result Type Aliases
// ─────────────────────────────────────────────────────────────────────────────

// Re-export Result type aliases from their defining modules
pub use crate::sonos::discovery::DiscoveryResult;
pub use crate::sonos::gena::GenaResult;
pub use crate::sonos::soap::SoapResult;

/// Convenient Result alias for application-wide operations.
pub type ThaumicResult<T> = Result<T, ThaumicError>;

/// JSON response body for error responses.
#[derive(Serialize)]
struct ErrorResponse {
    error: &'static str,
    message: String,
    status: u16,
}

impl IntoResponse for ThaumicError {
    fn into_response(self) -> Response {
        let status = self.status_code();
        let body = ErrorResponse {
            error: self.code(),
            message: self.to_string(),
            status: status.as_u16(),
        };
        (status, Json(body)).into_response()
    }
}

impl From<GenaError> for ThaumicError {
    fn from(err: GenaError) -> Self {
        Self::Soap(err.to_string())
    }
}

impl From<SoapError> for ThaumicError {
    fn from(err: SoapError) -> Self {
        Self::Soap(err.to_string())
    }
}

impl From<DiscoveryError> for ThaumicError {
    fn from(err: DiscoveryError) -> Self {
        Self::Discovery(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_ip_error_returns_correct_code() {
        let err = ThaumicError::InvalidIp("test".into());
        assert_eq!(err.code(), "invalid_ip");
        assert_eq!(err.status_code(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn data_dir_not_configured_returns_correct_code() {
        let err = ThaumicError::DataDirNotConfigured("test".into());
        assert_eq!(err.code(), "data_dir_not_configured");
        assert_eq!(err.status_code(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
