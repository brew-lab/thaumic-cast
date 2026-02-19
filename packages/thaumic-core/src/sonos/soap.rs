//! Low-level SOAP protocol implementation for UPnP/Sonos communication.
//!
//! This module handles the raw SOAP envelope building, HTTP transport,
//! and XML response parsing. For high-level Sonos commands, see `client.rs`.

use std::time::Duration;

use reqwest::Client;
use thiserror::Error;

use super::utils::{build_sonos_url, escape_xml, extract_xml_text};
use crate::protocol_constants::SOAP_TIMEOUT_SECS;

// ─────────────────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────────────────

/// Errors that can occur during SOAP operations with Sonos speakers.
#[derive(Debug, Error)]
pub enum SoapError {
    /// HTTP request to the speaker failed.
    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),

    /// Speaker returned a non-success HTTP status without a SOAP fault.
    #[error("HTTP error {0}: {1}")]
    HttpStatus(u16, String),

    /// Speaker returned a SOAP fault response.
    #[error("SOAP fault: {0}")]
    Fault(String),

    /// Failed to parse SOAP response XML.
    #[error("Failed to parse SOAP response")]
    Parse,
}

/// Convenient Result alias for SOAP operations.
pub type SoapResult<T> = Result<T, SoapError>;

impl SoapError {
    /// Returns true if this error is transient and the operation should be retried.
    ///
    /// Transient Sonos SOAP fault codes:
    /// - 701: Transition not available (device changing states)
    /// - 714: Illegal seek target (previous source still loading)
    /// - 716: Resource not found (device busy initializing)
    #[must_use]
    pub fn is_transient(&self) -> bool {
        match self {
            SoapError::Fault(msg) => {
                msg.contains("701")
                    || msg.contains("714")
                    || msg.contains("716")
                    || msg.to_lowercase().contains("transition")
            }
            // Network timeouts can also be transient
            SoapError::Http(e) => e.is_timeout(),
            _ => false,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SOAP Request/Response
// ─────────────────────────────────────────────────────────────────────────────

/// Sends a SOAP request to a Sonos speaker.
///
/// This is the core transport function for all UPnP SOAP operations.
/// It builds the SOAP envelope, sends the HTTP request, and handles
/// SOAP faults in the response.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `ip` - IP address of the Sonos speaker
/// * `endpoint` - The control URL path (e.g., "/MediaRenderer/AVTransport/Control")
/// * `service` - The UPnP service URN (e.g., "urn:schemas-upnp-org:service:AVTransport:1")
/// * `action` - The SOAP action name (e.g., "Play", "Stop", "GetVolume")
/// * `args` - Key-value pairs for action arguments (order is preserved)
///
/// # Returns
/// The response body on success, or a `SoapError` if the request fails
/// or the speaker returns a SOAP fault.
pub async fn send_soap_request(
    client: &Client,
    ip: &str,
    endpoint: &str,
    service: &str,
    action: &str,
    args: &[(&str, &str)],
) -> SoapResult<String> {
    let url = build_sonos_url(ip, endpoint);

    // Build SOAP envelope - must be a single line with no leading whitespace
    // Some SOAP parsers (including Sonos) reject XML with whitespace before the root element
    let mut body = format!(
        r#"<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:{} xmlns:u="{}">"#,
        action, service
    );

    for (k, v) in args {
        // Escape all XML special characters (& < > " ')
        body.push_str(&format!("<{k}>{}</{k}>", escape_xml(v)));
    }

    body.push_str(&format!(r#"</u:{}></s:Body></s:Envelope>"#, action));

    log::info!("[SOAP] {} -> {} (body: {} bytes)", action, url, body.len());
    log::debug!("[SOAP] Request body: {}", body);

    let start = std::time::Instant::now();
    let res = client
        .post(&url)
        .header("Content-Type", "text/xml; charset=\"utf-8\"")
        .header("SOAPAction", format!("\"{}#{}\"", service, action))
        .body(body)
        .timeout(Duration::from_secs(SOAP_TIMEOUT_SECS))
        .send()
        .await;

    let elapsed = start.elapsed();
    log::info!(
        "[SOAP] {} completed in {:?}: {:?}",
        action,
        elapsed,
        res.as_ref().map(|r| r.status())
    );

    let res = res?;

    let status = res.status();
    let response_text = res.text().await?;

    // Check for SOAP fault in response (can occur even on 500 status)
    if response_text.contains("<s:Fault>") || response_text.contains("<soap:Fault>") {
        let fault_msg = extract_fault_string(&response_text)
            .unwrap_or_else(|| "Unknown SOAP fault".to_string());
        return Err(SoapError::Fault(fault_msg));
    }

    // Check HTTP status after SOAP fault check (SOAP faults may come with 500 status)
    if !status.is_success() {
        return Err(SoapError::HttpStatus(status.as_u16(), response_text));
    }

    Ok(response_text)
}

/// Extracts the faultstring from a SOAP fault response.
fn extract_fault_string(xml: &str) -> Option<String> {
    extract_xml_text(xml, "faultstring")
}

// ─────────────────────────────────────────────────────────────────────────────
// Service-aware SOAP Request
// ─────────────────────────────────────────────────────────────────────────────

use super::services::SonosService;

/// Sends a SOAP request using a `SonosService` for endpoint/URN resolution.
///
/// This is the primary entry point for all Sonos SOAP calls. It resolves the
/// service's control path and URN automatically, then delegates to the
/// low-level `send_soap_request`.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `ip` - IP address of the Sonos speaker
/// * `service` - The Sonos service to target
/// * `action` - The SOAP action name (e.g., "Play", "Stop", "GetVolume")
/// * `args` - Key-value pairs for action arguments (order is preserved)
pub async fn soap_request(
    client: &Client,
    ip: &str,
    service: SonosService,
    action: &str,
    args: &[(&str, &str)],
) -> SoapResult<String> {
    send_soap_request(
        client,
        ip,
        service.control_path(),
        service.urn(),
        action,
        args,
    )
    .await
}
