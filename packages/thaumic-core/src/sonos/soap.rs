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
// SOAP Request Builder
// ─────────────────────────────────────────────────────────────────────────────

use super::services::SonosService;

/// Builder for constructing and sending SOAP requests to Sonos speakers.
///
/// Provides a fluent API that reduces boilerplate when making SOAP calls.
///
/// # Example
/// ```ignore
/// let response = SoapRequestBuilder::new(&client, "192.168.1.100")
///     .service(SonosService::AVTransport)
///     .action("Play")
///     .arg("InstanceID", "0")
///     .arg("Speed", "1")
///     .send()
///     .await?;
/// ```
pub struct SoapRequestBuilder<'a> {
    client: &'a Client,
    ip: &'a str,
    service: Option<SonosService>,
    action: Option<&'a str>,
    args: Vec<(&'a str, String)>,
}

impl<'a> SoapRequestBuilder<'a> {
    /// Creates a new SOAP request builder.
    ///
    /// # Arguments
    /// * `client` - The HTTP client to use for the request
    /// * `ip` - IP address of the Sonos speaker
    #[must_use]
    pub fn new(client: &'a Client, ip: &'a str) -> Self {
        Self {
            client,
            ip,
            service: None,
            action: None,
            args: Vec::new(),
        }
    }

    /// Sets the Sonos service for this request.
    #[must_use]
    pub fn service(mut self, service: SonosService) -> Self {
        self.service = Some(service);
        self
    }

    /// Sets the SOAP action name.
    #[must_use]
    pub fn action(mut self, action: &'a str) -> Self {
        self.action = Some(action);
        self
    }

    /// Adds an argument to the SOAP request.
    ///
    /// Arguments are included in the SOAP body in the order they are added.
    #[must_use]
    pub fn arg(mut self, key: &'a str, value: impl Into<String>) -> Self {
        self.args.push((key, value.into()));
        self
    }

    /// Adds the standard InstanceID="0" argument used by most Sonos actions.
    #[must_use]
    pub fn instance_id(self) -> Self {
        self.arg("InstanceID", "0")
    }

    /// Sends the SOAP request and returns the response body.
    ///
    /// # Errors
    /// Returns `SoapError` if the service or action is not set, or if the
    /// request fails.
    pub async fn send(self) -> SoapResult<String> {
        let service = self
            .service
            .ok_or_else(|| SoapError::Fault("SoapRequestBuilder: service not set".into()))?;
        let action = self
            .action
            .ok_or_else(|| SoapError::Fault("SoapRequestBuilder: action not set".into()))?;

        // Convert to slice of (&str, &str) - preserves insertion order
        let args: Vec<(&str, &str)> = self.args.iter().map(|(k, v)| (*k, v.as_str())).collect();

        send_soap_request(
            self.client,
            self.ip,
            service.control_path(),
            service.urn(),
            action,
            &args,
        )
        .await
    }

    /// Returns the request parts without sending (for testing).
    ///
    /// # Returns
    /// Tuple of (service, action, args) if both service and action are set.
    #[cfg(test)]
    pub fn into_parts(self) -> Option<(SonosService, &'a str, Vec<(&'a str, String)>)> {
        let service = self.service?;
        let action = self.action?;
        Some((service, action, self.args))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_client() -> Client {
        Client::new()
    }

    #[test]
    fn builder_captures_service_and_action() {
        let client = test_client();
        let parts = SoapRequestBuilder::new(&client, "192.168.1.100")
            .service(SonosService::RenderingControl)
            .action("GetVolume")
            .into_parts();

        let (service, action, args) = parts.expect("should have parts");
        assert_eq!(service, SonosService::RenderingControl);
        assert_eq!(action, "GetVolume");
        assert!(args.is_empty());
    }

    #[test]
    fn builder_captures_args_in_order() {
        let client = test_client();
        let parts = SoapRequestBuilder::new(&client, "192.168.1.100")
            .service(SonosService::RenderingControl)
            .action("SetVolume")
            .instance_id()
            .arg("Channel", "Master")
            .arg("DesiredVolume", "75")
            .into_parts();

        let (_, _, args) = parts.expect("should have parts");
        assert_eq!(args.len(), 3);
        assert_eq!(args[0], ("InstanceID", "0".to_string()));
        assert_eq!(args[1], ("Channel", "Master".to_string()));
        assert_eq!(args[2], ("DesiredVolume", "75".to_string()));
    }

    #[test]
    fn into_parts_returns_none_without_service() {
        let client = test_client();
        let parts = SoapRequestBuilder::new(&client, "192.168.1.100")
            .action("GetVolume")
            .into_parts();

        assert!(parts.is_none());
    }

    #[test]
    fn into_parts_returns_none_without_action() {
        let client = test_client();
        let parts = SoapRequestBuilder::new(&client, "192.168.1.100")
            .service(SonosService::RenderingControl)
            .into_parts();

        assert!(parts.is_none());
    }
}
