//! GENA (General Event Notification Architecture) listener for Sonos UPnP events
//!
//! Subscribes to Sonos speaker services and receives NOTIFY callbacks when state changes.
//! Events are routed to the StreamManager to forward to connected extensions.

use crate::network::get_local_ip;
use crate::sonos::soap::unescape_xml;
use axum::{
    body::Body,
    extract::{Path, State},
    http::{Method, Request, StatusCode},
    response::IntoResponse,
    routing::any,
    Router,
};
use parking_lot::RwLock;
use reqwest::Client;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

const SONOS_PORT: u16 = 1400;
const GENA_PORT_RANGE: [u16; 5] = [3001, 3002, 3003, 3004, 3005]; // Fallback ports to try
const DEFAULT_TIMEOUT_SECONDS: u64 = 3600;
const RENEWAL_MARGIN_SECONDS: u64 = 300; // Renew 5 minutes before expiry

/// Sonos UPnP services we subscribe to
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GenaService {
    AVTransport,
    RenderingControl,
    ZoneGroupTopology,
}

impl GenaService {
    fn endpoint(&self) -> &'static str {
        match self {
            GenaService::AVTransport => "/MediaRenderer/AVTransport/Event",
            GenaService::RenderingControl => "/MediaRenderer/RenderingControl/Event",
            GenaService::ZoneGroupTopology => "/ZoneGroupTopology/Event",
        }
    }

    fn from_str(s: &str) -> Option<Self> {
        match s {
            "AVTransport" => Some(GenaService::AVTransport),
            "RenderingControl" => Some(GenaService::RenderingControl),
            "ZoneGroupTopology" => Some(GenaService::ZoneGroupTopology),
            _ => None,
        }
    }
}

/// Transport state from AVTransport service
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TransportState {
    Playing,
    #[serde(rename = "PAUSED_PLAYBACK")]
    PausedPlayback,
    Stopped,
    Transitioning,
}

impl TransportState {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "PLAYING" => Some(TransportState::Playing),
            "PAUSED_PLAYBACK" => Some(TransportState::PausedPlayback),
            "STOPPED" => Some(TransportState::Stopped),
            "TRANSITIONING" => Some(TransportState::Transitioning),
            _ => None,
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            TransportState::Playing => "PLAYING",
            TransportState::PausedPlayback => "PAUSED_PLAYBACK",
            TransportState::Stopped => "STOPPED",
            TransportState::Transitioning => "TRANSITIONING",
        }
    }
}

/// Events received from Sonos speakers via GENA
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SonosEvent {
    #[serde(rename = "transportState")]
    TransportState {
        state: String, // Send as string for JSON compatibility
        #[serde(rename = "speakerIp")]
        speaker_ip: String,
        timestamp: u64,
    },
    #[serde(rename = "volume")]
    Volume {
        volume: u8,
        #[serde(rename = "speakerIp")]
        speaker_ip: String,
        timestamp: u64,
    },
    #[serde(rename = "mute")]
    Mute {
        mute: bool,
        #[serde(rename = "speakerIp")]
        speaker_ip: String,
        timestamp: u64,
    },
    #[serde(rename = "zoneChange")]
    ZoneChange { timestamp: u64 },
}

/// Subscription state
struct Subscription {
    #[allow(dead_code)]
    sid: String,
    speaker_ip: String,
    service: GenaService,
    expires_at: Instant,
    #[allow(dead_code)]
    callback_path: String,
}

/// Shared state for the GENA listener
struct GenaState {
    subscriptions: RwLock<HashMap<String, Subscription>>,
    event_tx: mpsc::UnboundedSender<(String, SonosEvent)>,
}

/// GENA listener for Sonos UPnP events
pub struct GenaListener {
    port: RwLock<u16>,
    local_ip: String,
    client: Client,
    state: Arc<GenaState>,
    event_rx: RwLock<Option<mpsc::UnboundedReceiver<(String, SonosEvent)>>>,
    shutdown_tx: RwLock<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl GenaListener {
    /// Create a new GENA listener
    pub fn new(port: u16) -> Result<Self, &'static str> {
        let local_ip = get_local_ip().ok_or("Could not determine local IP address")?;
        let (event_tx, event_rx) = mpsc::unbounded_channel();

        Ok(Self {
            port: RwLock::new(port),
            local_ip,
            client: Client::new(),
            state: Arc::new(GenaState {
                subscriptions: RwLock::new(HashMap::new()),
                event_tx,
            }),
            event_rx: RwLock::new(Some(event_rx)),
            shutdown_tx: RwLock::new(None),
        })
    }

    /// Start the GENA HTTP server
    /// Tries multiple ports if the primary port is in use
    pub async fn start(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let state = Arc::clone(&self.state);
        let local_ip = self.local_ip.clone();
        let configured_port = *self.port.read();

        let app = Router::new()
            .route("/health", any(health_handler))
            .route("/notify/{ip}/{service}", any(notify_handler))
            .with_state(state);

        // Build list of ports to try, starting with the configured port
        let mut ports_to_try: Vec<u16> = vec![configured_port];
        for p in GENA_PORT_RANGE {
            if p != configured_port {
                ports_to_try.push(p);
            }
        }

        let mut bound_port = None;
        let mut last_error = None;

        for try_port in &ports_to_try {
            let addr = format!("0.0.0.0:{}", try_port);
            match tokio::net::TcpListener::bind(&addr).await {
                Ok(listener) => {
                    bound_port = Some((*try_port, listener));
                    break;
                }
                Err(e) => {
                    tracing::warn!("[GENA] Port {} unavailable: {}, trying next...", try_port, e);
                    last_error = Some(e);
                }
            }
        }

        let (actual_port, listener) = bound_port.ok_or_else(|| {
            format!(
                "Could not start GENA listener: all ports in range {}-{} are in use. Last error: {:?}",
                GENA_PORT_RANGE[0],
                GENA_PORT_RANGE[GENA_PORT_RANGE.len() - 1],
                last_error
            )
        })?;

        // Update the port to the actual bound port
        *self.port.write() = actual_port;

        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        *self.shutdown_tx.write() = Some(shutdown_tx);

        tracing::info!("[GENA] Listener started on http://{}:{}", local_ip, actual_port);

        tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await
                .ok();
        });

        Ok(())
    }

    /// Stop the GENA listener
    pub async fn stop(&self) {
        // Send shutdown signal
        if let Some(tx) = self.shutdown_tx.write().take() {
            let _ = tx.send(());
        }

        // Unsubscribe from all
        let sids: Vec<String> = self.state.subscriptions.read().keys().cloned().collect();
        for sid in sids {
            let _ = self.unsubscribe(&sid).await;
        }

        tracing::info!("[GENA] Listener stopped");
    }

    /// Take the event receiver for processing events
    pub fn take_event_receiver(&self) -> Option<mpsc::UnboundedReceiver<(String, SonosEvent)>> {
        self.event_rx.write().take()
    }

    /// Subscribe to a service on a Sonos speaker
    pub async fn subscribe(
        &self,
        speaker_ip: &str,
        service: GenaService,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let port = *self.port.read();
        let event_url = service.endpoint();
        let callback_path = format!(
            "/notify/{}/{}",
            speaker_ip.replace('.', "-"),
            match service {
                GenaService::AVTransport => "AVTransport",
                GenaService::RenderingControl => "RenderingControl",
                GenaService::ZoneGroupTopology => "ZoneGroupTopology",
            }
        );
        let callback_url = format!("http://{}:{}{}", self.local_ip, port, callback_path);

        tracing::info!("[GENA] Subscribing to {:?} on {}", service, speaker_ip);
        tracing::info!("[GENA] Callback URL: {}", callback_url);

        let response = self
            .client
            .request(
                Method::from_bytes(b"SUBSCRIBE").unwrap(),
                format!("http://{}:{}{}", speaker_ip, SONOS_PORT, event_url),
            )
            .header("CALLBACK", format!("<{}>", callback_url))
            .header("NT", "upnp:event")
            .header("TIMEOUT", format!("Second-{}", DEFAULT_TIMEOUT_SECONDS))
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            tracing::error!("[GENA] Subscribe failed: {} - {}", status, error_text);
            return Err(format!("GENA subscribe failed: {}", status).into());
        }

        let sid = response
            .headers()
            .get("SID")
            .and_then(|v| v.to_str().ok())
            .ok_or("No SID in SUBSCRIBE response")?
            .to_string();

        let timeout_seconds = response
            .headers()
            .get("TIMEOUT")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| {
                v.strip_prefix("Second-")
                    .and_then(|s| s.parse::<u64>().ok())
            })
            .unwrap_or(DEFAULT_TIMEOUT_SECONDS);

        let subscription = Subscription {
            sid: sid.clone(),
            speaker_ip: speaker_ip.to_string(),
            service,
            expires_at: Instant::now() + Duration::from_secs(timeout_seconds),
            callback_path,
        };

        self.state
            .subscriptions
            .write()
            .insert(sid.clone(), subscription);

        // Schedule renewal
        self.schedule_renewal(sid.clone(), timeout_seconds);

        tracing::info!(
            "[GENA] Subscribed: SID={}, expires in {}s",
            sid,
            timeout_seconds
        );
        Ok(sid)
    }

    /// Renew a subscription
    pub async fn renew(&self, sid: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let (speaker_ip, service) = {
            let subs = self.state.subscriptions.read();
            let sub = subs.get(sid).ok_or("Unknown subscription")?;
            (sub.speaker_ip.clone(), sub.service)
        };

        let event_url = service.endpoint();

        tracing::info!("[GENA] Renewing subscription {}", sid);

        let response = self
            .client
            .request(
                Method::from_bytes(b"SUBSCRIBE").unwrap(),
                format!("http://{}:{}{}", speaker_ip, SONOS_PORT, event_url),
            )
            .header("SID", sid)
            .header("TIMEOUT", format!("Second-{}", DEFAULT_TIMEOUT_SECONDS))
            .send()
            .await?;

        if !response.status().is_success() {
            tracing::warn!("[GENA] Renewal failed, re-subscribing");
            self.state.subscriptions.write().remove(sid);
            self.subscribe(&speaker_ip, service).await?;
            return Ok(());
        }

        let timeout_seconds = response
            .headers()
            .get("TIMEOUT")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| {
                v.strip_prefix("Second-")
                    .and_then(|s| s.parse::<u64>().ok())
            })
            .unwrap_or(DEFAULT_TIMEOUT_SECONDS);

        // Update expiry
        if let Some(sub) = self.state.subscriptions.write().get_mut(sid) {
            sub.expires_at = Instant::now() + Duration::from_secs(timeout_seconds);
        }

        // Schedule next renewal
        self.schedule_renewal(sid.to_string(), timeout_seconds);

        tracing::info!(
            "[GENA] Renewed: SID={}, expires in {}s",
            sid,
            timeout_seconds
        );
        Ok(())
    }

    /// Unsubscribe from a service
    pub async fn unsubscribe(
        &self,
        sid: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let (speaker_ip, service) = {
            let mut subs = self.state.subscriptions.write();
            match subs.remove(sid) {
                Some(sub) => (sub.speaker_ip, sub.service),
                None => return Ok(()),
            }
        };

        let event_url = service.endpoint();

        let _ = self
            .client
            .request(
                Method::from_bytes(b"UNSUBSCRIBE").unwrap(),
                format!("http://{}:{}{}", speaker_ip, SONOS_PORT, event_url),
            )
            .header("SID", sid)
            .send()
            .await;

        tracing::info!("[GENA] Unsubscribed: {}", sid);
        Ok(())
    }

    /// Unsubscribe from all services for a speaker
    pub async fn unsubscribe_all(
        &self,
        speaker_ip: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let sids: Vec<String> = self
            .state
            .subscriptions
            .read()
            .iter()
            .filter(|(_, sub)| sub.speaker_ip == speaker_ip)
            .map(|(sid, _)| sid.clone())
            .collect();

        for sid in sids {
            let _ = self.unsubscribe(&sid).await;
        }

        Ok(())
    }

    /// Get the number of active subscriptions
    pub fn active_subscriptions(&self) -> usize {
        self.state.subscriptions.read().len()
    }

    /// Get details of all active subscriptions for debugging
    pub fn get_subscriptions(&self) -> Vec<(String, String, GenaService)> {
        self.state
            .subscriptions
            .read()
            .values()
            .map(|sub| (sub.sid.clone(), sub.speaker_ip.clone(), sub.service))
            .collect()
    }

    /// Schedule subscription renewal
    fn schedule_renewal(&self, sid: String, timeout_seconds: u64) {
        let renewal_delay = timeout_seconds.saturating_sub(RENEWAL_MARGIN_SECONDS).max(60);
        let state = Arc::clone(&self.state);
        let client = self.client.clone();
        let local_ip = self.local_ip.clone();
        let port = *self.port.read();

        tokio::spawn(async move {
            schedule_renewal_task(sid, renewal_delay, state, client, local_ip, port).await;
        });
    }
}

/// Standalone renewal task that can be called recursively
async fn schedule_renewal_task(
    sid: String,
    renewal_delay: u64,
    state: Arc<GenaState>,
    client: Client,
    local_ip: String,
    port: u16,
) {
    tokio::time::sleep(Duration::from_secs(renewal_delay)).await;

    // Check if subscription still exists
    let sub_info = {
        let subs = state.subscriptions.read();
        subs.get(&sid).map(|s| (s.speaker_ip.clone(), s.service))
    };

    let Some((speaker_ip, service)) = sub_info else {
        return;
    };

    let event_url = service.endpoint();

    let result = client
        .request(
            Method::from_bytes(b"SUBSCRIBE").unwrap(),
            format!("http://{}:{}{}", speaker_ip, SONOS_PORT, event_url),
        )
        .header("SID", &sid)
        .header("TIMEOUT", format!("Second-{}", DEFAULT_TIMEOUT_SECONDS))
        .send()
        .await;

    match result {
        Ok(response) if response.status().is_success() => {
            let timeout = response
                .headers()
                .get("TIMEOUT")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| {
                    v.strip_prefix("Second-")
                        .and_then(|s| s.parse::<u64>().ok())
                })
                .unwrap_or(DEFAULT_TIMEOUT_SECONDS);

            if let Some(sub) = state.subscriptions.write().get_mut(&sid) {
                sub.expires_at = Instant::now() + Duration::from_secs(timeout);
            }

            tracing::info!("[GENA] Auto-renewed: SID={}", sid);

            // Schedule next renewal recursively
            let next_renewal_delay = timeout.saturating_sub(RENEWAL_MARGIN_SECONDS).max(60);
            Box::pin(schedule_renewal_task(
                sid,
                next_renewal_delay,
                state,
                client,
                local_ip,
                port,
            ))
            .await;
        }
        _ => {
            tracing::warn!(
                "[GENA] Auto-renewal failed for {}, attempting re-subscribe",
                sid
            );
            state.subscriptions.write().remove(&sid);

            // Try to re-subscribe
            let callback_path = format!(
                "/notify/{}/{}",
                speaker_ip.replace('.', "-"),
                match service {
                    GenaService::AVTransport => "AVTransport",
                    GenaService::RenderingControl => "RenderingControl",
                    GenaService::ZoneGroupTopology => "ZoneGroupTopology",
                }
            );
            let callback_url = format!("http://{}:{}{}", local_ip, port, callback_path);

            let resubscribe_result = client
                .request(
                    Method::from_bytes(b"SUBSCRIBE").unwrap(),
                    format!("http://{}:{}{}", speaker_ip, SONOS_PORT, event_url),
                )
                .header("CALLBACK", format!("<{}>", callback_url))
                .header("NT", "upnp:event")
                .header("TIMEOUT", format!("Second-{}", DEFAULT_TIMEOUT_SECONDS))
                .send()
                .await;

            // If re-subscribe succeeded, schedule renewal for the new subscription
            if let Ok(response) = resubscribe_result {
                if response.status().is_success() {
                    if let Some(new_sid) = response
                        .headers()
                        .get("SID")
                        .and_then(|v| v.to_str().ok())
                    {
                        let timeout = response
                            .headers()
                            .get("TIMEOUT")
                            .and_then(|v| v.to_str().ok())
                            .and_then(|v| {
                                v.strip_prefix("Second-")
                                    .and_then(|s| s.parse::<u64>().ok())
                            })
                            .unwrap_or(DEFAULT_TIMEOUT_SECONDS);

                        // Store new subscription
                        let subscription = Subscription {
                            sid: new_sid.to_string(),
                            speaker_ip: speaker_ip.clone(),
                            service,
                            expires_at: Instant::now() + Duration::from_secs(timeout),
                            callback_path,
                        };
                        state
                            .subscriptions
                            .write()
                            .insert(new_sid.to_string(), subscription);

                        tracing::info!("[GENA] Re-subscribed with new SID={}", new_sid);

                        // Schedule renewal for new subscription
                        let next_renewal_delay =
                            timeout.saturating_sub(RENEWAL_MARGIN_SECONDS).max(60);
                        Box::pin(schedule_renewal_task(
                            new_sid.to_string(),
                            next_renewal_delay,
                            state,
                            client,
                            local_ip,
                            port,
                        ))
                        .await;
                    }
                }
            }
        }
    }
}

/// Health check handler
async fn health_handler() -> impl IntoResponse {
    "GENA listener running"
}

/// NOTIFY callback handler
async fn notify_handler(
    State(state): State<Arc<GenaState>>,
    Path((_ip, service)): Path<(String, String)>,
    request: Request<Body>,
) -> impl IntoResponse {
    tracing::info!("[GENA] Received NOTIFY callback for service: {}", service);

    // Only handle NOTIFY method
    if request.method().as_str() != "NOTIFY" {
        return StatusCode::METHOD_NOT_ALLOWED;
    }

    let sid = match request.headers().get("SID").and_then(|v| v.to_str().ok()) {
        Some(sid) => sid.to_string(),
        None => {
            tracing::warn!("[GENA] NOTIFY without SID");
            return StatusCode::BAD_REQUEST;
        }
    };

    tracing::debug!("[GENA] NOTIFY SID: {}", sid);

    // Verify subscription exists
    let speaker_ip = {
        let subs = state.subscriptions.read();
        let known_sids: Vec<_> = subs.keys().collect();
        tracing::debug!("[GENA] Known SIDs: {:?}", known_sids);

        match subs.get(&sid) {
            Some(sub) => sub.speaker_ip.clone(),
            None => {
                tracing::warn!("[GENA] NOTIFY for unknown SID: {} (known: {:?})", sid, known_sids);
                return StatusCode::PRECONDITION_FAILED;
            }
        }
    };

    // Parse service type
    let gena_service = match GenaService::from_str(&service) {
        Some(s) => s,
        None => {
            tracing::warn!("[GENA] Unknown service: {}", service);
            return StatusCode::BAD_REQUEST;
        }
    };

    // Read body
    let body = match axum::body::to_bytes(request.into_body(), 64 * 1024).await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
        Err(e) => {
            tracing::error!("[GENA] Failed to read body: {}", e);
            return StatusCode::BAD_REQUEST;
        }
    };

    tracing::debug!("[GENA] NOTIFY body length: {} bytes", body.len());
    tracing::trace!("[GENA] NOTIFY body: {}", body);

    // Parse events
    let events = parse_notify(&body, gena_service, &speaker_ip);
    tracing::info!("[GENA] Parsed {} events from NOTIFY", events.len());

    if events.is_empty() {
        tracing::warn!("[GENA] No events parsed from body. First 500 chars: {}", &body.chars().take(500).collect::<String>());
    }

    for event in events {
        tracing::info!("[GENA] Event from {}: {:?}", speaker_ip, event);
        if let Err(e) = state.event_tx.send((speaker_ip.clone(), event)) {
            tracing::error!("[GENA] Failed to send event: {}", e);
        }
    }

    StatusCode::OK
}

/// Parse NOTIFY body and extract events
fn parse_notify(body: &str, service: GenaService, speaker_ip: &str) -> Vec<SonosEvent> {
    let mut events = Vec::new();
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    // Extract LastChange from propertyset
    let last_change = match extract_last_change(body) {
        Some(lc) => {
            tracing::debug!("[GENA] Extracted LastChange: {} chars", lc.len());
            lc
        }
        None => {
            tracing::warn!("[GENA] Failed to extract LastChange from body");
            return events;
        }
    };

    // Unescape XML entities
    let last_change_xml = unescape_xml(&last_change);
    tracing::debug!("[GENA] Unescaped LastChange: {}", &last_change_xml.chars().take(200).collect::<String>());

    match service {
        GenaService::AVTransport => {
            // Parse transport state
            if let Some(state) = extract_attribute(&last_change_xml, "TransportState", "val") {
                if let Some(ts) = TransportState::from_str(&state) {
                    events.push(SonosEvent::TransportState {
                        state: ts.as_str().to_string(),
                        speaker_ip: speaker_ip.to_string(),
                        timestamp,
                    });
                }
            }
        }
        GenaService::RenderingControl => {
            // Parse volume
            if let Some(volume_str) =
                extract_attribute_with_channel(&last_change_xml, "Volume", "Master", "val")
            {
                if let Ok(volume) = volume_str.parse::<u8>() {
                    events.push(SonosEvent::Volume {
                        volume,
                        speaker_ip: speaker_ip.to_string(),
                        timestamp,
                    });
                }
            }

            // Parse mute
            if let Some(mute_str) =
                extract_attribute_with_channel(&last_change_xml, "Mute", "Master", "val")
            {
                let mute = mute_str == "1";
                events.push(SonosEvent::Mute {
                    mute,
                    speaker_ip: speaker_ip.to_string(),
                    timestamp,
                });
            }
        }
        GenaService::ZoneGroupTopology => {
            // Zone topology changed
            events.push(SonosEvent::ZoneChange { timestamp });
        }
    }

    events
}

/// Extract LastChange content from NOTIFY body
fn extract_last_change(xml: &str) -> Option<String> {
    // Use [\s\S]*? to match any character including newlines (more portable than [^]*?)
    let re = regex_lite::Regex::new(r"<LastChange>([\s\S]*?)</LastChange>").ok()?;
    re.captures(xml)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
}

/// Extract attribute value from XML element
fn extract_attribute(xml: &str, element: &str, attr: &str) -> Option<String> {
    let pattern = format!(r#"<{}\s+{}="([^"]+)""#, element, attr);
    let re = regex_lite::Regex::new(&pattern).ok()?;
    re.captures(xml)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
}

/// Extract attribute value from XML element with channel attribute
fn extract_attribute_with_channel(
    xml: &str,
    element: &str,
    channel: &str,
    attr: &str,
) -> Option<String> {
    let pattern = format!(r#"<{}\s+channel="{}"\s+{}="([^"]+)""#, element, channel, attr);
    let re = regex_lite::Regex::new(&pattern).ok()?;
    re.captures(xml)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_transport_state() {
        let xml = r#"<e:propertyset><e:property><LastChange>&lt;Event&gt;&lt;InstanceID val="0"&gt;&lt;TransportState val="STOPPED"/&gt;&lt;/InstanceID&gt;&lt;/Event&gt;</LastChange></e:property></e:propertyset>"#;

        let events = parse_notify(xml, GenaService::AVTransport, "192.168.1.100");
        assert_eq!(events.len(), 1);

        match &events[0] {
            SonosEvent::TransportState { state, .. } => {
                assert_eq!(state, "STOPPED");
            }
            _ => panic!("Expected TransportState event"),
        }
    }

    #[test]
    fn test_parse_volume() {
        let xml = r#"<e:propertyset><e:property><LastChange>&lt;Event&gt;&lt;InstanceID val="0"&gt;&lt;Volume channel="Master" val="50"/&gt;&lt;/InstanceID&gt;&lt;/Event&gt;</LastChange></e:property></e:propertyset>"#;

        let events = parse_notify(xml, GenaService::RenderingControl, "192.168.1.100");
        assert_eq!(events.len(), 1);

        match &events[0] {
            SonosEvent::Volume { volume, .. } => {
                assert_eq!(*volume, 50);
            }
            _ => panic!("Expected Volume event"),
        }
    }

    #[test]
    fn test_extract_last_change() {
        let xml = "<root><LastChange>test content</LastChange></root>";
        let result = extract_last_change(xml);
        assert_eq!(result, Some("test content".to_string()));
    }
}
