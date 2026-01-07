//! Centralized error types for the Thaumic Cast desktop application.
//!
//! This module provides a unified error handling system that:
//! - Defines structured error types using `thiserror`
//! - Maps errors to appropriate HTTP status codes
//! - Implements `IntoResponse` for automatic JSON error responses
//! - Provides Tauri-compatible serializable errors

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use thiserror::Error;

use crate::api::ServerError;
use crate::sonos::discovery::DiscoveryError;
use crate::sonos::gena::GenaError;
use crate::sonos::soap::SoapError;

/// Trait for error types that provide machine-readable error codes.
///
/// Implement this trait to provide consistent error codes across different
/// error conversion paths (e.g., to `ThaumicError` or `CommandError`).
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

/// Application-wide error type for the Thaumic Cast desktop server.
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

    /// Network-related error (IP detection, connection issues).
    #[error("Network error: {0}")]
    Network(String),

    /// Internal server error.
    #[error("Internal error: {0}")]
    Internal(String),
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
            Self::Network(_) => "network_error",
            Self::Internal(_) => "internal_error",
        }
    }

    /// Maps the error to an appropriate HTTP status code.
    pub fn status_code(&self) -> StatusCode {
        match self {
            Self::SpeakerNotFound(_) | Self::StreamNotFound(_) => StatusCode::NOT_FOUND,
            Self::InvalidRequest(_) => StatusCode::BAD_REQUEST,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Result Type Aliases
// ─────────────────────────────────────────────────────────────────────────────

/// Convenient Result alias for SOAP operations.
pub type SoapResult<T> = Result<T, SoapError>;

/// Convenient Result alias for application-wide operations.
pub type ThaumicResult<T> = Result<T, ThaumicError>;

/// Convenient Result alias for speaker discovery operations.
pub type DiscoveryResult<T> = Result<T, DiscoveryError>;

/// Convenient Result alias for GENA subscription operations.
pub type GenaResult<T> = Result<T, GenaError>;

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

impl From<ServerError> for ThaumicError {
    fn from(err: ServerError) -> Self {
        Self::Network(err.to_string())
    }
}

impl From<DiscoveryError> for ThaumicError {
    fn from(err: DiscoveryError) -> Self {
        Self::Discovery(err.to_string())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri Command Errors
// ─────────────────────────────────────────────────────────────────────────────

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

impl<E: ErrorCode + std::fmt::Display> From<E> for CommandError {
    fn from(err: E) -> Self {
        Self {
            code: err.code(),
            message: err.to_string(),
        }
    }
}
