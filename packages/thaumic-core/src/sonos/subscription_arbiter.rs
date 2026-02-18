//! GENA subscription arbitration for RenderingControl vs GroupRenderingControl.
//!
//! Sonos speakers can only have one volume event source at a time:
//! - **GroupRenderingControl (GRC)**: Used by TopologyMonitor for group-level volume/mute.
//! - **RenderingControl (RC)**: Used during sync sessions for per-speaker volume/mute.
//!
//! Having both active causes event race conditions (both emit GroupVolume/GroupMute).
//! This module centralizes the conflict resolution that was previously scattered across
//! TopologyMonitor and StreamCoordinator with 6 defensive mechanisms.
//!
//! The arbiter maintains a `sync_ips` set that is updated BEFORE GENA operations,
//! closing TOCTOU race windows that existed when using `gena.is_subscribed()` queries.

use std::sync::Arc;

use dashmap::DashSet;

use super::gena::GenaSubscriptionManager;
use super::services::SonosService;

/// Arbitrates between RenderingControl and GroupRenderingControl subscriptions.
///
/// Ensures only one volume event source is active per speaker IP at any time.
/// Updated atomically before GENA operations to prevent race conditions.
pub struct SubscriptionArbiter {
    /// GENA subscription manager for subscribe/unsubscribe operations.
    gena: Arc<GenaSubscriptionManager>,
    /// Speaker IPs currently in active sync sessions (using RenderingControl).
    /// Updated BEFORE GENA operations to close TOCTOU race windows.
    sync_ips: DashSet<String>,
}

impl SubscriptionArbiter {
    /// Creates a new SubscriptionArbiter.
    pub fn new(gena: Arc<GenaSubscriptionManager>) -> Self {
        Self {
            gena,
            sync_ips: DashSet::new(),
        }
    }

    /// Returns whether a speaker IP is in an active sync session.
    ///
    /// Used by TopologyMonitor to decide whether to subscribe GroupRenderingControl.
    /// Reads from the `sync_ips` set (not GENA state) for consistency.
    #[must_use]
    pub fn is_in_sync_session(&self, ip: &str) -> bool {
        self.sync_ips.contains(ip)
    }

    /// Enters a sync session for the given speaker IPs.
    ///
    /// For each IP:
    /// 1. Marks as sync-active in `sync_ips` (before GENA ops)
    /// 2. Unsubscribes GroupRenderingControl
    /// 3. Subscribes RenderingControl
    /// 4. Unsubscribes GroupRenderingControl again (closes race window with TopologyMonitor)
    ///
    /// Called by StreamCoordinator when a slave joins a coordinator.
    pub async fn enter_sync_session(&self, ips: &[String], callback_url: &str) {
        log::info!(
            "[SubscriptionArbiter] Entering sync session for {} speaker(s)",
            ips.len()
        );

        // Update sync_ips BEFORE GENA operations to close race windows.
        // Any concurrent ensure_group_rendering() call will see this immediately.
        for ip in ips {
            self.sync_ips.insert(ip.clone());
        }

        // Parallelize per-IP GENA operations (per-IP sequence is preserved within each future)
        let futures: Vec<_> = ips
            .iter()
            .map(|ip| async move {
                // Unsubscribe from GRC to avoid dual subscriptions
                self.gena
                    .unsubscribe_by_ip_and_service(ip, SonosService::GroupRenderingControl)
                    .await;

                // Subscribe to RC for per-speaker volume/mute events
                if let Err(e) = self
                    .gena
                    .subscribe(
                        ip.clone(),
                        SonosService::RenderingControl,
                        callback_url.to_string(),
                    )
                    .await
                {
                    log::warn!(
                        "[SubscriptionArbiter] Failed to subscribe RenderingControl for {}: {}",
                        ip,
                        e
                    );
                    // Continue - degraded experience but functional
                } else {
                    log::info!(
                        "[SubscriptionArbiter] Subscribed to RenderingControl for {} (sync session)",
                        ip
                    );

                    // Unsubscribe from GRC again to close race window.
                    // TopologyMonitor may have re-subscribed between our initial
                    // unsubscribe and the RC subscribe completing.
                    self.gena
                        .unsubscribe_by_ip_and_service(ip, SonosService::GroupRenderingControl)
                        .await;
                }
            })
            .collect();

        futures::future::join_all(futures).await;
    }

    /// Leaves a sync session for a single speaker IP.
    ///
    /// Unsubscribes RenderingControl and immediately restores GroupRenderingControl.
    /// This eliminates the gap where neither event source is active (previously waited
    /// for TopologyMonitor's next cycle).
    ///
    /// Called by StreamCoordinator when a speaker leaves a sync group.
    pub async fn leave_sync_session(&self, ip: &str, callback_url: &str) {
        self.sync_ips.remove(ip);

        // Unsubscribe from RenderingControl
        self.gena
            .unsubscribe_by_ip_and_service(ip, SonosService::RenderingControl)
            .await;

        // Immediately restore GroupRenderingControl (speaker becomes its own coordinator
        // after leaving the sync group). This eliminates the gap where neither RC nor GRC
        // is active that existed when waiting for TopologyMonitor's next cycle.
        if let Err(e) = self
            .gena
            .subscribe(
                ip.to_string(),
                SonosService::GroupRenderingControl,
                callback_url.to_string(),
            )
            .await
        {
            log::warn!(
                "[SubscriptionArbiter] Failed to restore GroupRenderingControl for {}: {}",
                ip,
                e
            );
        } else {
            log::info!(
                "[SubscriptionArbiter] Restored GroupRenderingControl for {} (left sync session)",
                ip
            );
        }
    }

    /// Leaves sync sessions for all currently tracked speaker IPs concurrently.
    ///
    /// Called during IP changes when all subscriptions are being torn down.
    pub async fn leave_all_sync_sessions(&self, callback_url: &str) {
        let ips: Vec<String> = self.sync_ips.iter().map(|r| r.clone()).collect();

        let futures: Vec<_> = ips
            .iter()
            .map(|ip| self.leave_sync_session(ip, callback_url))
            .collect();

        futures::future::join_all(futures).await;
    }

    /// Ensures GroupRenderingControl is subscribed for a coordinator IP.
    ///
    /// Skips subscription if the speaker is in a sync session (RC is active).
    /// Proactively cleans up stale GRC subscriptions for sync-active speakers.
    ///
    /// Called by TopologyMonitor during subscription sync.
    pub async fn ensure_group_rendering(&self, ip: &str, callback_url: &str) {
        if self.sync_ips.contains(ip) {
            // Proactively clean up any stale GRC subscription
            self.gena
                .unsubscribe_by_ip_and_service(ip, SonosService::GroupRenderingControl)
                .await;
            log::debug!(
                "[SubscriptionArbiter] Skipping GroupRenderingControl for {} (sync session active)",
                ip
            );
            return;
        }

        if !self
            .gena
            .is_subscribed(ip, SonosService::GroupRenderingControl)
        {
            match self
                .gena
                .subscribe(
                    ip.to_string(),
                    SonosService::GroupRenderingControl,
                    callback_url.to_string(),
                )
                .await
            {
                Ok(()) => {
                    log::info!(
                        "[SubscriptionArbiter] Subscribed to GroupRenderingControl on {}",
                        ip
                    );
                }
                Err(e) => {
                    log::error!(
                        "[SubscriptionArbiter] Failed to subscribe to GroupRenderingControl on {}: {}",
                        ip,
                        e
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Creates a test arbiter with a real (but unused) GenaSubscriptionManager.
    ///
    /// Uses a 1ms timeout so GENA subscribe attempts against nonexistent
    /// speakers fail immediately instead of blocking on TCP SYN retries (~30s).
    fn create_test_arbiter() -> SubscriptionArbiter {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(1))
            .build()
            .unwrap();
        let (gena_manager, _rx) = GenaSubscriptionManager::new(client);
        SubscriptionArbiter::new(Arc::new(gena_manager))
    }

    #[test]
    fn is_in_sync_session_returns_false_for_unknown() {
        let arbiter = create_test_arbiter();
        assert!(!arbiter.is_in_sync_session("192.168.1.100"));
    }

    #[tokio::test]
    async fn enter_marks_ips_as_sync() {
        let arbiter = create_test_arbiter();
        let ips = vec!["192.168.1.100".to_string(), "192.168.1.101".to_string()];

        // enter_sync_session will fail the actual GENA subscribe (no real speaker),
        // but sync_ips should still be updated
        arbiter
            .enter_sync_session(&ips, "http://localhost:1400/notify")
            .await;

        assert!(arbiter.is_in_sync_session("192.168.1.100"));
        assert!(arbiter.is_in_sync_session("192.168.1.101"));
        assert!(!arbiter.is_in_sync_session("192.168.1.102"));
    }

    #[tokio::test]
    async fn leave_removes_ip_from_sync() {
        let arbiter = create_test_arbiter();
        let ips = vec!["192.168.1.100".to_string()];
        arbiter
            .enter_sync_session(&ips, "http://localhost:1400/notify")
            .await;

        assert!(arbiter.is_in_sync_session("192.168.1.100"));

        arbiter
            .leave_sync_session("192.168.1.100", "http://localhost:1400/notify")
            .await;

        assert!(!arbiter.is_in_sync_session("192.168.1.100"));
    }

    #[tokio::test]
    async fn leave_all_clears_sync_ips() {
        let arbiter = create_test_arbiter();
        let ips = vec![
            "192.168.1.100".to_string(),
            "192.168.1.101".to_string(),
            "192.168.1.102".to_string(),
        ];
        arbiter
            .enter_sync_session(&ips, "http://localhost:1400/notify")
            .await;

        assert!(arbiter.is_in_sync_session("192.168.1.100"));
        assert!(arbiter.is_in_sync_session("192.168.1.101"));
        assert!(arbiter.is_in_sync_session("192.168.1.102"));

        arbiter
            .leave_all_sync_sessions("http://localhost:1400/notify")
            .await;

        assert!(!arbiter.is_in_sync_session("192.168.1.100"));
        assert!(!arbiter.is_in_sync_session("192.168.1.101"));
        assert!(!arbiter.is_in_sync_session("192.168.1.102"));
    }

    #[tokio::test]
    async fn ensure_skips_when_sync_active() {
        let arbiter = create_test_arbiter();
        let ips = vec!["192.168.1.100".to_string()];
        arbiter
            .enter_sync_session(&ips, "http://localhost:1400/notify")
            .await;

        // ensure_group_rendering should skip because the IP is in sync
        // (no assertion on GRC state since we can't reach a real speaker,
        // but we verify it doesn't panic and sync state is preserved)
        arbiter
            .ensure_group_rendering("192.168.1.100", "http://localhost:1400/notify")
            .await;

        assert!(arbiter.is_in_sync_session("192.168.1.100"));
    }
}
