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

use crate::config::{GENA_RENEWAL_BUFFER_SECS, GENA_RENEWAL_CHECK_SECS};
use crate::error::GenaResult;

use super::gena_client::GenaClient;
use super::gena_event_builder;
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
    /// Event sender for emitting SonosEvents (always available).
    event_tx: mpsc::UnboundedSender<SonosEvent>,
    /// Token to signal background tasks to stop.
    cancel_token: CancellationToken,
}

impl GenaSubscriptionManager {
    /// Creates a new GenaSubscriptionManager instance along with an event receiver.
    ///
    /// The returned receiver will receive all GENA events (subscription lost, etc.).
    /// The channel is unbounded to prevent blocking the GENA notification handler.
    ///
    /// # Arguments
    /// * `http_client` - The HTTP client to use for GENA requests
    pub fn new(http_client: Client) -> (Self, mpsc::UnboundedReceiver<SonosEvent>) {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
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
    fn emit_subscription_lost(&self, speaker_ip: String, service: SonosService, reason: String) {
        let event = SonosEvent::SubscriptionLost {
            speaker_ip,
            service,
            reason,
        };
        if let Err(e) = self.event_tx.send(event) {
            log::error!("[GENA] Failed to emit SubscriptionLost event: {}", e);
        }
    }

    /// Starts a background task to renew subscriptions before they expire.
    ///
    /// The task will stop gracefully when the cancellation token is triggered.
    pub fn start_renewal_task(self: Arc<Self>) {
        let cancel_token = self.cancel_token.clone();
        tauri::async_runtime::spawn(async move {
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

    /// Unsubscribes from all active subscriptions.
    pub async fn unsubscribe_all(&self) {
        let sids = self.store.get_all_sids();

        for sid in sids {
            if let Err(e) = self.unsubscribe(&sid).await {
                log::error!("[GENA] Failed to unsubscribe {}: {}", sid, e);
            }
        }
    }

    /// Stops background tasks and unsubscribes from all active subscriptions (for graceful shutdown).
    pub async fn shutdown(&self) {
        log::info!("[GENA] Initiating shutdown");
        self.cancel_token.cancel();
        self.unsubscribe_all().await;
    }

    /// Handles an incoming NOTIFY request and returns parsed events.
    ///
    /// # Arguments
    /// * `sid` - The subscription ID from the NOTIFY request
    /// * `body` - The XML body of the NOTIFY request
    /// * `get_expected_stream` - Optional callback to get the expected stream URL for source change detection.
    ///   If None, source change detection is skipped.
    pub fn handle_notify<F>(
        &self,
        sid: &str,
        body: &str,
        get_expected_stream: Option<F>,
    ) -> Vec<SonosEvent>
    where
        F: Fn(&str) -> Option<String>,
    {
        let Some((ip, service)) = self.store.get(sid) else {
            // Unknown SID could indicate:
            // - Race condition (subscription was just removed)
            // - Stale notification from speaker after unsubscribe
            // - Misconfigured speaker or network issue
            // - Potential replay attack (security concern for UPnP)
            log::warn!(
                "[GENA] Received NOTIFY for unknown SID: {} (body size: {} bytes)",
                sid,
                body.len()
            );
            return vec![];
        };

        match service {
            SonosService::AVTransport => {
                gena_event_builder::build_av_transport_events(&ip, body, get_expected_stream)
            }
            SonosService::GroupRenderingControl => {
                gena_event_builder::build_group_rendering_events(&ip, body)
            }
            SonosService::ZoneGroupTopology => gena_event_builder::build_zone_topology_events(body),
        }
    }

    /// Returns the number of active subscriptions.
    #[must_use]
    pub fn subscription_count(&self) -> usize {
        self.store.len()
    }
}
