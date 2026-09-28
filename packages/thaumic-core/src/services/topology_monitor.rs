//! Sonos topology monitoring service.
//!
//! Responsibilities:
//! - Background topology discovery loop
//! - IP change detection and re-subscription
//! - GENA subscription lifecycle management
//! - Manual refresh coordination
//! - Network health monitoring
//! - Household change reporting: each SOAP answer is compared with the one
//!   before it, and satellites dropping off, reboots, radio changes, vanished
//!   devices and membership changes are logged, sent to clients and added to
//!   the timeline of any speaker fetching one of our streams they concern

use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::future::join_all;
use parking_lot::{Mutex, RwLock};
use reqwest::Client;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::context::{NetworkContext, NetworkError};
use crate::error::{ThaumicError, ThaumicResult};
use crate::events::{EventEmitter, NetworkEvent, NetworkHealth, TopologyEvent};
use crate::mdns_advertise::{self, MdnsAdvertiserHandle};
use crate::runtime::TokioSpawner;
use crate::services::latency_monitor::MemberChangeSink;
use crate::services::speaker_monitor::topology_diff::summarize;
use crate::services::speaker_monitor::{MemberChange, TopologyDiff};
use crate::sonos::discovery::{probe_speaker_by_ip, Speaker};
use crate::sonos::gena::{GenaError, GenaResult, GenaSubscriptionManager};
use crate::sonos::subscription_arbiter::SubscriptionArbiter;
use crate::sonos::types::{HouseholdTopology, ZoneGroup};
use crate::sonos::SonosService;
use crate::sonos::SonosTopologyClient;
use crate::state::{ManualSpeakerConfig, SonosState};

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

/// Configuration for the topology monitor.
pub struct TopologyMonitorConfig {
    /// Interval between automatic topology refreshes (seconds).
    pub topology_refresh_interval_secs: u64,
    /// Network configuration (port, local IP).
    pub network: NetworkContext,
    /// Notifier for manual refresh requests.
    pub refresh_notify: Arc<Notify>,
    /// Shared HTTP client for probing manual speaker IPs.
    pub http_client: Client,
    /// Task spawner for background tasks.
    pub spawner: TokioSpawner,
    /// Shared mDNS advertisement slot, re-registered when the local address changes.
    pub mdns_advertiser: MdnsAdvertiserHandle,
    /// Where household changes concerning a speaker fetching one of our
    /// streams are sent, for its timeline in the speaker monitor.
    pub member_changes: Option<MemberChangeSink>,
}

/// Clamps a topology refresh interval to a period `tokio::time::interval` accepts.
///
/// A zero period makes `tokio::time::interval` panic, which under the release
/// profile's `panic = "abort"` takes the whole process down, so a misconfigured
/// interval is clamped (with a warning) instead of trusted.
fn clamp_refresh_interval_secs(secs: u64) -> u64 {
    if secs == 0 {
        log::warn!("[TopologyMonitor] topology_refresh_interval_secs is 0; clamping to 1 second");
        1
    } else {
        secs
    }
}

/// Decides whether a completed full refresh should raise the degraded banner.
///
/// The signal is cached transport state: we can see groups, we hold
/// subscriptions on their coordinators, and yet not one of them has ever told
/// us what it is doing. Cached state is kept for as long as a speaker stays in
/// the topology, so a working system that simply has nothing playing keeps its
/// last known states and stays healthy — and, just as importantly, rebuilding
/// every subscription (after an address change, say) does not raise the banner
/// during the seconds it takes the first NOTIFY to come back.
///
/// The first discovery is exempt: nothing has had time to report yet.
fn refresh_looks_degraded(
    was_first_discovery: bool,
    has_groups: bool,
    has_subscriptions: bool,
    transport_states_empty: bool,
) -> bool {
    !was_first_discovery && has_groups && has_subscriptions && transport_states_empty
}

/// Collects every speaker IP that appears in a zone group topology.
///
/// The quick refresh path has no SSDP result to take live speaker IPs from, so it
/// derives them from group membership instead: every playable speaker (coordinator,
/// slave or satellite) is listed as a member of exactly one group. Zone bridges are
/// absent from both, and never hold per-speaker state.
fn speaker_ips_from_groups(groups: &[ZoneGroup]) -> HashSet<String> {
    groups
        .iter()
        .flat_map(|group| {
            group
                .members
                .iter()
                .map(|member| member.ip.clone())
                .chain(std::iter::once(group.coordinator_ip.clone()))
        })
        .collect()
}

/// The device a change is placed by: the primary for a satellite change
/// (the satellite may no longer be listed), otherwise its subject.
fn anchor_uuid(change: &MemberChange) -> &str {
    match change {
        MemberChange::SatelliteMissing { primary_uuid, .. }
        | MemberChange::SatelliteReturned { primary_uuid, .. } => primary_uuid,
        other => other.subject_uuid(),
    }
}

/// Addresses of the speakers a change concerns, as far as `household` still
/// lists them: the anchor device, the member it is bonded to (for a
/// satellite) and its group's coordinator, whichever of them fetch audio.
fn related_ips(household: &HouseholdTopology, change: &MemberChange) -> Vec<IpAddr> {
    let anchor = anchor_uuid(change);
    let mut ips: Vec<IpAddr> = Vec::new();
    for group in &household.groups {
        for member in &group.members {
            let bonded = member.satellites.iter().find(|s| s.device.uuid == anchor);
            if member.device.uuid != anchor && bonded.is_none() {
                continue;
            }
            let coordinator = household.device(&group.coordinator_uuid);
            let candidates = bonded
                .map(|s| s.device.ip.as_str())
                .into_iter()
                .chain(std::iter::once(member.device.ip.as_str()))
                .chain(coordinator.map(|c| c.ip.as_str()));
            for ip in candidates.filter_map(|ip| ip.parse::<IpAddr>().ok()) {
                if !ips.contains(&ip) {
                    ips.push(ip);
                }
            }
        }
    }
    ips
}

/// Names a device for the log: `RINCON_…(192.168.2.204) Living Room`, or
/// just its UUID when `household` no longer lists it.
fn describe_device(household: &HouseholdTopology, uuid: &str) -> String {
    match household.device(uuid) {
        Some(d) if d.zone_name.is_empty() => format!("{}({})", d.uuid, d.ip),
        Some(d) => format!("{}({}) {}", d.uuid, d.ip, d.zone_name),
        None => uuid.to_string(),
    }
}

/// The log line for one change, naming devices with their addresses and
/// rooms from the household the change was found in.
fn describe_change(household: &HouseholdTopology, change: &MemberChange) -> String {
    match change {
        MemberChange::SatelliteMissing {
            primary_uuid,
            uuid,
            role,
        } => format!(
            "HT {}: satellite {} ({}) missing",
            describe_device(household, primary_uuid),
            uuid,
            role
        ),
        MemberChange::SatelliteReturned {
            primary_uuid,
            uuid,
            role,
            after_ms,
        } => format!(
            "HT {}: satellite {} ({}) returned{}",
            describe_device(household, primary_uuid),
            describe_device(household, uuid),
            role,
            after_ms
                .map(|ms| format!(" after {}s", ms / 1000))
                .unwrap_or_default()
        ),
        MemberChange::DeviceRebooted { uuid, from, to } => format!(
            "{}: rebooted (BootSeq {} -> {})",
            describe_device(household, uuid),
            from,
            to
        ),
        MemberChange::RadioChanged {
            uuid,
            field,
            from,
            to,
        } => {
            let v = |v: &Option<u32>| v.map_or_else(|| "?".to_string(), |v| v.to_string());
            format!(
                "{}: {} {} -> {}",
                describe_device(household, uuid),
                field,
                v(from),
                v(to)
            )
        }
        MemberChange::Vanished { uuid, reason } => {
            let room = household
                .vanished
                .iter()
                .find(|v| v.uuid == *uuid)
                .and_then(|v| v.zone_name.as_deref())
                .map(|name| format!(" {name}"))
                .unwrap_or_default();
            format!(
                "{}{}: vanished{}",
                uuid,
                room,
                reason
                    .as_deref()
                    .map(|r| format!(" ({r})"))
                    .unwrap_or_default()
            )
        }
        MemberChange::MembersChanged {
            coordinator_uuid,
            joined,
            left,
        } => format!(
            "group {}: joined [{}] left [{}]",
            describe_device(household, coordinator_uuid),
            joined.join(", "),
            left.join(", ")
        ),
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
    /// Task spawner for background tasks.
    spawner: TokioSpawner,
    /// Subscription arbiter for RenderingControl/GroupRenderingControl conflict resolution.
    arbiter: Arc<SubscriptionArbiter>,
    /// Shared mDNS advertisement slot, re-registered when the local address changes.
    mdns_advertiser: MdnsAdvertiserHandle,
    /// Last non-empty set of known speaker addresses, kept across refreshes.
    remembered_speaker_ips: RwLock<Vec<Ipv4Addr>>,
    /// The previous household snapshot, for naming what each refresh changed.
    topology_diff: Mutex<TopologyDiff>,
    /// Where household changes concerning a fetching speaker are sent.
    member_changes: Option<MemberChangeSink>,
    /// The address mDNS was last registered at, to tell when it must move.
    advertised_ip: Mutex<String>,
    /// The last detection failure reported, so it is logged on change only.
    detection_failure: Mutex<Option<String>>,
}

impl TopologyMonitor {
    /// Creates a new TopologyMonitor.
    ///
    /// # Arguments
    /// * `sonos` - Sonos client for discovery and topology operations
    /// * `gena_manager` - Manager for GENA subscriptions
    /// * `sonos_state` - Shared state for Sonos groups
    /// * `emitter` - Event emitter for broadcasting network health changes
    /// * `config` - Configuration for the topology monitor
    pub fn new(
        sonos: Arc<dyn SonosTopologyClient>,
        gena_manager: Arc<GenaSubscriptionManager>,
        sonos_state: Arc<SonosState>,
        emitter: Arc<dyn EventEmitter>,
        config: TopologyMonitorConfig,
        arbiter: Arc<SubscriptionArbiter>,
    ) -> Self {
        let topology_refresh_interval_secs =
            clamp_refresh_interval_secs(config.topology_refresh_interval_secs);
        let advertised_ip = Mutex::new(config.network.get_local_ip());
        Self {
            sonos,
            gena_manager,
            sonos_state,
            emitter,
            network_health: RwLock::new(NetworkHealthState::default()),
            speakers_discovered: AtomicBool::new(false),
            topology_refresh_interval_secs,
            network: config.network,
            refresh_notify: config.refresh_notify,
            cancel_token: CancellationToken::new(),
            app_data_dir: RwLock::new(None),
            http_client: config.http_client,
            spawner: config.spawner,
            arbiter,
            mdns_advertiser: config.mdns_advertiser,
            remembered_speaker_ips: RwLock::new(Vec::new()),
            topology_diff: Mutex::new(TopologyDiff::new()),
            member_changes: config.member_changes,
            advertised_ip,
            detection_failure: Mutex::new(None),
        }
    }

    /// Sets the app data directory for loading manual speaker configuration.
    ///
    /// This should be called after the app is set up and the AppHandle is available.
    pub fn set_app_data_dir(&self, path: impl AsRef<Path>) {
        *self.app_data_dir.write() = Some(path.as_ref().to_path_buf());
    }

    /// Returns the app data directory if set.
    ///
    /// Returns `None` if `set_app_data_dir` has not been called or if it was
    /// called with an invalid path.
    pub fn get_app_data_dir(&self) -> Option<PathBuf> {
        self.app_data_dir.read().clone()
    }

    /// Returns a reference to the HTTP client for manual IP probing.
    pub fn http_client(&self) -> &Client {
        &self.http_client
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
        self.gena_manager.clone().start_renewal_task(&self.spawner);
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
        let spawner = self.spawner.clone();
        spawner.spawn(async move {
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

            log::info!(
                "[TopologyMonitor] GENA callback URL: {}",
                self.network.gena_callback_url()
            );

            let mut interval =
                tokio::time::interval(Duration::from_secs(self.topology_refresh_interval_secs));
            // Keep at least one interval between full refreshes: a burst of topology
            // events (each one iteration of this loop) must not leave a pile of missed
            // ticks that then fire back to back.
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

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

                // Check for IP changes (e.g., laptop moved networks, VPN up or down).
                // Nothing is unsubscribed here: every existing subscription now
                // holds a callback URL we no longer answer on, and the
                // reconciliation below drops exactly those at the moment it can
                // replace them — rather than leaving us with none at all if this
                // refresh turns out to fail.
                self.sync_local_ip(&self.known_speaker_ips());

                // Manual refreshes (sync session join/unjoin, GENA topology events, a
                // lost subscription) use the quick path that skips SSDP discovery (~5s)
                // and goes straight to SOAP (~300ms). It reconciles subscriptions and
                // cached state exactly like the full refresh, and deliberately leaves
                // the periodic interval alone so a stream of topology events cannot
                // keep pushing the full refresh out of reach.
                // Falls back to full refresh if quick path fails (no known speakers, etc).
                if is_manual_refresh {
                    match self.quick_refresh_zone_groups().await {
                        Ok(()) => {
                            log::info!("[TopologyMonitor] Quick refresh succeeded");
                            continue;
                        }
                        Err(e) => {
                            log::warn!(
                                "[TopologyMonitor] Quick refresh failed ({}), falling back to full refresh",
                                e
                            );
                        }
                    }
                }

                if let Err(e) = self.refresh_topology().await {
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

    /// Performs a lightweight zone group refresh using a known speaker IP.
    ///
    /// Skips SSDP discovery and goes straight to the SOAP `GetZoneGroupState` call,
    /// reducing refresh time from ~5s to ~300ms. Used for manual refresh triggers
    /// (e.g., after sync session join/unjoin) where we know speakers are already on
    /// the network and just need updated group topology.
    ///
    /// The fetched topology is reconciled the same way the full refresh reconciles
    /// its own: a coordinator that only exists after this refresh (a slave promoted
    /// when its coordinator left) gets its AVTransport subscription here, instead of
    /// waiting up to a full refresh interval for one.
    async fn quick_refresh_zone_groups(&self) -> ThaumicResult<()> {
        // Pick a coordinator IP from current state
        let coordinator_ip = {
            let groups = self.sonos_state.groups.read();
            groups.first().map(|g| g.coordinator_ip.clone())
        };

        let ip = coordinator_ip.ok_or_else(|| {
            ThaumicError::SpeakerNotFound("no known speakers for quick refresh".to_string())
        })?;

        log::info!(
            "[TopologyMonitor] Quick refresh: fetching zone groups from {} (SOAP only)",
            ip
        );

        let snapshot = self
            .sonos
            .get_zone_group_state(&ip)
            .await
            .map_err(|e| ThaumicError::Soap(format!("quick refresh SOAP failed: {}", e)))?;
        let groups = snapshot.groups;

        log::info!(
            "[TopologyMonitor] Quick refresh: {} groups found",
            groups.len()
        );

        // A reachable coordinator that reports no groups at all is anomalous: without
        // SSDP this path cannot tell "network is empty" from "bad response", and the
        // reconciliation below would wipe every speaker's cached state on the strength
        // of it. Let the full refresh decide instead.
        if groups.is_empty() {
            return Err(ThaumicError::SpeakerNotFound(
                "quick refresh returned no groups".to_string(),
            ));
        }

        // Update state and emit event
        {
            let mut state = self.sonos_state.groups.write();
            *state = groups.clone();
        }
        self.observe_household(snapshot.household, true);

        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        self.emitter.emit_topology(TopologyEvent::GroupsDiscovered {
            groups: groups.clone(),
            timestamp,
        });

        // Without SSDP the topology itself is the list of live speakers.
        let current_speaker_ips = speaker_ips_from_groups(&groups);
        let callback_url = self.network.gena_callback_url();
        self.reconcile_topology(
            &groups,
            &current_speaker_ips,
            Some(ip.as_str()),
            &callback_url,
        )
        .await;

        Ok(())
    }

    /// Performs a single topology refresh cycle.
    ///
    /// Discovers speakers, fetches zone groups, updates state, and syncs subscriptions.
    /// Tracks network health based on discovery and communication success.
    ///
    /// Address detection is re-run as soon as discovery has found anything,
    /// against the speakers it found, and before the groups are published or a
    /// single subscription is made. At launch nothing is known yet, so the
    /// address picked then is a guess from the interface list alone - and on a
    /// machine whose default route runs through a VPN adapter the filter does
    /// not recognise, it is the tunnel's. Waiting for the next pass of the loop
    /// to correct it would build the first round of subscriptions, and any
    /// stream cast in the meantime, on an address no speaker can reach.
    async fn refresh_topology(&self) -> ThaumicResult<()> {
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
            // Atomically read and reset the discovery flag
            let was_previously_discovered = self.speakers_discovered.swap(false, Ordering::Relaxed);
            log::warn!(
                "[TopologyMonitor] No speakers found (was_previously_discovered={})",
                was_previously_discovered
            );

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

            return Err(ThaumicError::SpeakerNotFound(
                "no speakers discovered".to_string(),
            ));
        }

        // Discovery succeeded - mark that we've seen speakers
        let was_first_discovery = !self.speakers_discovered.swap(true, Ordering::Relaxed);

        let current_speaker_ips: HashSet<String> = speakers.iter().map(|s| s.ip.clone()).collect();

        // Now that we know where the speakers are, advertise the address they
        // can reach, before anything below builds a URL from it.
        let discovered: Vec<Ipv4Addr> = speakers.iter().filter_map(|s| s.ip.parse().ok()).collect();
        self.sync_local_ip(&discovered);
        let callback_url = self.network.gena_callback_url();

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
        let snapshot = match self.sonos.get_zone_group_state(&query_speaker.ip).await {
            Ok(snapshot) => {
                log::info!(
                    "[TopologyMonitor] SOAP succeeded: {} groups found",
                    snapshot.groups.len()
                );
                snapshot
            }
            Err(e) => {
                log::error!(
                    "[TopologyMonitor] SOAP failed: {} - setting health to Degraded",
                    e
                );
                // Discovery worked but communication failed - this is the VPN/firewall scenario
                self.set_network_health(
                    NetworkHealth::Degraded,
                    Some("speakers_not_responding".to_string()),
                );
                return Err(e.into());
            }
        };

        let groups: Vec<ZoneGroup> = snapshot.groups;

        // Update stored groups and broadcast to clients
        {
            let mut state = self.sonos_state.groups.write();
            *state = groups.clone();
            log::debug!(
                "[TopologyMonitor] Updated state with {} groups",
                state.len()
            );
        }
        self.observe_household(snapshot.household, false);

        // Broadcast groups update to WebSocket clients and Tauri frontend
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        self.emitter.emit_topology(TopologyEvent::GroupsDiscovered {
            groups: groups.clone(),
            timestamp,
        });

        // Clean up stale state and sync subscriptions with the current topology
        self.reconcile_topology(
            &groups,
            &current_speaker_ips,
            speakers.first().map(|s| s.ip.as_str()),
            &callback_url,
        )
        .await;

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

        if refresh_looks_degraded(
            was_first_discovery,
            has_groups,
            has_subscriptions,
            transport_states_empty,
        ) {
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

    /// Compares a freshly fetched household with the previous one and reports
    /// what changed.
    ///
    /// Each change is logged (at warn when it points at trouble), sent to
    /// clients as [`TopologyEvent::MemberChanged`], and added to the timeline
    /// of every speaker it concerns that is fetching one of our streams: the
    /// device itself, the home-theatre primary it is bonded to, and its
    /// group's coordinator. A summary line follows each refresh prompted by a
    /// topology event (`after_event`), saying `unchanged` when nothing was.
    ///
    /// Only SOAP answers come here; GENA topology bodies can be stale.
    fn observe_household(&self, household: HouseholdTopology, after_event: bool) {
        if household.groups.is_empty() {
            return;
        }
        let mut diff = self.topology_diff.lock();
        let first = diff.current().is_none();
        let changes = diff.observe(household, Instant::now());
        let Some(household) = diff.current() else {
            return;
        };

        if first {
            let (satellites, missing) = household.satellite_counts();
            log::info!(
                "[Topology] Household: {} group(s), {} device(s), {} satellite(s) ({} missing), \
                 {} vanished",
                household.groups.len(),
                household.devices().count(),
                satellites,
                missing,
                household.vanished.len()
            );
        } else if after_event {
            log::info!("[Topology] After topology event: {}", summarize(&changes));
        } else if changes.is_empty() {
            log::debug!("[Topology] Refresh: unchanged");
        } else {
            log::info!("[Topology] Refresh: {}", summarize(&changes));
        }

        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        for change in changes {
            let related = related_ips(household, &change);
            let streams: Vec<String> = match &self.member_changes {
                Some(sink) => {
                    let mut streams: Vec<String> = related
                        .iter()
                        .flat_map(|ip| sink.streams_fetched_by(*ip))
                        .collect();
                    streams.sort_unstable();
                    streams.dedup();
                    streams
                }
                None => Vec::new(),
            };
            let casting = if streams.is_empty() {
                String::new()
            } else {
                format!(" (casting stream={})", streams.join(","))
            };
            let line = describe_change(household, &change);
            if change.is_warning() {
                log::warn!("[Topology] {}{}", line, casting);
            } else {
                log::info!("[Topology] {}{}", line, casting);
            }

            if let Some(sink) = &self.member_changes {
                for ip in &related {
                    sink.record(*ip, change.clone());
                }
            }
            let speaker_ip = household
                .device(change.subject_uuid())
                .map(|d| d.ip.clone());
            self.emitter.emit_topology(TopologyEvent::MemberChanged {
                change,
                speaker_ip,
                timestamp,
            });
        }
    }

    /// Speaker addresses we already know about, for choosing which of our own
    /// addresses to advertise.
    ///
    /// Two sources, because either can be the only one: the discovered topology
    /// is what we have once anything has worked, and a manually configured
    /// speaker is exactly the case where SSDP never worked. At first launch both
    /// are empty, which is what the detector's block ranking is for.
    ///
    /// The last non-empty answer is remembered and returned when this refresh
    /// has none. [`Self::refresh_topology`] clears the groups on any discovery
    /// round that finds nothing, and a lost SSDP round is routine on Wi-Fi (or
    /// simply means the speakers are switched off) - so without this a single
    /// missed round would silently demote address selection to first-launch
    /// behaviour, move the advertised address to a bridge on the same block,
    /// and re-advertise mDNS and rebuild every subscription against an address
    /// no speaker can reach, then flip back on the round after. Addresses that
    /// were right a refresh ago are better evidence than none; when the machine
    /// really has moved networks they simply match no candidate and the ranking
    /// decides as before.
    fn known_speaker_ips(&self) -> Vec<Ipv4Addr> {
        let mut ips: Vec<Ipv4Addr> = speaker_ips_from_groups(&self.sonos_state.groups.read())
            .iter()
            .filter_map(|ip| ip.parse().ok())
            .collect();

        if let Some(dir) = self.app_data_dir.read().clone() {
            ips.extend(
                ManualSpeakerConfig::load(&dir)
                    .speaker_ips
                    .iter()
                    .filter_map(|ip| ip.parse::<Ipv4Addr>().ok()),
            );
        }

        if ips.is_empty() {
            return self.remembered_speaker_ips.read().clone();
        }

        ips.sort_unstable();
        ips.dedup();
        *self.remembered_speaker_ips.write() = ips.clone();
        ips
    }

    /// Re-runs address detection against `speaker_ips` and adopts the result.
    ///
    /// Called at the top of every pass of the monitoring loop with the speakers
    /// we already know about, and again by [`Self::refresh_topology`] with the
    /// speakers it has just discovered. A failure keeps the address already
    /// advertised, and is logged once per distinct failure rather than once per
    /// tick: a host with no acceptable interface stays in that state for its
    /// whole life, and a warning every refresh interval buries the log.
    ///
    /// Whatever moved the address - this detection, or the playback path pulling
    /// it onto a speaker's subnet - the mDNS record is moved with it. Existing
    /// subscriptions are left for [`Self::reconcile_topology`], which drops the
    /// ones built on the old callback at the moment it can replace them.
    ///
    /// # Returns
    /// Whether the advertised address changed.
    fn sync_local_ip(&self, speaker_ips: &[Ipv4Addr]) -> bool {
        let previous = self.network.get_local_ip();
        match self.network.detect_ip(speaker_ips) {
            Ok(detected) => {
                if self.detection_failure.lock().take().is_some() {
                    log::info!(
                        "[TopologyMonitor] Local IP detection recovered: {}",
                        detected
                    );
                }
                if detected != previous {
                    log::warn!(
                        "[TopologyMonitor] Local IP changed: {} -> {}. Re-subscribing...",
                        previous,
                        detected
                    );
                    self.network.set_local_ip(detected);
                }
            }
            // Explicit mode (headless server) configures the advertise
            // address, so there is nothing to detect and nothing to report.
            Err(NetworkError::NoDetector) => {}
            Err(e) => {
                let message = e.to_string();
                let mut failure = self.detection_failure.lock();
                if failure.as_ref() != Some(&message) {
                    log::warn!(
                        "[TopologyMonitor] Local IP detection failed, still advertising {}: {}",
                        previous,
                        message
                    );
                    *failure = Some(message);
                } else {
                    log::debug!(
                        "[TopologyMonitor] Local IP detection still failing, advertising {}",
                        previous
                    );
                }
            }
        }

        let current = self.network.get_local_ip();
        let mut advertised = self.advertised_ip.lock();
        if *advertised == current {
            return false;
        }
        *advertised = current;
        drop(advertised);
        self.readvertise_mdns();
        true
    }

    /// The callback URL to retry a rejected subscription with, if there is a
    /// better one than `rejected_callback`.
    ///
    /// A speaker answering SUBSCRIBE with 412 Precondition Failed has refused
    /// the request as sent, and the only part of it that changes between
    /// attempts is the callback. So detection is re-run against the speakers we
    /// know about plus the one that refused, and a callback on the address that
    /// produces is returned when it differs. `None` means detection agrees with
    /// the rejected callback, and retrying it now would only be refused again.
    fn corrected_callback_after_rejection(
        &self,
        speaker_ip: &str,
        rejected_callback: &str,
    ) -> Option<String> {
        let mut speakers = self.known_speaker_ips();
        if let Ok(ip) = speaker_ip.parse::<Ipv4Addr>() {
            speakers.push(ip);
        }
        self.sync_local_ip(&speakers);
        let corrected = self.network.gena_callback_url();
        (corrected != rejected_callback).then_some(corrected)
    }

    /// Subscribes `ip` to `service`, retrying once with a corrected callback URL
    /// when the speaker rejects the first one with 412.
    ///
    /// When the address does change, a refresh is also requested so every
    /// other subscription made in this pass with the old callback is rebuilt
    /// promptly, rather than a full refresh interval later.
    async fn subscribe_with_recovery(
        &self,
        ip: &str,
        service: SonosService,
        callback_url: &str,
    ) -> GenaResult<()> {
        let result = self
            .gena_manager
            .subscribe(ip.to_string(), service, callback_url.to_string())
            .await;
        let Err(GenaError::SubscriptionFailed(412)) = result else {
            return result;
        };
        let Some(corrected) = self.corrected_callback_after_rejection(ip, callback_url) else {
            return result;
        };

        log::warn!(
            "[TopologyMonitor] {} rejected {:?} callback {} (412); retrying with {}",
            ip,
            service,
            callback_url,
            corrected
        );
        self.refresh_notify.notify_one();
        self.gena_manager
            .subscribe(ip.to_string(), service, corrected)
            .await
    }

    /// Re-registers the mDNS advertisement at the current address and port.
    ///
    /// The advertisement is registered once when the server binds; without this
    /// a process launched while a VPN was up would advertise the tunnel address
    /// for its whole lifetime. Best-effort and non-fatal, like all mDNS here.
    /// Before the server has a port there is nothing to advertise: the bind
    /// registers the record itself, at whatever address is current by then.
    fn readvertise_mdns(&self) {
        if self.network.get_port() == 0 {
            return;
        }
        mdns_advertise::advertise(
            &self.mdns_advertiser,
            &self.network.get_local_ip(),
            self.network.get_port(),
        );
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

    /// Reconciles cached speaker state and GENA subscriptions with a topology snapshot.
    ///
    /// Shared by the full and the quick refresh path, so a topology change picked up
    /// by the quick path leaves subscriptions correct for *every* current coordinator
    /// (several clients can be casting to different groups at once), not just the
    /// groups snapshot handed to the UI.
    ///
    /// Cheap to run on every topology event: subscribing and unsubscribing are both
    /// skipped for IPs already in the desired state, so an event that changed nothing
    /// costs a handful of map lookups and no network I/O.
    ///
    /// # Arguments
    /// * `groups` - Zone groups just fetched from a speaker
    /// * `current_speaker_ips` - Every speaker IP believed to still be on the network
    /// * `topology_sub_ip` - Speaker to carry the ZoneGroupTopology subscription if no
    ///   existing subscription points at a live speaker
    /// * `callback_url` - GENA callback URL for new subscriptions
    async fn reconcile_topology(
        &self,
        groups: &[ZoneGroup],
        current_speaker_ips: &HashSet<String>,
        topology_sub_ip: Option<&str>,
        callback_url: &str,
    ) {
        let coordinator_ips: HashSet<String> =
            groups.iter().map(|g| g.coordinator_ip.clone()).collect();

        // Clean up stale state entries for speakers that left the network
        self.sonos_state.cleanup_stale_entries(current_speaker_ips);

        // Drop subscriptions that name an address we no longer advertise, before
        // the steps below rebuild them against the one we do.
        self.rebuild_stale_callback_subscriptions(callback_url)
            .await;

        self.ensure_topology_subscription(topology_sub_ip, current_speaker_ips, callback_url)
            .await;

        self.sync_coordinator_subscriptions(&coordinator_ips, callback_url)
            .await;

        // Cleanup stale subscriptions (coordinators that disappeared or were demoted)
        self.cleanup_stale_subscriptions(&coordinator_ips).await;
    }

    /// Drops subscriptions whose callback address is not the one we advertise now.
    ///
    /// This is the escape from the state that forced a server restart. A
    /// subscription carries the callback URL it was created with and never
    /// re-sends it - a GENA RENEW carries only the SID and needs only outbound
    /// reachability - so one built while we advertised an address the speakers
    /// cannot reach renews successfully forever while delivering nothing, and
    /// `subscribe()` short-circuits on the existing (ip, service) pair, so it
    /// blocks its own replacement. A stored address that differs from the
    /// current one is proof of exactly that, with no counting, no timing, and
    /// nothing for an idle-but-healthy system to trip.
    ///
    /// Speakers released from a sync session are handed back to the arbiter: the
    /// stale subscription there is RenderingControl, and `ensure_group_rendering`
    /// deliberately refuses to give a sync-active speaker GroupRenderingControl,
    /// so a plain unsubscribe would leave them with no volume event source that
    /// anything ever restores.
    ///
    /// The caller rebuilds what it owns immediately afterwards.
    async fn rebuild_stale_callback_subscriptions(&self, callback_url: &str) {
        let affected_ips = self
            .gena_manager
            .unsubscribe_stale_callbacks(callback_url)
            .await;

        for ip in affected_ips {
            if self.arbiter.is_in_sync_session(&ip) {
                self.arbiter.leave_sync_session(&ip, callback_url).await;
            }
        }
    }

    /// Ensures a ZoneGroupTopology subscription exists on a valid speaker.
    ///
    /// `candidate_ip` is only used when no existing subscription points at a speaker
    /// that is still on the network.
    async fn ensure_topology_subscription(
        &self,
        candidate_ip: Option<&str>,
        current_speaker_ips: &HashSet<String>,
        callback_url: &str,
    ) {
        let topology_ips = self
            .gena_manager
            .get_subscribed_ips(SonosService::ZoneGroupTopology);
        let has_valid_sub = topology_ips
            .iter()
            .any(|ip| current_speaker_ips.contains(ip));

        if has_valid_sub {
            return;
        }

        let Some(ip) = candidate_ip else {
            return;
        };

        match self
            .subscribe_with_recovery(ip, SonosService::ZoneGroupTopology, callback_url)
            .await
        {
            Ok(()) => {
                log::info!(
                    "[TopologyMonitor] Subscribed to ZoneGroupTopology on {}",
                    ip
                );
            }
            Err(e) => {
                log::error!(
                    "[TopologyMonitor] Failed to subscribe to ZoneGroupTopology on {}: {}",
                    ip,
                    e
                );
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
                    .subscribe_with_recovery(ip, service, callback_url)
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
    ///
    /// GroupRenderingControl is skipped for speakers that have RenderingControl subscriptions,
    /// indicating they're in an active sync session managed by StreamCoordinator. This prevents
    /// dual subscriptions that cause volume event race conditions.
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

        // Subscribe to GroupRenderingControl (volume/mute) via the arbiter,
        // which handles sync session conflicts (skips speakers with RC active).
        for ip in coordinator_ips {
            self.arbiter.ensure_group_rendering(ip, callback_url).await;
        }
    }

    /// Unsubscribes from coordinators that are no longer in the topology.
    ///
    /// This handles both disappeared speakers and demoted coordinators (satellites).
    /// Only unsubscribes AVTransport and GroupRenderingControl (TopologyMonitor-owned).
    /// RenderingControl is managed by SubscriptionArbiter for sync sessions.
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
                "[TopologyMonitor] Speaker {} is no longer a coordinator, unsubscribing AVTransport and GroupRenderingControl",
                ip
            );
            // Only unsubscribe services owned by TopologyMonitor (not RenderingControl).
            self.gena_manager
                .unsubscribe_by_ip_and_service(&ip, SonosService::AVTransport)
                .await;
            self.gena_manager
                .unsubscribe_by_ip_and_service(&ip, SonosService::GroupRenderingControl)
                .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::Mutex;

    use async_trait::async_trait;

    use crate::error::{DiscoveryResult, SoapResult};
    use crate::events::{LatencyEvent, SonosEvent, StreamEvent};
    use crate::sonos::types::{TransportState, ZoneGroupMember, ZoneGroupSnapshot};

    /// Topology client that serves a canned zone group list, and a
    /// household that tests can swap between refreshes.
    ///
    /// It can also discover a fixed set of speakers, and record the address
    /// being advertised at the moment it is asked for zone groups: that call
    /// comes after discovery and before any subscription is made, so it shows
    /// which callback the first subscriptions are built on.
    struct StubTopologyClient {
        groups: Vec<ZoneGroup>,
        household: Arc<Mutex<HouseholdTopology>>,
        speakers: Vec<Speaker>,
        network: Option<NetworkContext>,
        ip_at_soap: Arc<Mutex<Option<String>>>,
    }

    impl StubTopologyClient {
        fn new(groups: Vec<ZoneGroup>, household: Arc<Mutex<HouseholdTopology>>) -> Self {
            Self {
                groups,
                household,
                speakers: Vec::new(),
                network: None,
                ip_at_soap: Arc::new(Mutex::new(None)),
            }
        }
    }

    #[async_trait]
    impl crate::sonos::traits::SonosTopology for StubTopologyClient {
        async fn get_zone_group_state(&self, _ip: &str) -> SoapResult<ZoneGroupSnapshot> {
            if let Some(network) = &self.network {
                *self.ip_at_soap.lock().unwrap() = Some(network.get_local_ip());
            }
            Ok(ZoneGroupSnapshot {
                groups: self.groups.clone(),
                household: self.household.lock().unwrap().clone(),
            })
        }
    }

    #[async_trait]
    impl crate::sonos::traits::SonosDiscovery for StubTopologyClient {
        async fn discover_speakers(&self) -> DiscoveryResult<Vec<Speaker>> {
            Ok(self.speakers.clone())
        }
    }

    /// Event emitter that records the topology events it is handed.
    struct CollectingEmitter {
        topology: Mutex<Vec<TopologyEvent>>,
    }

    impl CollectingEmitter {
        fn new() -> Self {
            Self {
                topology: Mutex::new(Vec::new()),
            }
        }
    }

    impl EventEmitter for CollectingEmitter {
        fn emit_stream(&self, _event: StreamEvent) {}
        fn emit_sonos(&self, _event: SonosEvent) {}
        fn emit_network(&self, _event: NetworkEvent) {}
        fn emit_topology(&self, event: TopologyEvent) {
            self.topology.lock().unwrap().push(event);
        }
        fn emit_latency(&self, _event: LatencyEvent) {}
    }

    /// Builds a single-speaker group (the shape of an ungrouped room).
    fn group(coordinator_ip: &str, uuid: &str) -> ZoneGroup {
        ZoneGroup {
            id: format!("{}:1", uuid),
            name: format!("Room {}", coordinator_ip),
            coordinator_uuid: uuid.to_string(),
            coordinator_ip: coordinator_ip.to_string(),
            members: vec![ZoneGroupMember {
                uuid: uuid.to_string(),
                ip: coordinator_ip.to_string(),
                zone_name: format!("Room {}", coordinator_ip),
                model: "One".to_string(),
            }],
        }
    }

    /// Creates a monitor whose quick refresh returns `groups`.
    ///
    /// The GENA client uses a 1ms timeout so subscribe attempts against speakers
    /// that do not exist fail immediately instead of blocking on TCP retries.
    fn create_monitor(
        groups: Vec<ZoneGroup>,
        sonos_state: Arc<SonosState>,
        emitter: Arc<dyn EventEmitter>,
    ) -> TopologyMonitor {
        create_monitor_with_household(
            groups,
            Arc::new(Mutex::new(HouseholdTopology::default())),
            sonos_state,
            emitter,
        )
    }

    /// Creates a monitor whose quick refresh returns `groups` and whatever
    /// `household` holds at the time.
    fn create_monitor_with_household(
        groups: Vec<ZoneGroup>,
        household: Arc<Mutex<HouseholdTopology>>,
        sonos_state: Arc<SonosState>,
        emitter: Arc<dyn EventEmitter>,
    ) -> TopologyMonitor {
        create_monitor_with_client(
            StubTopologyClient::new(groups, household),
            NetworkContext::for_test(),
            sonos_state,
            emitter,
        )
    }

    /// Creates a monitor around `client`, advertising through `network`.
    fn create_monitor_with_client(
        client: StubTopologyClient,
        network: NetworkContext,
        sonos_state: Arc<SonosState>,
        emitter: Arc<dyn EventEmitter>,
    ) -> TopologyMonitor {
        let http_client = Client::builder()
            .timeout(Duration::from_millis(1))
            .build()
            .unwrap();
        let (gena_manager, _rx) = GenaSubscriptionManager::new(http_client.clone());
        let gena_manager = Arc::new(gena_manager);
        let arbiter = Arc::new(SubscriptionArbiter::new(Arc::clone(&gena_manager)));
        TopologyMonitor::new(
            Arc::new(client),
            gena_manager,
            sonos_state,
            emitter,
            TopologyMonitorConfig {
                topology_refresh_interval_secs: 30,
                network,
                refresh_notify: Arc::new(Notify::new()),
                http_client,
                spawner: TokioSpawner::new(tokio::runtime::Handle::current()),
                mdns_advertiser: crate::mdns_advertise::advertiser_handle(),
                member_changes: None,
            },
            arbiter,
        )
    }

    #[test]
    fn zero_refresh_interval_is_clamped_to_one_second() {
        assert_eq!(clamp_refresh_interval_secs(0), 1);
    }

    #[test]
    fn valid_refresh_interval_is_unchanged() {
        assert_eq!(clamp_refresh_interval_secs(1), 1);
        assert_eq!(clamp_refresh_interval_secs(30), 30);
    }

    #[test]
    fn a_refresh_with_subscriptions_but_nothing_reported_is_degraded() {
        // Groups are visible and their coordinators are subscribed, yet not one
        // speaker has ever said what it is doing: they cannot reach us.
        assert!(refresh_looks_degraded(false, true, true, true));
    }

    #[test]
    fn an_address_change_does_not_raise_the_banner_on_a_healthy_system() {
        // Reconciliation has just rebuilt every subscription against the new
        // callback URL and the first NOTIFY is still in flight, microseconds
        // later. Cached transport state from before the change is still there,
        // so nothing is reported to the user.
        assert!(!refresh_looks_degraded(false, true, true, false));
    }

    #[test]
    fn the_first_discovery_is_never_degraded() {
        // Subscriptions were created moments ago in this same refresh.
        assert!(!refresh_looks_degraded(true, true, true, true));
    }

    #[test]
    fn nothing_to_listen_to_is_not_degraded() {
        assert!(!refresh_looks_degraded(false, true, false, true));
        assert!(!refresh_looks_degraded(false, false, true, true));
    }

    #[test]
    fn speaker_ips_cover_every_member_of_every_group() {
        let mut grouped = group("192.168.1.10", "RINCON_A");
        grouped.members.push(ZoneGroupMember {
            uuid: "RINCON_B".to_string(),
            ip: "192.168.1.11".to_string(),
            zone_name: "Kitchen".to_string(),
            model: "One".to_string(),
        });
        let groups = vec![grouped, group("192.168.1.20", "RINCON_C")];

        let ips = speaker_ips_from_groups(&groups);

        assert_eq!(ips.len(), 3);
        assert!(ips.contains("192.168.1.10"));
        assert!(ips.contains("192.168.1.11"));
        assert!(ips.contains("192.168.1.20"));
    }

    #[tokio::test]
    async fn quick_refresh_replaces_groups_and_emits() {
        let sonos_state = Arc::new(SonosState::default());
        *sonos_state.groups.write() = vec![group("192.168.1.10", "RINCON_A")];
        let emitter = Arc::new(CollectingEmitter::new());

        let monitor = create_monitor(
            vec![
                group("192.168.1.10", "RINCON_A"),
                group("192.168.1.20", "RINCON_C"),
            ],
            Arc::clone(&sonos_state),
            Arc::clone(&emitter) as Arc<dyn EventEmitter>,
        );

        monitor.quick_refresh_zone_groups().await.unwrap();

        assert_eq!(sonos_state.groups.read().len(), 2);
        assert_eq!(emitter.topology.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn quick_refresh_drops_state_for_speakers_that_left() {
        // Two clients casting to two different groups, plus a speaker that has
        // since vanished from the topology.
        let sonos_state = Arc::new(SonosState::default());
        *sonos_state.groups.write() = vec![
            group("192.168.1.10", "RINCON_A"),
            group("192.168.1.20", "RINCON_C"),
            group("192.168.1.30", "RINCON_GONE"),
        ];
        sonos_state
            .transport_states
            .insert("192.168.1.10".to_string(), TransportState::Playing);
        sonos_state
            .transport_states
            .insert("192.168.1.20".to_string(), TransportState::Playing);
        sonos_state
            .transport_states
            .insert("192.168.1.30".to_string(), TransportState::Playing);
        sonos_state
            .group_volumes
            .insert("192.168.1.30".to_string(), 42);

        let monitor = create_monitor(
            vec![
                group("192.168.1.10", "RINCON_A"),
                group("192.168.1.20", "RINCON_C"),
            ],
            Arc::clone(&sonos_state),
            Arc::new(CollectingEmitter::new()) as Arc<dyn EventEmitter>,
        );

        monitor.quick_refresh_zone_groups().await.unwrap();

        // Both still-present coordinators keep their state; the departed one is dropped.
        assert!(sonos_state.transport_states.contains_key("192.168.1.10"));
        assert!(sonos_state.transport_states.contains_key("192.168.1.20"));
        assert!(!sonos_state.transport_states.contains_key("192.168.1.30"));
        assert!(!sonos_state.group_volumes.contains_key("192.168.1.30"));
    }

    #[tokio::test]
    async fn quick_refresh_keeps_state_when_topology_comes_back_empty() {
        let sonos_state = Arc::new(SonosState::default());
        *sonos_state.groups.write() = vec![group("192.168.1.10", "RINCON_A")];
        sonos_state
            .transport_states
            .insert("192.168.1.10".to_string(), TransportState::Playing);

        let monitor = create_monitor(
            Vec::new(),
            Arc::clone(&sonos_state),
            Arc::new(CollectingEmitter::new()) as Arc<dyn EventEmitter>,
        );

        assert!(monitor.quick_refresh_zone_groups().await.is_err());

        // Nothing was wiped - the full refresh path decides what to do.
        assert_eq!(sonos_state.groups.read().len(), 1);
        assert!(sonos_state.transport_states.contains_key("192.168.1.10"));
    }

    #[tokio::test]
    async fn quick_refresh_needs_a_known_speaker() {
        let sonos_state = Arc::new(SonosState::default());
        let monitor = create_monitor(
            vec![group("192.168.1.10", "RINCON_A")],
            Arc::clone(&sonos_state),
            Arc::new(CollectingEmitter::new()) as Arc<dyn EventEmitter>,
        );

        let err = monitor.quick_refresh_zone_groups().await.unwrap_err();

        assert!(matches!(err, ThaumicError::SpeakerNotFound(_)));
    }

    #[tokio::test]
    async fn nothing_is_known_before_anything_is_discovered() {
        // First launch: the detector gets an empty slice and falls back to its
        // block ranking.
        let monitor = create_monitor(
            Vec::new(),
            Arc::new(SonosState::default()),
            Arc::new(CollectingEmitter::new()) as Arc<dyn EventEmitter>,
        );

        assert!(monitor.known_speaker_ips().is_empty());
    }

    #[tokio::test]
    async fn a_lost_discovery_round_keeps_the_speakers_we_already_knew() {
        // refresh_topology clears the groups whenever discovery finds nothing,
        // which happens on a dropped multicast round, a Wi-Fi roam, or speakers
        // simply switched off. The address we advertise must not move on the
        // strength of that: it would re-advertise mDNS and rebuild every
        // subscription against an address the speakers cannot reach, then flip
        // back on the next round.
        let sonos_state = Arc::new(SonosState::default());
        *sonos_state.groups.write() = vec![group("192.168.86.40", "RINCON_A")];

        let monitor = create_monitor(
            Vec::new(),
            Arc::clone(&sonos_state),
            Arc::new(CollectingEmitter::new()) as Arc<dyn EventEmitter>,
        );

        assert_eq!(
            monitor.known_speaker_ips(),
            vec![Ipv4Addr::new(192, 168, 86, 40)]
        );

        sonos_state.groups.write().clear();

        assert_eq!(
            monitor.known_speaker_ips(),
            vec![Ipv4Addr::new(192, 168, 86, 40)]
        );
    }

    #[tokio::test]
    async fn a_successful_discovery_replaces_what_we_remembered() {
        // The laptop really did move networks: the new topology is what counts,
        // and the old addresses must not linger and keep steering selection.
        let sonos_state = Arc::new(SonosState::default());
        *sonos_state.groups.write() = vec![group("192.168.86.40", "RINCON_A")];

        let monitor = create_monitor(
            Vec::new(),
            Arc::clone(&sonos_state),
            Arc::new(CollectingEmitter::new()) as Arc<dyn EventEmitter>,
        );
        assert_eq!(
            monitor.known_speaker_ips(),
            vec![Ipv4Addr::new(192, 168, 86, 40)]
        );

        *sonos_state.groups.write() = vec![group("10.1.2.3", "RINCON_B")];

        assert_eq!(
            monitor.known_speaker_ips(),
            vec![Ipv4Addr::new(10, 1, 2, 3)]
        );
    }

    fn member_changes(emitter: &CollectingEmitter) -> Vec<MemberChange> {
        emitter
            .topology
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                TopologyEvent::MemberChanged { change, .. } => Some(change.clone()),
                TopologyEvent::GroupsDiscovered { .. } => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn a_refresh_reports_a_satellite_that_dropped_since_the_last_one() {
        use crate::sonos::test_fixtures::{HT_HOUSEHOLD, HT_HOUSEHOLD_LR_MISSING, HT_LR_UUID};
        use crate::sonos::zone_groups::parse_household_topology;

        let sonos_state = Arc::new(SonosState::default());
        *sonos_state.groups.write() = vec![group("192.168.2.204", "RINCON_A")];
        let household = Arc::new(Mutex::new(parse_household_topology(HT_HOUSEHOLD)));
        let emitter = Arc::new(CollectingEmitter::new());
        let monitor = create_monitor_with_household(
            vec![group("192.168.2.204", "RINCON_A")],
            Arc::clone(&household),
            Arc::clone(&sonos_state),
            Arc::clone(&emitter) as Arc<dyn EventEmitter>,
        );

        monitor.quick_refresh_zone_groups().await.unwrap();
        assert!(
            member_changes(&emitter).is_empty(),
            "a healthy first snapshot has nothing to report"
        );

        *household.lock().unwrap() = parse_household_topology(HT_HOUSEHOLD_LR_MISSING);
        monitor.quick_refresh_zone_groups().await.unwrap();

        let changes = member_changes(&emitter);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind(), "satellite_missing");
        assert_eq!(changes[0].subject_uuid(), HT_LR_UUID);
    }

    #[test]
    fn a_satellite_change_concerns_the_primary_that_fetches() {
        use crate::sonos::test_fixtures::{HT_HOUSEHOLD, HT_LR_UUID, HT_PRIMARY_UUID, HT_SUB_UUID};
        use crate::sonos::zone_groups::parse_household_topology;

        let household = parse_household_topology(HT_HOUSEHOLD);
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();

        // The missing satellite is no longer listed: its primary is.
        let missing = MemberChange::SatelliteMissing {
            primary_uuid: HT_PRIMARY_UUID.to_string(),
            uuid: HT_LR_UUID.to_string(),
            role: "LR".to_string(),
        };
        assert_eq!(related_ips(&household, &missing), vec![ip("192.168.2.204")]);

        // A satellite rebooting concerns itself and the primary it plays for.
        let rebooted = MemberChange::DeviceRebooted {
            uuid: HT_SUB_UUID.to_string(),
            from: 31,
            to: 32,
        };
        assert_eq!(
            related_ips(&household, &rebooted),
            vec![ip("192.168.2.205"), ip("192.168.2.204")]
        );
        assert_eq!(
            describe_change(&household, &missing),
            format!(
                "HT {HT_PRIMARY_UUID}(192.168.2.204) Living Room: satellite {HT_LR_UUID} (LR) \
                 missing"
            )
        );
    }

    /// A Windows laptop with Cloudflare WARP connected at launch: the tunnel
    /// adapter's name is not one the virtual-interface filter knows, its CGNAT
    /// address owns the default route, and the speakers are on the Wi-Fi LAN.
    fn warp_network() -> NetworkContext {
        let detector = Arc::new(crate::context::FakeInterfaceDetector::new(
            &[("CloudflareWARP", "100.96.0.12"), ("Wi-Fi", "192.168.2.50")],
            Some("100.96.0.12"),
        ));
        NetworkContext::auto_detect(0, detector).unwrap()
    }

    fn speaker(ip: &str, uuid: &str) -> Speaker {
        Speaker {
            ip: ip.to_string(),
            name: format!("Room {ip}"),
            uuid: uuid.to_string(),
            model_name: Some("One".to_string()),
        }
    }

    #[tokio::test]
    async fn the_first_discovery_moves_the_address_onto_the_speakers_lan_before_subscribing() {
        let network = warp_network();
        // Nothing is known at launch, so the default route decides.
        assert_eq!(network.get_local_ip(), "100.96.0.12");

        let mut client = StubTopologyClient::new(
            vec![group("192.168.2.204", "RINCON_A")],
            Arc::new(Mutex::new(HouseholdTopology::default())),
        );
        client.speakers = vec![speaker("192.168.2.204", "RINCON_A")];
        client.network = Some(network.clone());
        let ip_at_soap = Arc::clone(&client.ip_at_soap);
        let monitor = create_monitor_with_client(
            client,
            network.clone(),
            Arc::new(SonosState::default()),
            Arc::new(CollectingEmitter::new()) as Arc<dyn EventEmitter>,
        );

        monitor.refresh_topology().await.unwrap();

        // Corrected in the same refresh, before the groups were published or
        // the first subscription was attempted - not a refresh interval later.
        assert_eq!(ip_at_soap.lock().unwrap().as_deref(), Some("192.168.2.50"));
        assert_eq!(network.get_local_ip(), "192.168.2.50");
        assert_eq!(
            network.gena_callback_url(),
            "http://192.168.2.50:0/sonos/gena"
        );
    }

    #[tokio::test]
    async fn a_refresh_that_discovers_nothing_keeps_the_launch_address() {
        let network = warp_network();
        let monitor = create_monitor_with_client(
            StubTopologyClient::new(
                Vec::new(),
                Arc::new(Mutex::new(HouseholdTopology::default())),
            ),
            network.clone(),
            Arc::new(SonosState::default()),
            Arc::new(CollectingEmitter::new()) as Arc<dyn EventEmitter>,
        );

        assert!(monitor.refresh_topology().await.is_err());
        assert_eq!(network.get_local_ip(), "100.96.0.12");
    }

    #[tokio::test]
    async fn a_rejected_subscription_is_retried_on_the_speakers_subnet() {
        // A speaker refused SUBSCRIBE with 412 while we still advertised the
        // tunnel: the retry must carry a callback on the LAN address.
        let network = warp_network();
        let monitor = create_monitor_with_client(
            StubTopologyClient::new(
                Vec::new(),
                Arc::new(Mutex::new(HouseholdTopology::default())),
            ),
            network.clone(),
            Arc::new(SonosState::default()),
            Arc::new(CollectingEmitter::new()) as Arc<dyn EventEmitter>,
        );
        let rejected = network.gena_callback_url();

        assert_eq!(
            monitor
                .corrected_callback_after_rejection("192.168.2.204", &rejected)
                .as_deref(),
            Some("http://192.168.2.50:0/sonos/gena")
        );

        // Detection now agrees with the callback, so a second rejection has
        // nothing better to retry with.
        assert_eq!(
            monitor.corrected_callback_after_rejection(
                "192.168.2.204",
                "http://192.168.2.50:0/sonos/gena"
            ),
            None
        );
    }

    #[tokio::test]
    async fn the_headless_server_keeps_its_configured_address() {
        // Explicit mode: a refresh that finds speakers elsewhere changes nothing.
        let network = NetworkContext::explicit(0, "100.96.0.12".parse().unwrap());
        let mut client = StubTopologyClient::new(
            vec![group("192.168.2.204", "RINCON_A")],
            Arc::new(Mutex::new(HouseholdTopology::default())),
        );
        client.speakers = vec![speaker("192.168.2.204", "RINCON_A")];
        let monitor = create_monitor_with_client(
            client,
            network.clone(),
            Arc::new(SonosState::default()),
            Arc::new(CollectingEmitter::new()) as Arc<dyn EventEmitter>,
        );

        monitor.refresh_topology().await.unwrap();
        assert_eq!(network.get_local_ip(), "100.96.0.12");
        assert_eq!(
            monitor.corrected_callback_after_rejection(
                "192.168.2.204",
                "http://100.96.0.12:0/sonos/gena"
            ),
            None
        );
    }
}
