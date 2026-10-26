//! Low-level SOAP protocol implementation for UPnP/Sonos communication.
//!
//! This module handles the raw SOAP envelope building, HTTP transport,
//! and XML response parsing. For high-level Sonos commands, see `client.rs`.

use std::time::Duration;

use reqwest::{Client, StatusCode};
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

    /// The speaker refused control with a bare 403: the household has the
    /// Sonos app's Connection Security > UPnP switch turned off. Never retried.
    #[error("speaker refused control (HTTP 403): Sonos UPnP is switched off")]
    UpnpDisabled,

    /// A call over the local Control API (port 1443) failed: the speaker
    /// answered with an error, or the socket timed out, closed or could not
    /// be opened. See [`crate::sonos::lan::protocol::code`] for codes.
    #[error("port 1443 {code}: {message}")]
    Lan {
        /// The speaker's `errorCode`, or one of the transport codes.
        code: String,
        /// The speaker's reason, or what the transport saw.
        message: String,
    },
}

/// Whether a response is a Sonos speaker refusing control because the
/// household has UPnP switched off.
///
/// A Sonos speaker with Connection Security > UPnP off answers every SOAP and
/// GENA request with a bare 403 (a `Sonos/` server header and no body). Both
/// signs are required: a VPN or proxy that intercepts LAN traffic can answer
/// 403 itself, and that is a network problem, not this switch.
/// The switch is per household, so one such answer speaks for every speaker.
pub(crate) fn is_upnp_refusal(status: StatusCode, server: Option<&str>, body: &str) -> bool {
    status == StatusCode::FORBIDDEN
        && server.is_some_and(|s| s.contains("Sonos/"))
        && body.trim().is_empty()
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
            SoapError::Lan { code, .. } => super::lan::protocol::is_transient_code(code),
            _ => false,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Request Options
// ─────────────────────────────────────────────────────────────────────────────

/// Per-call transport options for a SOAP request.
///
/// Most actions are user-driven and rare, so the defaults log every call at
/// `info` and leave the timeout to the HTTP client, which bootstrap builds
/// with `SOAP_TIMEOUT_SECS`. Background polls that run for the whole cast use
/// [`SoapOptions::quiet`] so they neither flood the log nor hold a poller for
/// ten seconds when a speaker stops answering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SoapOptions {
    /// How long to wait for the whole request, response body included.
    /// `None` leaves it to the HTTP client's own timeout.
    pub timeout: Option<Duration>,
    /// Level of the per-call "sent" and "completed" log lines.
    pub log_level: log::Level,
}

impl Default for SoapOptions {
    fn default() -> Self {
        Self {
            timeout: None,
            log_level: log::Level::Info,
        }
    }
}

impl SoapOptions {
    /// Options for a periodic background poll: per-call lines at `debug` and
    /// the given timeout.
    #[must_use]
    pub fn quiet(timeout: Duration) -> Self {
        Self {
            timeout: Some(timeout),
            log_level: log::Level::Debug,
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
    send_soap_request_with(
        client,
        ip,
        port,
        endpoint,
        service,
        action,
        args,
        SoapOptions::default(),
    )
    .await
}

/// Sends a SOAP request with explicit [`SoapOptions`].
///
/// Identical to [`send_soap_request`] except for the timeout and the level
/// the per-call log lines are written at.
#[allow(clippy::too_many_arguments)]
pub async fn send_soap_request_with(
    client: &Client,
    ip: &str,
    port: u16,
    endpoint: &str,
    service: &str,
    action: &str,
    args: &[(&str, &str)],
    options: SoapOptions,
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

    log::log!(
        options.log_level,
        "[SOAP] {} -> {} (body: {} bytes)",
        action,
        url,
        body.len()
    );
    log::debug!("[SOAP] Request body: {}", body);

    let start = std::time::Instant::now();
    let request = client
        .post(&url)
        .header("Content-Type", "text/xml; charset=\"utf-8\"")
        .header("SOAPAction", format!("\"{}#{}\"", service, action))
        .body(body);
    // Without a per-call timeout the client's own governs (see
    // `bootstrap::create_http_client`), so tests can shorten it.
    let request = match options.timeout {
        Some(timeout) => request.timeout(timeout),
        None => request,
    };
    let res = request.send().await;

    let elapsed = start.elapsed();
    log::log!(
        options.log_level,
        "[SOAP] {} completed in {:?}: {:?}",
        action,
        elapsed,
        res.as_ref().map(|r| r.status())
    );

    let res = res?;

    let status = res.status();
    let server = res
        .headers()
        .get(reqwest::header::SERVER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let response_text = res.text().await?;

    // Check for SOAP fault in response (can occur even on 500 status)
    if response_text.contains("<s:Fault>") || response_text.contains("<soap:Fault>") {
        return Err(parse_soap_fault(&response_text));
    }

    if is_upnp_refusal(status, server.as_deref(), &response_text) {
        return Err(SoapError::UpnpDisabled);
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
    soap_request_with(
        client,
        ip,
        port,
        service,
        action,
        args,
        SoapOptions::default(),
    )
    .await
}

/// Sends a service-resolved SOAP request with explicit [`SoapOptions`].
///
/// Identical to [`soap_request`] except for the timeout and log level.
pub async fn soap_request_with(
    client: &Client,
    ip: &str,
    port: u16,
    service: SonosService,
    action: &str,
    args: &[(&str, &str)],
    options: SoapOptions,
) -> SoapResult<String> {
    send_soap_request_with(
        client,
        ip,
        port,
        service.control_path(),
        service.urn(),
        action,
        args,
        options,
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

    #[test]
    fn a_bare_403_from_a_speaker_is_a_upnp_refusal() {
        const SONOS: Option<&str> = Some("Linux UPnP/1.0 Sonos/86.10-80260 (ZPS1)");
        let forbidden = StatusCode::FORBIDDEN;
        assert!(is_upnp_refusal(forbidden, SONOS, ""));
        assert!(is_upnp_refusal(forbidden, SONOS, "  \n"));

        // Anything else that says 403 is in the way of the speaker, not the speaker.
        assert!(!is_upnp_refusal(forbidden, SONOS, "<html>Forbidden</html>"));
        assert!(!is_upnp_refusal(forbidden, None, ""));
        assert!(!is_upnp_refusal(forbidden, Some("nginx/1.25"), ""));
        assert!(!is_upnp_refusal(
            forbidden,
            Some("nginx/1.25"),
            "<html>403 Forbidden</html>"
        ));
        assert!(!is_upnp_refusal(StatusCode::UNAUTHORIZED, SONOS, ""));
        assert!(!is_upnp_refusal(StatusCode::NOT_FOUND, SONOS, ""));
        assert!(!is_upnp_refusal(
            StatusCode::INTERNAL_SERVER_ERROR,
            None,
            ""
        ));
    }

    #[test]
    fn a_upnp_refusal_is_never_retried() {
        assert!(!SoapError::UpnpDisabled.is_transient());
    }
}
