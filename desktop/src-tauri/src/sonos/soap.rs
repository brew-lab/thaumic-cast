use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::Client;
use std::collections::HashMap;
use thiserror::Error;

const SONOS_PORT: u16 = 1400;

#[derive(Debug, Error)]
pub enum SoapError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("SOAP fault: {0}")]
    SoapFault(String),
}

/// Build a SOAP envelope for a UPnP action
pub fn build_soap_envelope(
    action: &str,
    service_type: &str,
    params: &HashMap<String, String>,
) -> String {
    let param_xml: String = params
        .iter()
        .map(|(key, value)| {
            // Escape XML special characters
            let escaped = value
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
                .replace('"', "&quot;")
                .replace('\'', "&apos;");
            format!("<{key}>{escaped}</{key}>")
        })
        .collect();

    format!(
        r#"<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:{action} xmlns:u="{service_type}">{param_xml}</u:{action}></s:Body></s:Envelope>"#
    )
}

/// Send a SOAP request to a Sonos speaker
pub async fn send_soap_request(
    client: &Client,
    ip: &str,
    control_url: &str,
    service_type: &str,
    action: &str,
    params: HashMap<String, String>,
) -> Result<String, SoapError> {
    let url = format!("http://{}:{}{}", ip, SONOS_PORT, control_url);
    let body = build_soap_envelope(action, service_type, &params);
    let soap_action = format!("\"{}#{}\"", service_type, action);

    log::debug!("SOAP {} -> {}", action, url);

    let response = client
        .post(&url)
        .header("Content-Type", "text/xml; charset=\"utf-8\"")
        .header("SOAPAction", soap_action)
        .body(body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        log::error!("SOAP error {}: {}", status, error_text);
        return Err(SoapError::SoapFault(format!(
            "SOAP request failed: {} {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Unknown")
        )));
    }

    Ok(response.text().await?)
}

/// Extract a simple text value from SOAP response XML using quick-xml
pub fn extract_soap_value(xml: &str, tag_name: &str) -> Option<String> {
    let mut reader = Reader::from_str(xml);
    let tag_bytes = tag_name.as_bytes();
    let mut in_tag = false;
    let mut result = String::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) if e.local_name().as_ref() == tag_bytes => {
                in_tag = true;
            }
            Ok(Event::Text(e)) if in_tag => {
                if let Ok(text) = e.unescape() {
                    result.push_str(&text);
                }
            }
            Ok(Event::CData(e)) if in_tag => {
                result.push_str(&String::from_utf8_lossy(&e));
            }
            Ok(Event::End(e)) if e.local_name().as_ref() == tag_bytes => {
                return if result.is_empty() {
                    None
                } else {
                    Some(result)
                };
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    None
}

/// Unescape XML entities (used by both SOAP and GENA modules)
pub fn unescape_xml(xml: &str) -> String {
    xml.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_soap_envelope() {
        let mut params = HashMap::new();
        params.insert("InstanceID".to_string(), "0".to_string());

        let envelope = build_soap_envelope(
            "Play",
            "urn:schemas-upnp-org:service:AVTransport:1",
            &params,
        );

        assert!(envelope.contains("<u:Play"));
        assert!(envelope.contains("<InstanceID>0</InstanceID>"));
    }

    #[test]
    fn test_extract_soap_value() {
        let xml = "<root><CurrentVolume>50</CurrentVolume></root>";
        let value = extract_soap_value(xml, "CurrentVolume");
        assert_eq!(value, Some("50".to_string()));
    }

    #[test]
    fn test_unescape_xml() {
        let escaped = "&lt;test&gt;&amp;&quot;";
        let unescaped = unescape_xml(escaped);
        assert_eq!(unescaped, "<test>&\"");
    }
}
