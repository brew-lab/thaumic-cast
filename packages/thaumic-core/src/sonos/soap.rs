//! Low-level SOAP protocol implementation for UPnP/Sonos communication.
//!
//! This module handles the raw SOAP envelope building, HTTP transport,
//! and XML response parsing. For high-level Sonos commands, see `client.rs`.

use reqwest::Client;
use thiserror::Error;

use super::utils::{build_sonos_url_with_port, escape_xml, extract_xml_text};

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
    ///
    /// Sonos faults carry `faultstring=UPnPError` and put the meaning in
    /// `detail/UPnPError/errorCode` and `errorDescription`; `code` is that
    /// error code when present and `message` is the description, falling
    /// back to the faultstring.
    #[error("SOAP fault{}: {message}", code.map(|c| format!(" {c}")).unwrap_or_default())]
    Fault {
        /// UPnP error code from the fault detail, if the speaker sent one.
        code: Option<u16>,
        /// Human-readable fault text.
        message: String,
    },

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
            SoapError::Fault { code, message } => {
                matches!(code, Some(701 | 714 | 716))
                    || message.to_lowercase().contains("transition")
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
/// * `port` - TCP port the speaker's UPnP services listen on (1400 on real hardware)
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
    port: u16,
    endpoint: &str,
    service: &str,
    action: &str,
    args: &[(&str, &str)],
) -> SoapResult<String> {
    let url = build_sonos_url_with_port(ip, port, endpoint);

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
        // No per-request timeout: the client's own timeout governs (see
        // `bootstrap::create_http_client`), so tests can shorten it.
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
        return Err(parse_soap_fault(&response_text));
    }

    // Check HTTP status after SOAP fault check (SOAP faults may come with 500 status)
    if !status.is_success() {
        return Err(SoapError::HttpStatus(status.as_u16(), response_text));
    }

    Ok(response_text)
}

/// Builds the [`SoapError::Fault`] a fault response describes.
///
/// Sonos sends `<faultstring>UPnPError</faultstring>` for every fault and
/// puts the meaning in `<detail><UPnPError><errorCode>701</errorCode>
/// <errorDescription>Transition not available</errorDescription>`, so the
/// code has to be read from the detail; the faultstring alone never names it.
fn parse_soap_fault(xml: &str) -> SoapError {
    let code = extract_xml_text(xml, "errorCode").and_then(|c| c.trim().parse().ok());
    let message = extract_xml_text(xml, "errorDescription")
        .filter(|d| !d.trim().is_empty())
        .or_else(|| extract_xml_text(xml, "faultstring"))
        .unwrap_or_else(|| "Unknown SOAP fault".to_string());
    SoapError::Fault { code, message }
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
/// * `port` - TCP port the speaker's UPnP services listen on (1400 on real hardware)
/// * `service` - The Sonos service to target
/// * `action` - The SOAP action name (e.g., "Play", "Stop", "GetVolume")
/// * `args` - Key-value pairs for action arguments (order is preserved)
pub async fn soap_request(
    client: &Client,
    ip: &str,
    port: u16,
    service: SonosService,
    action: &str,
    args: &[(&str, &str)],
) -> SoapResult<String> {
    send_soap_request(
        client,
        ip,
        port,
        service.control_path(),
        service.urn(),
        action,
        args,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape real hardware sends: the code lives in the detail, and the
    /// faultstring is the same for every error.
    const SONOS_FAULT_701: &str = r#"<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>
<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>701</errorCode><errorDescription>Transition not available</errorDescription></UPnPError></detail>
</s:Fault></s:Body></s:Envelope>"#;

    #[test]
    fn a_sonos_fault_yields_its_upnp_code_and_description() {
        let err = parse_soap_fault(SONOS_FAULT_701);
        match &err {
            SoapError::Fault { code, message } => {
                assert_eq!(*code, Some(701));
                assert_eq!(message, "Transition not available");
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(err.is_transient(), "701 is retried");
        assert_eq!(err.to_string(), "SOAP fault 701: Transition not available");
    }

    #[test]
    fn transience_is_decided_by_the_code_not_by_digits_in_the_text() {
        let transient = |code| SoapError::Fault {
            code: Some(code),
            message: "UPnPError".into(),
        };
        assert!(transient(701).is_transient());
        assert!(transient(714).is_transient());
        assert!(transient(716).is_transient());
        assert!(!transient(402).is_transient());
        assert!(!transient(500).is_transient());

        let no_code = SoapError::Fault {
            code: None,
            message: "error 701 in the text but no detail".into(),
        };
        assert!(!no_code.is_transient());
    }

    #[test]
    fn a_fault_without_detail_keeps_the_faultstring() {
        let xml = "<s:Envelope><s:Body><s:Fault><faultcode>s:Client</faultcode>\
                   <faultstring>Something else</faultstring></s:Fault></s:Body></s:Envelope>";
        match parse_soap_fault(xml) {
            SoapError::Fault { code, message } => {
                assert_eq!(code, None);
                assert_eq!(message, "Something else");
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}
