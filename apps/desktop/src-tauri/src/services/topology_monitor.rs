//! Sonos topology monitoring service.
//!
//! Responsibilities:
//! - Background topology discovery loop
//! - IP change detection and re-subscription
//! - GENA subscription lifecycle management
//! - Manual refresh coordination
//! - Network health monitoring

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::future::join_all;
use parking_lot::RwLock;
use reqwest::Client;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::context::NetworkContext;
use crate::error::{ThaumicError, ThaumicResult};
use crate::events::{EventEmitter, NetworkEvent, NetworkHealth, TopologyEvent};
use crate::sonos::discovery::{probe_speaker_by_ip, Speaker};
use crate::sonos::gena::GenaSubscriptionManager;
use crate::sonos::SonosService;
use crate::sonos::SonosTopologyClient;
use crate::state::{ManualSpeakerConfig, SonosState};
use crate::types::ZoneGroup;

/// Current network health state with reason.
#[derive(Debug, Clone)]
pub struct NetworkHealthState {
    /// Current health status.
    pub health: NetworkHealth,
    /// Reason for the current health status (if degraded).
    pub reason: Option<String>,
}

impl Default for NetworkHealthState {
    fn default() -> Self {
        Self {
            health: NetworkHealth::Ok,
            reason: None,
        }
    }
}

/// Monitors Sonos network topology and manages GENA subscriptions.
pub struct TopologyMonitor {
    /// Sonos client for discovery and topology operations.
    sonos: Arc<dyn SonosTopologyClient>,
    gena_manager: Arc<GenaSubscriptionManager>,
    sonos_state: Arc<SonosState>,
    /// Event emitter for broadcasting network health changes.
    emitter: Arc<dyn EventEmitter>,
    /// Current network health state.
    network_health: RwLock<NetworkHealthState>,
    /// Tracks if speakers were discovered (for detecting "discovered but unreachable").
    speakers_discovered: AtomicBool,
    /// Interval between automatic topology refreshes (seconds).
    topology_refresh_interval_secs: u64,
    /// Network configuration (port, local IP).
    network: NetworkContext,
    refresh_notify: Arc<Notify>,
    /// Token to signal background tasks to stop.
    cancel_token: CancellationToken,
    /// App data directory for loading manual speaker configuration.
    app_data_dir: RwLock<Option<PathBuf>>,
    /// HTTP client for probing manual speaker IPs.
    http_client: Client,
}

impl TopologyMonitor {
    /// Creates a new TopologyMonitor.
    ///
    /// # Arguments
    /// * `sonos` - Sonos client for discovery and topology operations
    /// * `gena_manager` - Manager for GENA subscriptions
    /// * `sonos_state` - Shared state for Sonos groups
    /// * `emitter` - Event emitter for broadcasting network health changes
    /// * `network` - Network configuration (port, local IP)
    /// * `refresh_notify` - Notifier for manual refresh requests
    /// * `http_client` - Shared HTTP client for probing manual speaker IPs
    /// * `topology_refresh_interval_secs` - Interval between automatic refreshes
    pub fn new(
        sonos: Arc<dyn SonosTopologyClient>,
        gena_manager: Arc<GenaSubscriptionManager>,
        sonos_state: Arc<SonosState>,
        emitter: Arc<dyn EventEmitter>,
        network: NetworkContext,
        refresh_notify: Arc<Notify>,
        http_client: Client,
        topology_refresh_interval_secs: u64,
    ) -> Self {
        Self {
            sonos,
            gena_manager,
            sonos_state,
            emitter,
            network_health: RwLock::new(NetworkHealthState::default()),
            speakers_discovered: AtomicBool::new(false),
            topology_refresh_interval_secs,
            network,
            refresh_notify,
            cancel_token: CancellationToken::new(),
            app_data_dir: RwLock::new(None),
            http_client,
        }
    }

    /// Sets the app data directory for loading manual speaker configuration.
    ///
    /// This should be called after the app is set up and the AppHandle is available.
    pub fn set_app_data_dir(&self, path: PathBuf) {
        *self.app_data_dir.write() = Some(path);
    }

    /// Returns the current network health state.
    pub fn get_network_health(&self) -> NetworkHealthState {
        self.network_health.read().clone()
    }

    /// Updates network health and emits an event if it changed.
    fn set_network_health(&self, health: NetworkHealth, reason: Option<String>) {
        let mut state = self.network_health.write();
        let old_health = state.health;

        if old_health != health {
            log::info!(
                "[TopologyMonitor] Network health changed: {:?} -> {:?}{}",
                old_health,
                health,
                reason
                    .as_ref()
                    .map(|r| format!(" ({})", r))
                    .unwrap_or_default()
            );
            state.health = health;
            state.reason = reason.clone();

            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;

            self.emitter.emit_network(NetworkEvent::HealthChanged {
                health,
                reason,
                timestamp,
            });
        } else {
            log::debug!("[TopologyMonitor] Health unchanged: {:?}", health);
        }
    }

    /// Triggers a manual topology refresh.
    pub fn trigger_refresh(&self) {
        self.refresh_notify.notify_one();
    }

    /// Starts the GENA renewal background task.
    pub fn start_renewal_task(&self) {
        self.gena_manager.clone().start_renewal_task();
    }

    /// Starts the background topology monitor.
    ///
    /// This spawns a task that:
    /// - Periodically discovers speakers and updates zone groups
    /// - Manages GENA subscriptions for all discovered speakers
    /// - Handles IP changes by re-subscribing
    /// - Responds to manual refresh requests
    /// - Stops gracefully when the cancellation token is triggered
    pub fn start_monitoring(self: Arc<Self>) {
        let cancel_token = self.cancel_token.clone();
        tauri::async_runtime::spawn(async move {
            // Wait for the server to start and port to be assigned
            loop {
                tokio::select! {
                    _ = cancel_token.cancelled() => {
                        log::info!("[TopologyMonitor] Cancelled while waiting for server");
                        return;
                    }
                    _ = self.network.port_notify.notified() => {
                        if self.network.get_port() > 0 {
                            break;
                        }
                    }
                }
            }

            // Read initial IP from shared state
            let mut current_ip = self.network.get_local_ip();
            let mut callback_url = self.network.gena_callback_url();
            log::info!("[TopologyMonitor] GENA callback URL: {}", callback_url);

            let mut interval =
                tokio::time::interval(Duration::from_secs(self.topology_refresh_interval_secs));

            loop {
                let is_manual_refresh = tokio::select! {
                    _ = cancel_token.cancelled() => {
                        log::info!("[TopologyMonitor] Shutting down monitoring loop");
                        break;
                    }
                    _ = interval.tick() => false,
                    _ = self.refresh_notify.notified() => {
                        log::info!("[TopologyMonitor] Manual refresh triggered");
                        true
                    }
                };

                // Reset interval after manual refresh to push back automatic refresh
                if is_manual_refresh {
                    interval.reset();
                }

                // Check for IP changes (e.g., laptop moved networks)
                if let Ok(new_ip_str) = self.network.detect_ip() {
                    if new_ip_str != current_ip {
                        log::warn!(
                            "[TopologyMonitor] Local IP changed: {} -> {}. Re-subscribing...",
                            current_ip,
                            new_ip_str
                        );
                        // Update shared state so other services see the change
                        self.network.set_local_ip(new_ip_str.clone());
                        current_ip = new_ip_str;
                        callback_url = self.network.gena_callback_url();
                        self.gena_manager.unsubscribe_all().await;
                    }
                }

                if let Err(e) = self.refresh_topology(&callback_url).await {
                    match &e {
                        ThaumicError::SpeakerNotFound(_) => {
                            log::debug!("[TopologyMonitor] No speakers discovered");
                        }
                        _ => {
                            log::error!("[TopologyMonitor] {}", e);
                        }
                    }
                }
            }
        });
    }

    /// Performs a single topology refresh cycle.
    ///
    /// Discovers speakers, fetches zone groups, updates state, and syncs subscriptions.
    /// Tracks network health based on discovery and communication success.
    async fn refresh_topology(&self, callback_url: &str) -> ThaumicResult<()> {
        log::info!(
            "[TopologyMonitor] Refreshing topology (speakers_discovered={})",
            self.speakers_discovered.load(Ordering::Relaxed)
        );

        // Phase 1a: SSDP Discovery
        let mut speakers = match self.sonos.discover_speakers().await {
            Ok(speakers) => {
                log::info!(
                    "[TopologyMonitor] Discovery found {} speakers",
                    speakers.len()
                );
                speakers
            }
            Err(e) => {
                log::warn!(
                    "[TopologyMonitor] Discovery failed: {} (speakers_discovered={})",
                    e,
                    self.speakers_discovered.load(Ordering::Relaxed)
                );
                // Discovery failed, but we might still have manual speakers to try
                Vec::new()
            }
        };

        // Phase 1b: Probe manual speaker IPs
        let manual_speakers = self.probe_manual_speakers().await;
        if !manual_speakers.is_empty() {
            log::info!(
                "[TopologyMonitor] Probed {} manual speaker(s)",
                manual_speakers.len()
            );
            // Merge manual speakers with auto-discovered, avoiding duplicates by UUID
            let existing_uuids: HashSet<String> = speakers.iter().map(|s| s.uuid.clone()).collect();
            for speaker in manual_speakers {
                if !existing_uuids.contains(&speaker.uuid) {
                    speakers.push(speaker);
                }
            }
        }

        if speakers.is_empty() {
            log::warn!("[TopologyMonitor] No speakers found");

            // Clear groups and notify frontend so UI updates
            {
                let mut state = self.sonos_state.groups.write();
                state.clear();
            }

            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            self.emitter.emit_topology(TopologyEvent::GroupsDiscovered {
                groups: Vec::new(),
                timestamp,
            });

            // No speakers found - warn about potential VPN/firewall issues
            self.set_network_health(
                NetworkHealth::Degraded,
                Some("speakers_unreachable".to_string()),
            );

            // Reset discovery flag since we have no speakers
            self.speakers_discovered.store(false, Ordering::Relaxed);

            return Err(ThaumicError::SpeakerNotFound(
                "no speakers discovered".to_string(),
            ));
        }

        // Discovery succeeded - mark that we've seen speakers
        let was_first_discovery = !self.speakers_discovered.swap(true, Ordering::Relaxed);

        let current_speaker_ips: HashSet<String> = speakers.iter().map(|s| s.ip.clone()).collect();

        // Phase 2: Fetch zone groups (HTTP/SOAP call to speaker)
        // Prefer playable speakers - network infrastructure devices (Boost, Bridge)
        // don't participate in zone groups and return empty topology data
        let query_speaker = speakers
            .iter()
            .find(|s| !s.is_infrastructure_device())
            .unwrap_or(&speakers[0]);

        log::info!(
            "[TopologyMonitor] Fetching zone groups from {} ({}) (SOAP call)...",
            query_speaker.ip,
            query_speaker.name
        );
        let groups: Vec<ZoneGroup> = match self.sonos.get_zone_groups(&query_speaker.ip).await {
            Ok(groups) => {
                log::info!(
                    "[TopologyMonitor] SOAP succeeded: {} groups found",
                    groups.len()
                );
                groups
            }
            Err(e) => {
                log::error!(
                    "[TopologyMonitor] SOAP failed: {} - setting health to Degraded",
                    e
                );
                // Discovery worked but communication failed - this is the VPN/firewall scenario
                self.set_network_health(
                    NetworkHealth::Degraded,
                    Some(
                        "Speakers found but unreachable. Check VPN or firewall settings."
                            .to_string(),
                    ),
                );
                return Err(e.into());
            }
        };

        // Update stored groups and broadcast to clients
        {
            let mut state = self.sonos_state.groups.write();
            *state = groups.clone();
            log::debug!(
                "[TopologyMonitor] Updated state with {} groups",
                state.len()
            );
        }

        // Broadcast groups update to WebSocket clients and Tauri frontend
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        self.emitter.emit_topology(TopologyEvent::GroupsDiscovered {
            groups: groups.clone(),
            timestamp,
        });

        // Collect coordinator IPs
        let coordinator_ips: HashSet<String> =
            groups.iter().map(|g| g.coordinator_ip.clone()).collect();

        // Clean up stale state entries for disappeared/regrouped speakers
        self.sonos_state
            .cleanup_stale_entries(&coordinator_ips, &current_speaker_ips);

        // Sync subscriptions with current topology
        self.ensure_topology_subscription(&speakers, &current_speaker_ips, callback_url)
            .await;

        self.sync_coordinator_subscriptions(&coordinator_ips, callback_url)
            .await;

        // Cleanup stale subscriptions (coordinators that disappeared or were demoted)
        self.cleanup_stale_subscriptions(&coordinator_ips).await;

        let av_sub_count = self
            .gena_manager
            .get_subscribed_ips(SonosService::AVTransport)
            .len();
        let grc_sub_count = self
            .gena_manager
            .get_subscribed_ips(SonosService::GroupRenderingControl)
            .len();
        let zgt_sub_count = self
            .gena_manager
            .get_subscribed_ips(SonosService::ZoneGroupTopology)
            .len();

        log::debug!(
            "[TopologyMonitor] Subscriptions: {} AVTransport, {} GroupRenderingControl, {} ZoneGroupTopology",
            av_sub_count,
            grc_sub_count,
            zgt_sub_count
        );

        // Check communication health: if we have groups and subscriptions but no transport states,
        // speakers likely can't reach our callback URL (VPN, firewall, etc.)
        let has_subscriptions = av_sub_count > 0 || grc_sub_count > 0;
        let transport_states_empty = self.sonos_state.transport_states.is_empty();
        let has_groups = !groups.is_empty();

        if !was_first_discovery && has_groups && has_subscriptions && transport_states_empty {
            log::warn!(
                "[TopologyMonitor] Communication issue: have {} groups and {} subscriptions but no transport states",
                groups.len(),
                av_sub_count + grc_sub_count
            );
            self.set_network_health(
                NetworkHealth::Degraded,
                Some("speakers_not_responding".to_string()),
            );
        } else if has_groups && !transport_states_empty {
            // Everything is working - set health to Ok
            self.set_network_health(NetworkHealth::Ok, None);
        }
        // On first discovery, don't set health yet - give time for events to arrive

        Ok(())
    }

    /// Cleans up all GENA subscriptions and stops background tasks (for graceful shutdown).
    pub async fn shutdown(&self) {
        log::info!("[TopologyMonitor] Initiating shutdown");
        self.cancel_token.cancel();
        self.gena_manager.shutdown().await;
    }

    /// Probes manually configured speaker IPs and returns valid speakers.
    ///
    /// Loads IPs from ManualSpeakerConfig and probes each in parallel.
    /// Invalid/unreachable IPs are logged and skipped.
    async fn probe_manual_speakers(&self) -> Vec<Speaker> {
        let app_data_dir = match self.app_data_dir.read().clone() {
            Some(path) => path,
            None => {
                log::debug!("[TopologyMonitor] App data dir not set, skipping manual speakers");
                return Vec::new();
            }
        };

        let config = ManualSpeakerConfig::load(&app_data_dir);
        if config.speaker_ips.is_empty() {
            return Vec::new();
        }

        log::debug!(
            "[TopologyMonitor] Probing {} manual speaker IP(s)",
            config.speaker_ips.len()
        );

        // Probe all IPs in parallel
        let futures: Vec<_> = config
            .speaker_ips
            .iter()
            .map(|ip| {
                let ip = ip.clone();
                let client = self.http_client.clone();
                async move {
                    match probe_speaker_by_ip(&client, &ip).await {
                        Ok(speaker) => {
                            log::debug!(
                                "[TopologyMonitor] Manual IP {} is valid: {}",
                                ip,
                                speaker.name
                            );
                            Some(speaker)
                        }
                        Err(e) => {
                            log::warn!("[TopologyMonitor] Manual IP {} probe failed: {}", ip, e);
                            None
                        }
                    }
                }
            })
            .collect();

        let results = join_all(futures).await;
        results.into_iter().flatten().collect()
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Subscription Management Helpers
    // ─────────────────────────────────────────────────────────────────────────────

    /// Ensures a ZoneGroupTopology subscription exists on a valid speaker.
    async fn ensure_topology_subscription(
        &self,
        speakers: &[Speaker],
        current_speaker_ips: &HashSet<String>,
        callback_url: &str,
    ) {
        let topology_ips = self
            .gena_manager
            .get_subscribed_ips(SonosService::ZoneGroupTopology);
        let has_valid_sub = topology_ips
            .iter()
            .any(|ip| current_speaker_ips.contains(ip));

        if !has_valid_sub {
            if let Some(speaker) = speakers.first() {
                match self
                    .gena_manager
                    .subscribe(
                        speaker.ip.clone(),
                        SonosService::ZoneGroupTopology,
                        callback_url.to_string(),
                    )
                    .await
                {
                    Ok(()) => {
                        log::info!(
                            "[TopologyMonitor] Subscribed to ZoneGroupTopology on {}",
                            speaker.ip
                        );
                    }
                    Err(e) => {
                        log::error!(
                            "[TopologyMonitor] Failed to subscribe to ZoneGroupTopology on {}: {}",
                            speaker.ip,
                            e
                        );
                    }
                }
            }
        }
    }

    /// Ensures subscriptions exist for the given IPs and service.
    ///
    /// Subscribes to the specified service on any IPs that aren't already subscribed.
    async fn ensure_subscriptions<'a, I>(&self, ips: I, service: SonosService, callback_url: &str)
    where
        I: Iterator<Item = &'a str>,
    {
        for ip in ips {
            if !self.gena_manager.is_subscribed(ip, service) {
                match self
                    .gena_manager
                    .subscribe(ip.to_string(), service, callback_url.to_string())
                    .await
                {
                    Ok(()) => {
                        log::info!("[TopologyMonitor] Subscribed to {:?} on {}", service, ip);
                    }
                    Err(e) => {
                        log::error!(
                            "[TopologyMonitor] Failed to subscribe to {:?} on {}: {}",
                            service,
                            ip,
                            e
                        );
                    }
                }
            }
        }
    }

    /// Subscribes to AVTransport and GroupRenderingControl on coordinators.
    ///
    /// Only coordinators support AVTransport subscriptions. Satellites (Sub, surrounds)
    /// and bridges (Boost) return 503 errors when subscription is attempted.
    async fn sync_coordinator_subscriptions(
        &self,
        coordinator_ips: &HashSet<String>,
        callback_url: &str,
    ) {
        // Log new coordinator discoveries
        for ip in coordinator_ips {
            if !self
                .gena_manager
                .is_subscribed(ip, SonosService::AVTransport)
            {
                log::info!("[TopologyMonitor] New coordinator discovered: {}", ip);
            }
        }

        // Subscribe to AVTransport (playback state) on coordinators only
        self.ensure_subscriptions(
            coordinator_ips.iter().map(String::as_str),
            SonosService::AVTransport,
            callback_url,
        )
        .await;

        // Subscribe to GroupRenderingControl (volume/mute) on coordinators
        self.ensure_subscriptions(
            coordinator_ips.iter().map(String::as_str),
            SonosService::GroupRenderingControl,
            callback_url,
        )
        .await;
    }

    /// Unsubscribes from coordinators that are no longer in the topology.
    ///
    /// This handles both disappeared speakers and demoted coordinators (satellites).
    /// Since we only subscribe to coordinators, we compare against coordinator IPs.
    async fn cleanup_stale_subscriptions(&self, coordinator_ips: &HashSet<String>) {
        let subscribed_av_ips: HashSet<String> = self
            .gena_manager
            .get_subscribed_ips(SonosService::AVTransport)
            .into_iter()
            .collect();

        let stale: Vec<String> = subscribed_av_ips
            .difference(coordinator_ips)
            .cloned()
            .collect();

        for ip in stale {
            log::info!(
                "[TopologyMonitor] Speaker {} is no longer a coordinator, unsubscribing",
                ip
            );
            self.gena_manager.unsubscribe_by_ip(&ip).await;
        }
    }
}
