//! GENA (UPnP General Event Notification Architecture) subscription management.
//!
//! This module provides the main coordinator for GENA subscriptions,
//! composing the subscription store and HTTP client.

use std::sync::Arc;
use std::time::Duration;

use reqwest::Client;
use serde::Serialize;
use thiserror::Error;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::protocol_constants::{
    GENA_EVENT_CHANNEL_CAPACITY, GENA_RENEWAL_BUFFER_SECS, GENA_RENEWAL_CHECK_SECS,
};
use crate::runtime::TokioSpawner;

use super::gena_client::GenaClient;
use super::gena_store::GenaSubscriptionStore;
use super::services::SonosService;
use super::types::{TransportState, ZoneGroup};

/// Errors that can occur during GENA subscription operations.
#[derive(Debug, Error)]
pub enum GenaError {
    /// HTTP request to the speaker failed.
    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),

    /// Subscription request returned a non-success status code.
    #[error("Subscription failed with status {0}")]
    SubscriptionFailed(u16),

    /// Renewal request returned a non-success status code.
    #[error("Renewal failed with status {0}")]
    RenewalFailed(u16),

    /// The speaker's response was missing the required SID header.
    #[error("Missing SID in subscription response")]
    MissingSid,
}

/// Convenient Result alias for GENA subscription operations.
pub type GenaResult<T> = Result<T, GenaError>;

/// Events received from Sonos speakers via GENA notifications.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SonosEvent {
    /// Transport state changed (play/pause/stop).
    TransportState {
        #[serde(rename = "speakerIp")]
        speaker_ip: String,
        state: TransportState,
        #[serde(rename = "currentUri", skip_serializing_if = "Option::is_none")]
        current_uri: Option<String>,
        timestamp: u64,
    },
    /// Group volume changed (from coordinator).
    GroupVolume {
        #[serde(rename = "speakerIp")]
        speaker_ip: String,
        volume: u8,
        /// Whether the output is fixed (line-level, cannot be adjusted).
        #[serde(skip_serializing_if = "Option::is_none")]
        fixed: Option<bool>,
        timestamp: u64,
    },
    /// Group mute state changed (from coordinator).
    GroupMute {
        #[serde(rename = "speakerIp")]
        speaker_ip: String,
        muted: bool,
        timestamp: u64,
    },
    /// Source changed (current URI doesn't match expected stream).
    SourceChanged {
        #[serde(rename = "speakerIp")]
        speaker_ip: String,
        #[serde(rename = "currentUri")]
        current_uri: String,
        #[serde(rename = "expectedUri", skip_serializing_if = "Option::is_none")]
        expected_uri: Option<String>,
        timestamp: u64,
    },
    /// Zone group topology changed.
    ZoneGroupsUpdated {
        groups: Vec<ZoneGroup>,
        timestamp: u64,
    },
    /// GENA subscription was lost and could not be recovered.
    SubscriptionLost {
        #[serde(rename = "speakerIp")]
        speaker_ip: String,
        service: SonosService,
        reason: String,
    },
}

/// Manages GENA (Universal Plug and Play event) subscriptions for Sonos speakers.
///
/// This is a thin coordinator that composes:
/// - `GenaSubscriptionStore` for state management
/// - `GenaClient` for HTTP operations
pub struct GenaSubscriptionManager {
    /// Pure state management for subscriptions.
    store: GenaSubscriptionStore,
    /// HTTP client for GENA operations.
    client: GenaClient,
    /// Event sender for emitting SonosEvents (bounded to prevent unbounded memory growth).
    event_tx: mpsc::Sender<SonosEvent>,
    /// Token to signal background tasks to stop.
    cancel_token: CancellationToken,
}

impl GenaSubscriptionManager {
    /// Creates a new GenaSubscriptionManager instance along with an event receiver.
    ///
    /// The returned receiver will receive internal GENA events (subscription lost, etc.).
    /// The channel is bounded to prevent unbounded memory growth; events are dropped
    /// if the channel fills (with a warning log).
    ///
    /// # Arguments
    /// * `http_client` - The HTTP client to use for GENA requests
    pub fn new(http_client: Client) -> (Self, mpsc::Receiver<SonosEvent>) {
        let (event_tx, event_rx) = mpsc::channel(GENA_EVENT_CHANNEL_CAPACITY);
        let manager = Self {
            store: GenaSubscriptionStore::new(),
            client: GenaClient::new(http_client),
            event_tx,
            cancel_token: CancellationToken::new(),
        };
        (manager, event_rx)
    }

    /// Checks if a subscription exists for the given IP and service.
    #[must_use]
    pub fn is_subscribed(&self, ip: &str, service: SonosService) -> bool {
        self.store.is_subscribed(ip, service)
    }

    /// Gets all IPs that have an active subscription for the given service.
    #[must_use]
    pub fn get_subscribed_ips(&self, service: SonosService) -> Vec<String> {
        self.store.get_subscribed_ips(service)
    }

    /// Emits a SubscriptionLost event to the event channel.
    ///
    /// Uses `try_send` to avoid blocking. If the channel is full, the event is
    /// dropped with a warning (acceptable since all SubscriptionLost events
    /// trigger the same recovery action - a topology refresh).
    fn emit_subscription_lost(&self, speaker_ip: String, service: SonosService, reason: String) {
        let event = SonosEvent::SubscriptionLost {
            speaker_ip,
            service,
            reason,
        };
        if let Err(e) = self.event_tx.try_send(event) {
            match e {
                mpsc::error::TrySendError::Full(_) => {
                    log::warn!(
                        "[GENA] Event channel full, dropping SubscriptionLost event (recovery already pending)"
                    );
                }
                mpsc::error::TrySendError::Closed(_) => {
                    log::error!("[GENA] Event channel closed, cannot emit SubscriptionLost");
                }
            }
        }
    }

    /// Starts a background task to renew subscriptions before they expire.
    ///
    /// The task will stop gracefully when the cancellation token is triggered.
    ///
    /// # Arguments
    /// * `spawner` - The task spawner to use for running the background task
    pub fn start_renewal_task(self: Arc<Self>, spawner: &TokioSpawner) {
        let cancel_token = self.cancel_token.clone();
        spawner.spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(GENA_RENEWAL_CHECK_SECS));
            loop {
                tokio::select! {
                    _ = cancel_token.cancelled() => {
                        log::info!("[GENA] Renewal task shutting down");
                        break;
                    }
                    _ = interval.tick() => {}
                }

                let to_renew = self.store.get_expiring(GENA_RENEWAL_BUFFER_SECS);

                for (sid, ip, service, callback_url) in to_renew {
                    match self.client.renew(&ip, service, &sid).await {
                        Ok(timeout_secs) => {
                            self.store.update_expiry(&sid, timeout_secs);
                            log::debug!(
                                "[GENA] Renewed subscription {} for {} ({})",
                                sid,
                                ip,
                                service.name()
                            );
                        }
                        Err(e) => {
                            log::error!(
                                "[GENA] Failed to renew subscription {} for {}: {}",
                                sid,
                                ip,
                                e
                            );

                            // Remove the failed subscription
                            self.store.remove(&sid);

                            // Attempt to re-subscribe
                            log::info!(
                                "[GENA] Attempting to re-subscribe to {} on {}",
                                service.name(),
                                ip
                            );
                            if let Err(re_err) =
                                self.subscribe(ip.clone(), service, callback_url).await
                            {
                                log::error!(
                                    "[GENA] Re-subscription failed for {} on {}: {}",
                                    service.name(),
                                    ip,
                                    re_err
                                );

                                // Emit SubscriptionLost event
                                self.emit_subscription_lost(ip, service, re_err.to_string());
                            }
                        }
                    }
                }
            }
        });
    }

    /// Subscribes to a service on a Sonos speaker.
    ///
    /// If a subscription already exists or is in-flight for the (IP, service) pair,
    /// this returns immediately without creating a duplicate subscription.
    pub async fn subscribe(
        &self,
        ip: String,
        service: SonosService,
        callback_url: String,
    ) -> GenaResult<()> {
        // Atomically check for existing/pending subscription and mark as pending.
        // This prevents TOCTOU races between concurrent subscribe() calls.
        if !self.store.try_mark_pending(&ip, service) {
            log::debug!(
                "[GENA] Subscription already exists or in-flight for {} on {}",
                service.name(),
                ip
            );
            return Ok(());
        }

        match self.client.subscribe(&ip, service, &callback_url).await {
            Ok(response) => {
                self.store.insert(
                    response.sid.clone(),
                    ip.clone(),
                    service,
                    callback_url,
                    response.timeout_secs,
                );
                log::info!(
                    "[GENA] Subscribed to {} on {} (SID: {})",
                    service.name(),
                    ip,
                    response.sid
                );
                Ok(())
            }
            Err(e) => {
                self.store.clear_pending(&ip, service);
                Err(e)
            }
        }
    }

    /// Unsubscribes from a specific subscription by SID.
    pub async fn unsubscribe(&self, sid: &str) -> GenaResult<()> {
        let Some((ip, service)) = self.store.get(sid) else {
            return Ok(()); // Already unsubscribed
        };

        let success = self.client.unsubscribe(&ip, service, sid).await;

        // Remove from tracking regardless of response (speaker may be unreachable)
        self.store.remove(sid);

        if success {
            log::info!(
                "[GENA] Unsubscribed {} from {} ({})",
                sid,
                ip,
                service.name()
            );
        } else {
            log::warn!("[GENA] Unsubscribe returned error, but removed locally");
        }

        Ok(())
    }

    /// Unsubscribes from all subscriptions for a specific speaker IP.
    pub async fn unsubscribe_by_ip(&self, ip: &str) {
        let sids = self.store.get_sids_by_ip(ip);

        for sid in sids {
            if let Err(e) = self.unsubscribe(&sid).await {
                log::error!("[GENA] Failed to unsubscribe {}: {}", sid, e);
            }
        }
    }

    /// Unsubscribes from a specific service on a specific speaker IP.
    pub async fn unsubscribe_by_ip_and_service(&self, ip: &str, service: SonosService) {
        if let Some(sid) = self.store.get_sid_by_ip_and_service(ip, service) {
            if let Err(e) = self.unsubscribe(&sid).await {
                log::error!(
                    "[GENA] Failed to unsubscribe {} from {} on {}: {}",
                    sid,
                    service.name(),
                    ip,
                    e
                );
            }
        } else {
            // No subscription found - this can happen if:
            // 1. Speaker was never subscribed (normal for speakers not in sync sessions)
            // 2. Subscription was already removed (race condition or speaker reboot)
            // 3. State desync between store and actual subscriptions
            log::debug!(
                "[GENA] No {} subscription found for {} (may already be unsubscribed)",
                service.name(),
                ip
            );
        }
    }

    /// Unsubscribes from every subscription whose callback URL is not `callback_url`.
    ///
    /// A subscription is created with a callback URL and never re-sends it:
    /// [`Self::start_renewal_task`] renews by SID alone, which needs only
    /// outbound reachability. So one created while we advertised an address the
    /// speakers cannot reach (a VPN tunnel, a since-changed DHCP lease) renews
    /// successfully forever, delivers nothing, and — because [`Self::subscribe`]
    /// short-circuits on an existing (ip, service) pair — blocks its own
    /// replacement. The stored address differing from the current one is proof
    /// of that by construction, with no timing or counting involved.
    ///
    /// # Returns
    /// The speaker IPs affected, deduplicated, so callers can restore whatever
    /// they own on those speakers.
    pub async fn unsubscribe_stale_callbacks(&self, callback_url: &str) -> Vec<String> {
        let stale = self.store.get_stale_callbacks(callback_url);
        if stale.is_empty() {
            return Vec::new();
        }

        let mut ips: Vec<String> = Vec::with_capacity(stale.len());
        for (sid, ip) in &stale {
            log::warn!(
                "[GENA] Subscription {} on {} was built against another callback URL; dropping it so it is rebuilt for {}",
                sid,
                ip,
                callback_url
            );
            if !ips.contains(ip) {
                ips.push(ip.clone());
            }
        }

        let futures: Vec<_> = stale
            .iter()
            .map(|(sid, _)| async move {
                if let Err(e) = self.unsubscribe(sid).await {
                    log::error!("[GENA] Failed to unsubscribe stale {}: {}", sid, e);
                }
            })
            .collect();
        futures::future::join_all(futures).await;

        ips
    }

    /// Unsubscribes from all active subscriptions concurrently.
    pub async fn unsubscribe_all(&self) {
        let sids = self.store.get_all_sids();

        let futures: Vec<_> = sids
            .iter()
            .map(|sid| async move {
                if let Err(e) = self.unsubscribe(sid).await {
                    log::error!("[GENA] Failed to unsubscribe {}: {}", sid, e);
                }
            })
            .collect();

        futures::future::join_all(futures).await;
    }

    /// Stops background tasks and unsubscribes from all active subscriptions (for graceful shutdown).
    pub async fn shutdown(&self) {
        log::info!("[GENA] Initiating shutdown");
        self.cancel_token.cancel();
        self.unsubscribe_all().await;
    }

    /// Resolves a subscription ID to the speaker IP and service type.
    ///
    /// Returns `None` for unknown SIDs (e.g. race after unsubscribe, stale
    /// notifications, or potential replay attacks).
    #[must_use]
    pub fn resolve_sid(&self, sid: &str) -> Option<(String, SonosService)> {
        let result = self.store.get(sid);
        if result.is_none() {
            log::warn!("[GENA] Received NOTIFY for unknown SID: {}", sid,);
        }
        result
    }

    /// Returns the number of active subscriptions.
    #[must_use]
    pub fn subscription_count(&self) -> usize {
        self.store.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a manager whose HTTP calls fail immediately.
    ///
    /// Unsubscribe removes from the store regardless of the speaker's reply, so
    /// a 1ms timeout exercises the real path without needing a speaker.
    fn manager() -> Arc<GenaSubscriptionManager> {
        let http_client = Client::builder()
            .timeout(Duration::from_millis(1))
            .build()
            .unwrap();
        let (manager, _rx) = GenaSubscriptionManager::new(http_client);
        Arc::new(manager)
    }

    const CURRENT_CALLBACK: &str = "http://192.168.1.5:8080/gena";

    #[tokio::test]
    async fn a_subscription_built_against_another_address_is_dropped() {
        let manager = manager();
        // Built while a VPN tunnel address was advertised: renews forever,
        // delivers nothing, and blocks its own replacement.
        manager.store.insert(
            "uuid:stale".to_string(),
            "192.0.2.10".to_string(),
            SonosService::AVTransport,
            "http://10.8.0.2:8080/gena".to_string(),
            300,
        );
        // Built against the address we advertise now.
        manager.store.insert(
            "uuid:fresh".to_string(),
            "192.0.2.11".to_string(),
            SonosService::AVTransport,
            CURRENT_CALLBACK.to_string(),
            300,
        );

        let affected = manager.unsubscribe_stale_callbacks(CURRENT_CALLBACK).await;

        assert_eq!(affected, vec!["192.0.2.10".to_string()]);
        // The stale one is gone, so the next reconciliation can rebuild it...
        assert!(!manager.is_subscribed("192.0.2.10", SonosService::AVTransport));
        // ...and the matching one was left alone.
        assert!(manager.is_subscribed("192.0.2.11", SonosService::AVTransport));
    }

    #[tokio::test]
    async fn an_idle_healthy_system_rebuilds_nothing() {
        // Subscriptions exist and not one NOTIFY has arrived, because nothing is
        // playing. Silence is not a defect, and nothing here reacts to it.
        let manager = manager();
        for (sid, ip) in [("uuid:1", "192.0.2.10"), ("uuid:2", "192.0.2.11")] {
            manager.store.insert(
                sid.to_string(),
                ip.to_string(),
                SonosService::AVTransport,
                CURRENT_CALLBACK.to_string(),
                300,
            );
        }

        assert!(manager
            .unsubscribe_stale_callbacks(CURRENT_CALLBACK)
            .await
            .is_empty());
        assert_eq!(manager.subscription_count(), 2);
    }

    #[tokio::test]
    async fn every_service_on_a_speaker_is_reported_once() {
        let manager = manager();
        for (sid, service) in [
            ("uuid:av", SonosService::AVTransport),
            ("uuid:grc", SonosService::GroupRenderingControl),
        ] {
            manager.store.insert(
                sid.to_string(),
                "192.0.2.10".to_string(),
                service,
                "http://10.8.0.2:8080/gena".to_string(),
                300,
            );
        }

        let affected = manager.unsubscribe_stale_callbacks(CURRENT_CALLBACK).await;

        assert_eq!(affected, vec!["192.0.2.10".to_string()]);
        assert_eq!(manager.subscription_count(), 0);
    }
}
