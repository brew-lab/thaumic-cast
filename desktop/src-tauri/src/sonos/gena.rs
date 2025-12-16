//! GENA (General Event Notification Architecture) listener for Sonos UPnP events
//!
//! Subscribes to Sonos speaker services and receives NOTIFY callbacks when state changes.
//! Events are routed to the StreamManager to forward to connected extensions.

use crate::generated::{
    GenaService as GeneratedGenaService, GroupStatus, SonosEvent as GeneratedSonosEvent,
    TransportState as GeneratedTransportState,
};
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
use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::Client;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

use crate::network::GENA_PORT_RANGE;

const SONOS_PORT: u16 = 1400;
const DEFAULT_TIMEOUT_SECONDS: u64 = 3600;
const RENEWAL_MARGIN_SECONDS: u64 = 300; // Renew 5 minutes before expiry

// Re-export generated types with extensions
pub type GenaService = GeneratedGenaService;
pub type TransportState = GeneratedTransportState;
pub type SonosEvent = GeneratedSonosEvent;

/// Extension trait adding methods to the generated GenaService enum.
/// Required because the OpenAPI codegen only produces data types, not behavior.
pub trait GenaServiceExt {
    fn endpoint(&self) -> &'static str;
    fn from_str(s: &str) -> Option<GenaService>;
    fn as_str(&self) -> &'static str;
}

impl GenaServiceExt for GenaService {
    fn endpoint(&self) -> &'static str {
        match self {
            GenaService::AVTransport => "/MediaRenderer/AVTransport/Event",
            GenaService::ZoneGroupTopology => "/ZoneGroupTopology/Event",
            GenaService::GroupRenderingControl => "/MediaRenderer/GroupRenderingControl/Event",
        }
    }

    fn from_str(s: &str) -> Option<GenaService> {
        match s {
            "AVTransport" => Some(GenaService::AVTransport),
            "ZoneGroupTopology" => Some(GenaService::ZoneGroupTopology),
            "GroupRenderingControl" => Some(GenaService::GroupRenderingControl),
            _ => None,
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            GenaService::AVTransport => "AVTransport",
            GenaService::ZoneGroupTopology => "ZoneGroupTopology",
            GenaService::GroupRenderingControl => "GroupRenderingControl",
        }
    }
}

/// Extension trait adding parsing to the generated TransportState enum.
/// Required because the OpenAPI codegen only produces data types, not behavior.
pub trait TransportStateExt {
    fn from_str(s: &str) -> Option<TransportState>;
}

impl TransportStateExt for TransportState {
    fn from_str(s: &str) -> Option<TransportState> {
        match s {
            "PLAYING" => Some(TransportState::Playing),
            "PAUSED_PLAYBACK" => Some(TransportState::PausedPlayback),
            "STOPPED" => Some(TransportState::Stopped),
            "TRANSITIONING" => Some(TransportState::Transitioning),
            _ => None,
        }
    }
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
    /// Expected stream URLs per speaker IP for source verification
    expected_stream_urls: RwLock<HashMap<String, String>>,
    /// Current transport state per speaker IP (from GENA events)
    transport_states: RwLock<HashMap<String, TransportState>>,
    /// Current track URI per speaker IP (from GENA events)
    current_uris: RwLock<HashMap<String, String>>,
    /// Current group volume per speaker IP (from GroupRenderingControl events)
    volumes: RwLock<HashMap<String, u8>>,
    /// Current group mute state per speaker IP (from GroupRenderingControl events)
    mutes: RwLock<HashMap<String, bool>>,
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
                expected_stream_urls: RwLock::new(HashMap::new()),
                transport_states: RwLock::new(HashMap::new()),
                current_uris: RwLock::new(HashMap::new()),
                volumes: RwLock::new(HashMap::new()),
                mutes: RwLock::new(HashMap::new()),
            }),
            event_rx: RwLock::new(Some(event_rx)),
            shutdown_tx: RwLock::new(None),
        })
    }

    /// Set expected stream URL for a speaker
    /// Used to detect when Sonos switches to a different source
    pub fn set_expected_stream_url(&self, speaker_ip: &str, stream_url: &str) {
        // Normalize URL - Sonos uses x-rincon-mp3radio:// for HTTP streams
        let normalized_url = stream_url
            .replace("http://", "x-rincon-mp3radio://")
            .replace("https://", "x-rincon-mp3radio://");
        self.state
            .expected_stream_urls
            .write()
            .insert(speaker_ip.to_string(), normalized_url.clone());
        log::info!(
            "[GENA] Set expected stream URL for {}: {}",
            speaker_ip,
            normalized_url
        );
    }

    /// Clear expected stream URL for a speaker
    pub fn clear_expected_stream_url(&self, speaker_ip: &str) {
        self.state.expected_stream_urls.write().remove(speaker_ip);
        log::info!("[GENA] Cleared expected stream URL for {}", speaker_ip);
    }

    /// Get expected stream URL for a speaker
    pub fn get_expected_stream_url(&self, speaker_ip: &str) -> Option<String> {
        self.state
            .expected_stream_urls
            .read()
            .get(speaker_ip)
            .cloned()
    }

    /// Get transport state for a speaker
    pub fn get_transport_state(&self, speaker_ip: &str) -> Option<TransportState> {
        self.state.transport_states.read().get(speaker_ip).copied()
    }

    /// Get current URI for a speaker
    pub fn get_current_uri(&self, speaker_ip: &str) -> Option<String> {
        self.state.current_uris.read().get(speaker_ip).cloned()
    }

    /// Check if a speaker is playing our stream
    pub fn is_playing_our_stream(&self, speaker_ip: &str) -> Option<bool> {
        let expected = self.get_expected_stream_url(speaker_ip)?;
        let current = self.get_current_uri(speaker_ip)?;
        Some(is_matching_stream_url(&current, &expected))
    }

    /// Get all tracked speaker statuses as GroupStatus structs
    pub fn get_all_group_statuses(&self) -> Vec<GroupStatus> {
        let transport_states = self.state.transport_states.read();
        let current_uris = self.state.current_uris.read();
        let expected_urls = self.state.expected_stream_urls.read();
        let volumes = self.state.volumes.read();
        let mutes = self.state.mutes.read();

        // Collect all unique speaker IPs from transport states
        transport_states
            .iter()
            .map(|(ip, transport_state)| {
                let current_uri = current_uris.get(ip).cloned();
                let is_playing_our_stream = expected_urls.get(ip).and_then(|expected| {
                    current_uri
                        .as_ref()
                        .map(|current| is_matching_stream_url(current, expected))
                });

                GroupStatus {
                    coordinator_ip: ip.clone(),
                    transport_state: *transport_state,
                    current_uri,
                    is_playing_our_stream,
                    volume: *volumes.get(ip).unwrap_or(&0),
                    is_muted: *mutes.get(ip).unwrap_or(&false),
                }
            })
            .collect()
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
        for p in GENA_PORT_RANGE.clone() {
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
                    log::warn!(
                        "[GENA] Port {} unavailable: {}, trying next...",
                        try_port,
                        e
                    );
                    last_error = Some(e);
                }
            }
        }

        let (actual_port, listener) = bound_port.ok_or_else(|| {
            format!(
                "Could not start GENA listener: all ports in range {}-{} are in use. Last error: {:?}",
                GENA_PORT_RANGE.start(),
                GENA_PORT_RANGE.end(),
                last_error
            )
        })?;

        // Update the port to the actual bound port
        *self.port.write() = actual_port;

        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        *self.shutdown_tx.write() = Some(shutdown_tx);

        log::info!(
            "[GENA] Listener started on http://{}:{}",
            local_ip,
            actual_port
        );

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

        log::info!("[GENA] Listener stopped");
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
        // Check for existing subscription to avoid duplicates
        {
            let subs = self.state.subscriptions.read();
            for (sid, sub) in subs.iter() {
                if sub.speaker_ip == speaker_ip && sub.service == service {
                    log::debug!(
                        "[GENA] Already subscribed to {:?} on {}, SID={}",
                        service,
                        speaker_ip,
                        sid
                    );
                    return Ok(sid.clone());
                }
            }
        }

        let port = *self.port.read();
        let event_url = service.endpoint();
        let callback_path = format!(
            "/notify/{}/{}",
            speaker_ip.replace('.', "-"),
            service.as_str()
        );
        let callback_url = format!("http://{}:{}{}", self.local_ip, port, callback_path);

        log::info!("[GENA] Subscribing to {:?} on {}", service, speaker_ip);
        log::info!("[GENA] Callback URL: {}", callback_url);

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
            log::error!("[GENA] Subscribe failed: {} - {}", status, error_text);
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

        log::info!(
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

        log::info!("[GENA] Renewing subscription {}", sid);

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
            log::warn!("[GENA] Renewal failed, re-subscribing");
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

        log::info!(
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

        log::info!("[GENA] Unsubscribed: {}", sid);
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

        // Also clear expected stream URL when unsubscribing
        self.state.expected_stream_urls.write().remove(speaker_ip);

        Ok(())
    }

    /// Get the number of active subscriptions
    pub fn active_subscriptions(&self) -> usize {
        self.state.subscriptions.read().len()
    }

    /// Get the actual port the GENA listener is bound to
    pub fn get_port(&self) -> u16 {
        *self.port.read()
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

    /// Clear all subscriptions (unsubscribe from all speakers)
    pub async fn clear_all_subscriptions(&self) {
        // Get unique speaker IPs
        let speaker_ips: Vec<String> = self
            .state
            .subscriptions
            .read()
            .values()
            .map(|sub| sub.speaker_ip.clone())
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();

        for speaker_ip in speaker_ips {
            let _ = self.unsubscribe_all(&speaker_ip).await;
        }

        log::info!("[GENA] Cleared all subscriptions");
    }

    /// Auto-subscribe to AVTransport for all discovered groups
    /// Also subscribes to ZoneGroupTopology on one coordinator for zone change events
    pub async fn auto_subscribe_to_groups(&self, coordinator_ips: &[String]) {
        log::info!(
            "[GENA] Auto-subscribing to {} group coordinator(s)",
            coordinator_ips.len()
        );

        for ip in coordinator_ips {
            // Subscribe to AVTransport to track transport state
            if let Err(e) = self.subscribe(ip, GenaService::AVTransport).await {
                log::warn!(
                    "[GENA] Auto-subscribe AVTransport failed for {}: {}",
                    ip,
                    e
                );
            }
            // Subscribe to GroupRenderingControl for group volume events
            if let Err(e) = self
                .subscribe(ip, GenaService::GroupRenderingControl)
                .await
            {
                log::warn!(
                    "[GENA] Auto-subscribe GroupRenderingControl failed for {}: {}",
                    ip,
                    e
                );
            }
        }

        // Subscribe to ZoneGroupTopology on first coordinator (system-wide event)
        if let Some(first_ip) = coordinator_ips.first() {
            if let Err(e) = self
                .subscribe(first_ip, GenaService::ZoneGroupTopology)
                .await
            {
                log::warn!("[GENA] Auto-subscribe ZoneGroupTopology failed: {}", e);
            }
        }
    }

    /// Schedule subscription renewal
    fn schedule_renewal(&self, sid: String, timeout_seconds: u64) {
        let renewal_delay = timeout_seconds
            .saturating_sub(RENEWAL_MARGIN_SECONDS)
            .max(60);
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

            log::info!("[GENA] Auto-renewed: SID={}", sid);

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
            log::warn!(
                "[GENA] Auto-renewal failed for {}, attempting re-subscribe",
                sid
            );
            state.subscriptions.write().remove(&sid);

            // Try to re-subscribe
            let callback_path = format!(
                "/notify/{}/{}",
                speaker_ip.replace('.', "-"),
                service.as_str()
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
                    if let Some(new_sid) =
                        response.headers().get("SID").and_then(|v| v.to_str().ok())
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

                        log::info!("[GENA] Re-subscribed with new SID={}", new_sid);

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
    // Only handle NOTIFY method
    if request.method().as_str() != "NOTIFY" {
        return StatusCode::METHOD_NOT_ALLOWED;
    }

    let sid = match request.headers().get("SID").and_then(|v| v.to_str().ok()) {
        Some(sid) => sid.to_string(),
        None => {
            log::warn!("[GENA] NOTIFY without SID");
            return StatusCode::BAD_REQUEST;
        }
    };

    // Verify subscription exists
    let speaker_ip = {
        let subs = state.subscriptions.read();
        match subs.get(&sid) {
            Some(sub) => sub.speaker_ip.clone(),
            None => {
                log::warn!("[GENA] NOTIFY for unknown SID: {}", sid);
                return StatusCode::PRECONDITION_FAILED;
            }
        }
    };

    // Parse service type
    let gena_service = match GenaService::from_str(&service) {
        Some(s) => s,
        None => {
            log::warn!("[GENA] Unknown service: {}", service);
            return StatusCode::BAD_REQUEST;
        }
    };

    // Read body
    let body = match axum::body::to_bytes(request.into_body(), 64 * 1024).await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
        Err(e) => {
            log::error!("[GENA] Failed to read body: {}", e);
            return StatusCode::BAD_REQUEST;
        }
    };

    // Get expected stream URL for this speaker (if any)
    let expected_stream_url = state.expected_stream_urls.read().get(&speaker_ip).cloned();

    // Parse NOTIFY body
    let parsed = parse_notify(
        &body,
        gena_service,
        &speaker_ip,
        expected_stream_url.as_deref(),
    );

    // Update state tracking for transport state
    if let Some(transport_state) = parsed.transport_state {
        state
            .transport_states
            .write()
            .insert(speaker_ip.clone(), transport_state);
    }

    // Update state tracking for current URI
    if let Some(current_uri) = parsed.current_uri {
        state
            .current_uris
            .write()
            .insert(speaker_ip.clone(), current_uri);
    }

    // Update state tracking for volume/mute
    if let Some(volume) = parsed.volume {
        state.volumes.write().insert(speaker_ip.clone(), volume);
    }
    if let Some(mute) = parsed.mute {
        state.mutes.write().insert(speaker_ip.clone(), mute);
    }

    // Forward events
    for event in parsed.events {
        log::debug!("[GENA] Event: {:?}", event);
        if let Err(e) = state.event_tx.send((speaker_ip.clone(), event)) {
            log::error!("[GENA] Failed to send event: {}", e);
        }
    }

    StatusCode::OK
}

/// Result of parsing a NOTIFY body
struct ParsedNotify {
    events: Vec<SonosEvent>,
    /// Transport state extracted from AVTransport (if present)
    transport_state: Option<TransportState>,
    /// Current track URI extracted from AVTransport (if present)
    current_uri: Option<String>,
    /// Group volume extracted from GroupRenderingControl (if present)
    volume: Option<u8>,
    /// Group mute state extracted from GroupRenderingControl (if present)
    mute: Option<bool>,
}

/// Parse NOTIFY body and extract events
fn parse_notify(
    body: &str,
    service: GenaService,
    speaker_ip: &str,
    expected_stream_url: Option<&str>,
) -> ParsedNotify {
    let mut events = Vec::new();
    let mut extracted_transport_state = None;
    let mut extracted_current_uri = None;

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    // GroupRenderingControl uses a different XML format - handle separately
    if service == GenaService::GroupRenderingControl {
        let mut extracted_volume = None;
        let mut extracted_mute = None;

        // Parse GroupVolume element content (e.g., <GroupVolume>50</GroupVolume>)
        if let Some(volume_str) = extract_element_content(body, "GroupVolume") {
            if let Ok(volume) = volume_str.parse::<u8>() {
                extracted_volume = Some(volume);
                events.push(SonosEvent::GroupVolume {
                    volume,
                    speaker_ip: speaker_ip.to_string(),
                    timestamp,
                });
            }
        }

        // Parse GroupMute element content (e.g., <GroupMute>0</GroupMute>)
        if let Some(mute_str) = extract_element_content(body, "GroupMute") {
            let mute = mute_str == "1";
            extracted_mute = Some(mute);
            events.push(SonosEvent::GroupMute {
                mute,
                speaker_ip: speaker_ip.to_string(),
                timestamp,
            });
        }

        return ParsedNotify {
            events,
            transport_state: None,
            current_uri: None,
            volume: extracted_volume,
            mute: extracted_mute,
        };
    }

    // For other services, extract LastChange from propertyset
    let last_change = match extract_last_change(body) {
        Some(lc) => lc,
        None => {
            return ParsedNotify {
                events,
                transport_state: None,
                current_uri: None,
                volume: None,
                mute: None,
            }
        }
    };

    // Unescape XML entities
    let last_change_xml = unescape_xml(&last_change);

    match service {
        GenaService::AVTransport => {
            // Parse transport state
            if let Some(state_str) = extract_attribute(&last_change_xml, "TransportState", "val") {
                if let Some(state) = TransportState::from_str(&state_str) {
                    extracted_transport_state = Some(state);
                    events.push(SonosEvent::TransportState {
                        state,
                        speaker_ip: speaker_ip.to_string(),
                        timestamp,
                    });
                }
            }

            // Parse CurrentTrackURI - always extract for status tracking
            if let Some(current_uri) = extract_attribute(&last_change_xml, "CurrentTrackURI", "val")
            {
                let current_uri = unescape_xml(&current_uri);
                if !current_uri.is_empty() {
                    extracted_current_uri = Some(current_uri.clone());

                    // Check if source changed (current URI doesn't match expected)
                    if let Some(expected) = expected_stream_url {
                        if !is_matching_stream_url(&current_uri, expected) {
                            log::info!(
                                "[GENA] Source changed on {}: expected={}, current={}",
                                speaker_ip,
                                expected,
                                current_uri
                            );
                            events.push(SonosEvent::SourceChanged {
                                current_uri,
                                expected_uri: Some(expected.to_string()),
                                speaker_ip: speaker_ip.to_string(),
                                timestamp,
                            });
                        }
                    }
                }
            }
        }
        GenaService::ZoneGroupTopology => {
            // Zone topology changed
            events.push(SonosEvent::ZoneChange { timestamp });
        }
        GenaService::GroupRenderingControl => {
            // Handled earlier - this case shouldn't be reached
            unreachable!("GroupRenderingControl is handled before LastChange extraction");
        }
    }

    ParsedNotify {
        events,
        transport_state: extracted_transport_state,
        current_uri: extracted_current_uri,
        volume: None,
        mute: None,
    }
}

/// Check if current URI matches expected stream URL
/// Sonos uses various internal schemes and can nest them (e.g., aac://http://...)
/// We extract just the host+path portion for comparison.
fn is_matching_stream_url(current_uri: &str, expected_uri: &str) -> bool {
    // Extract everything after the last "://" to get host+path
    // This handles nested schemes like "aac://http://host/path" -> "host/path"
    fn extract_host_path(url: &str) -> &str {
        match url.rfind("://") {
            Some(idx) => &url[idx + 3..],
            None => url,
        }
    }

    extract_host_path(current_uri).eq_ignore_ascii_case(extract_host_path(expected_uri))
}

/// Extract LastChange content from NOTIFY body using quick-xml
fn extract_last_change(xml: &str) -> Option<String> {
    let mut reader = Reader::from_str(xml);
    let mut in_last_change = false;
    let mut result = String::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) if e.local_name().as_ref() == b"LastChange" => {
                in_last_change = true;
            }
            Ok(Event::Text(e)) if in_last_change => {
                if let Ok(text) = e.unescape() {
                    result.push_str(&text);
                }
            }
            Ok(Event::CData(e)) if in_last_change => {
                result.push_str(&String::from_utf8_lossy(&e));
            }
            Ok(Event::End(e)) if e.local_name().as_ref() == b"LastChange" => {
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

/// Helper to get an attribute value from quick-xml Attributes
fn get_xml_attribute(
    attrs: &quick_xml::events::attributes::Attributes,
    name: &[u8],
) -> Option<String> {
    for attr in attrs.clone().flatten() {
        if attr.key.as_ref() == name {
            return attr.unescape_value().ok().map(|s| s.to_string());
        }
    }
    None
}

/// Extract attribute value from XML element using quick-xml
fn extract_attribute(xml: &str, element: &str, attr: &str) -> Option<String> {
    let mut reader = Reader::from_str(xml);
    let element_bytes = element.as_bytes();
    let attr_bytes = attr.as_bytes();

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e))
                if e.local_name().as_ref() == element_bytes =>
            {
                return get_xml_attribute(&e.attributes(), attr_bytes);
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    None
}

/// Extract element text content from XML (e.g., `<GroupVolume>50</GroupVolume>` -> "50")
fn extract_element_content(xml: &str, element: &str) -> Option<String> {
    let mut reader = Reader::from_str(xml);
    let element_bytes = element.as_bytes();
    let mut in_element = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) if e.local_name().as_ref() == element_bytes => {
                in_element = true;
            }
            Ok(Event::Text(e)) if in_element => {
                return e.unescape().ok().map(|s| s.to_string());
            }
            Ok(Event::End(e)) if e.local_name().as_ref() == element_bytes => {
                return None; // Empty element
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_transport_state() {
        let xml = r#"<e:propertyset><e:property><LastChange>&lt;Event&gt;&lt;InstanceID val="0"&gt;&lt;TransportState val="STOPPED"/&gt;&lt;/InstanceID&gt;&lt;/Event&gt;</LastChange></e:property></e:propertyset>"#;

        let parsed = parse_notify(xml, GenaService::AVTransport, "192.168.1.100", None);
        assert_eq!(parsed.events.len(), 1);
        assert_eq!(parsed.transport_state, Some(TransportState::Stopped));

        match &parsed.events[0] {
            SonosEvent::TransportState { state, .. } => {
                assert_eq!(*state, TransportState::Stopped);
            }
            _ => panic!("Expected TransportState event"),
        }
    }

    #[test]
    fn test_extract_last_change() {
        let xml = "<root><LastChange>test content</LastChange></root>";
        let result = extract_last_change(xml);
        assert_eq!(result, Some("test content".to_string()));
    }

    /// Verify wire format matches what TypeScript extension expects
    #[test]
    fn test_sonos_event_serialization() {
        // Test TransportState event serialization
        let event = SonosEvent::TransportState {
            state: TransportState::Playing,
            speaker_ip: "192.168.1.100".to_string(),
            timestamp: 1234567890,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""type":"transportState""#));
        assert!(json.contains(r#""state":"PLAYING""#));
        assert!(json.contains(r#""speakerIp":"192.168.1.100""#));

        // Test PausedPlayback variant (the one that had naming inconsistency)
        let event = SonosEvent::TransportState {
            state: TransportState::PausedPlayback,
            speaker_ip: "192.168.1.100".to_string(),
            timestamp: 1234567890,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""state":"PAUSED_PLAYBACK""#));

        // Test GroupVolume event
        let event = SonosEvent::GroupVolume {
            volume: 50,
            speaker_ip: "192.168.1.100".to_string(),
            timestamp: 1234567890,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""type":"groupVolume""#));
        assert!(json.contains(r#""volume":50"#));

        // Test ZoneChange event
        let event = SonosEvent::ZoneChange {
            timestamp: 1234567890,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""type":"zoneChange""#));
    }
}
