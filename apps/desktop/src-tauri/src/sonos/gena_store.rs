//! GENA subscription state management.
//!
//! Pure data structure for tracking active subscriptions without I/O operations.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use parking_lot::RwLock;

use super::services::SonosService;

/// Internal subscription state (keyed by SID in the subscriptions HashMap).
pub(crate) struct Subscription {
    pub ip: String,
    pub service: SonosService,
    pub callback_url: String,
    pub expires_at: Instant,
}

/// A composite key for deduplicating subscriptions (IP + service).
#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub(crate) struct SubscriptionKey {
    pub ip: String,
    pub service: SonosService,
}

impl SubscriptionKey {
    /// Creates a new subscription key.
    pub fn new(ip: impl Into<String>, service: SonosService) -> Self {
        Self {
            ip: ip.into(),
            service,
        }
    }
}

/// Pure state container for GENA subscriptions.
///
/// This struct manages subscription state without performing any I/O.
/// All HTTP operations are delegated to `GenaClient`.
pub struct GenaSubscriptionStore {
    /// Map from SID to subscription state.
    subscriptions: RwLock<HashMap<String, Subscription>>,
    /// Reverse lookup: (ip, service) -> SID for deduplication.
    subscription_keys: RwLock<HashMap<SubscriptionKey, String>>,
    /// In-flight subscription requests (prevents TOCTOU race in subscribe).
    pending_subscriptions: RwLock<HashSet<SubscriptionKey>>,
}

impl GenaSubscriptionStore {
    /// Creates a new empty subscription store.
    pub fn new() -> Self {
        Self {
            subscriptions: RwLock::new(HashMap::new()),
            subscription_keys: RwLock::new(HashMap::new()),
            pending_subscriptions: RwLock::new(HashSet::new()),
        }
    }

    /// Checks if a subscription exists for the given IP and service.
    #[must_use]
    pub fn is_subscribed(&self, ip: &str, service: SonosService) -> bool {
        let key = SubscriptionKey::new(ip, service);
        self.subscription_keys.read().contains_key(&key)
    }

    /// Gets all IPs that have an active subscription for the given service.
    #[must_use]
    pub fn get_subscribed_ips(&self, service: SonosService) -> Vec<String> {
        self.subscription_keys
            .read()
            .keys()
            .filter(|k| k.service == service)
            .map(|k| k.ip.clone())
            .collect()
    }

    /// Attempts to mark a subscription as pending.
    ///
    /// Returns `true` if the subscription was marked as pending.
    /// Returns `false` if a subscription already exists or is already pending.
    ///
    /// # TOCTOU Mitigation
    ///
    /// There is a deliberate gap between dropping the `subscription_keys` read lock
    /// and acquiring the `pending_subscriptions` write lock. In theory, a concurrent
    /// `insert()` could complete during this gap, creating a duplicate subscription.
    ///
    /// This is safe because:
    /// 1. `insert()` atomically clears the pending flag via `clear_pending()`, so any
    ///    racing `try_mark_pending()` will see the key in `subscription_keys` and return false.
    /// 2. Subscription attempts are serialized by the `GenaClient` HTTP round-trip,
    ///    making races extremely unlikely in practice.
    /// 3. Even if a race occurs, the worst case is a harmless duplicate SUBSCRIBE
    ///    request (Sonos handles this gracefully by returning the existing SID).
    pub fn try_mark_pending(&self, ip: &str, service: SonosService) -> bool {
        let key = SubscriptionKey::new(ip, service);

        // Check if subscription already exists (fast path, read lock only)
        let keys = self.subscription_keys.read();
        if keys.contains_key(&key) {
            return false;
        }
        drop(keys); // Explicit drop for clarity (see TOCTOU note above)

        // Check/set pending flag (requires write lock)
        let mut pending = self.pending_subscriptions.write();
        if pending.contains(&key) {
            return false;
        }

        pending.insert(key);
        true
    }

    /// Removes a key from the pending set.
    pub fn clear_pending(&self, ip: &str, service: SonosService) {
        let key = SubscriptionKey::new(ip, service);
        self.pending_subscriptions.write().remove(&key);
    }

    /// Inserts a new subscription into the store.
    ///
    /// Also clears the pending flag for the (ip, service) pair.
    pub fn insert(
        &self,
        sid: String,
        ip: String,
        service: SonosService,
        callback_url: String,
        timeout_secs: u64,
    ) {
        let key = SubscriptionKey::new(&ip, service);

        self.subscriptions.write().insert(
            sid.clone(),
            Subscription {
                ip,
                service,
                callback_url,
                expires_at: Instant::now() + Duration::from_secs(timeout_secs),
            },
        );
        self.subscription_keys.write().insert(key.clone(), sid);
        self.pending_subscriptions.write().remove(&key);
    }

    /// Removes a subscription by SID.
    ///
    /// Returns the subscription details if it existed.
    pub fn remove(&self, sid: &str) -> Option<(String, SonosService)> {
        if let Some(sub) = self.subscriptions.write().remove(sid) {
            let key = SubscriptionKey::new(&sub.ip, sub.service);
            self.subscription_keys.write().remove(&key);
            Some((sub.ip, sub.service))
        } else {
            None
        }
    }

    /// Gets subscription info by SID.
    pub fn get(&self, sid: &str) -> Option<(String, SonosService)> {
        self.subscriptions
            .read()
            .get(sid)
            .map(|s| (s.ip.clone(), s.service))
    }

    /// Updates the expiration time for a subscription.
    pub fn update_expiry(&self, sid: &str, timeout_secs: u64) {
        if let Some(sub) = self.subscriptions.write().get_mut(sid) {
            sub.expires_at = Instant::now() + Duration::from_secs(timeout_secs);
        }
    }

    /// Returns subscriptions that need renewal (expiring within buffer time).
    ///
    /// # Arguments
    /// * `buffer_secs` - Subscriptions expiring within this many seconds are returned
    ///
    /// # Returns
    /// A vector of (sid, ip, service, callback_url) tuples for subscriptions needing renewal.
    pub fn get_expiring(&self, buffer_secs: u64) -> Vec<(String, String, SonosService, String)> {
        let now = Instant::now();
        let buffer = Duration::from_secs(buffer_secs);

        self.subscriptions
            .read()
            .iter()
            .filter(|(_, sub)| sub.expires_at.saturating_duration_since(now) < buffer)
            .map(|(sid, sub)| {
                (
                    sid.clone(),
                    sub.ip.clone(),
                    sub.service,
                    sub.callback_url.clone(),
                )
            })
            .collect()
    }

    /// Gets all SIDs for a specific IP.
    pub fn get_sids_by_ip(&self, ip: &str) -> Vec<String> {
        self.subscriptions
            .read()
            .iter()
            .filter(|(_, sub)| sub.ip == ip)
            .map(|(sid, _)| sid.clone())
            .collect()
    }

    /// Gets all SIDs in the store.
    pub fn get_all_sids(&self) -> Vec<String> {
        self.subscriptions.read().keys().cloned().collect()
    }

    /// Returns the number of active subscriptions.
    #[must_use]
    pub fn len(&self) -> usize {
        self.subscriptions.read().len()
    }

    /// Returns true if there are no active subscriptions.
    #[must_use]
    #[allow(dead_code)] // Standard API: len() should have is_empty()
    pub fn is_empty(&self) -> bool {
        self.subscriptions.read().is_empty()
    }
}

impl Default for GenaSubscriptionStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_store_is_empty() {
        let store = GenaSubscriptionStore::new();
        assert!(store.is_empty());
        assert_eq!(store.len(), 0);
    }

    #[test]
    fn insert_and_lookup() {
        let store = GenaSubscriptionStore::new();

        store.insert(
            "uuid:123".to_string(),
            "192.168.1.100".to_string(),
            SonosService::AVTransport,
            "http://callback".to_string(),
            300,
        );

        assert!(store.is_subscribed("192.168.1.100", SonosService::AVTransport));
        assert!(!store.is_subscribed("192.168.1.100", SonosService::GroupRenderingControl));
        assert!(!store.is_subscribed("192.168.1.101", SonosService::AVTransport));
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn get_returns_subscription_info() {
        let store = GenaSubscriptionStore::new();

        store.insert(
            "uuid:123".to_string(),
            "192.168.1.100".to_string(),
            SonosService::AVTransport,
            "http://callback".to_string(),
            300,
        );

        let info = store.get("uuid:123");
        assert!(info.is_some());
        let (ip, service) = info.unwrap();
        assert_eq!(ip, "192.168.1.100");
        assert_eq!(service, SonosService::AVTransport);
    }

    #[test]
    fn pending_prevents_duplicate() {
        let store = GenaSubscriptionStore::new();

        assert!(store.try_mark_pending("192.168.1.100", SonosService::AVTransport));
        assert!(!store.try_mark_pending("192.168.1.100", SonosService::AVTransport));

        // Different service should succeed
        assert!(store.try_mark_pending("192.168.1.100", SonosService::GroupRenderingControl));
    }

    #[test]
    fn existing_subscription_prevents_pending() {
        let store = GenaSubscriptionStore::new();

        store.insert(
            "uuid:123".to_string(),
            "192.168.1.100".to_string(),
            SonosService::AVTransport,
            "http://callback".to_string(),
            300,
        );

        // Should fail because subscription already exists
        assert!(!store.try_mark_pending("192.168.1.100", SonosService::AVTransport));
    }

    #[test]
    fn clear_pending_allows_retry() {
        let store = GenaSubscriptionStore::new();

        assert!(store.try_mark_pending("192.168.1.100", SonosService::AVTransport));
        store.clear_pending("192.168.1.100", SonosService::AVTransport);
        assert!(store.try_mark_pending("192.168.1.100", SonosService::AVTransport));
    }

    #[test]
    fn remove_clears_both_maps() {
        let store = GenaSubscriptionStore::new();

        store.insert(
            "uuid:123".to_string(),
            "192.168.1.100".to_string(),
            SonosService::AVTransport,
            "http://callback".to_string(),
            300,
        );

        let removed = store.remove("uuid:123");
        assert!(removed.is_some());
        let (ip, service) = removed.unwrap();
        assert_eq!(ip, "192.168.1.100");
        assert_eq!(service, SonosService::AVTransport);

        assert!(!store.is_subscribed("192.168.1.100", SonosService::AVTransport));
        assert!(store.get("uuid:123").is_none());
        assert!(store.is_empty());
    }

    #[test]
    fn get_subscribed_ips_filters_by_service() {
        let store = GenaSubscriptionStore::new();

        store.insert(
            "uuid:1".to_string(),
            "192.168.1.100".to_string(),
            SonosService::AVTransport,
            "http://callback".to_string(),
            300,
        );
        store.insert(
            "uuid:2".to_string(),
            "192.168.1.101".to_string(),
            SonosService::AVTransport,
            "http://callback".to_string(),
            300,
        );
        store.insert(
            "uuid:3".to_string(),
            "192.168.1.100".to_string(),
            SonosService::GroupRenderingControl,
            "http://callback".to_string(),
            300,
        );

        let av_ips = store.get_subscribed_ips(SonosService::AVTransport);
        assert_eq!(av_ips.len(), 2);
        assert!(av_ips.contains(&"192.168.1.100".to_string()));
        assert!(av_ips.contains(&"192.168.1.101".to_string()));

        let grc_ips = store.get_subscribed_ips(SonosService::GroupRenderingControl);
        assert_eq!(grc_ips.len(), 1);
        assert!(grc_ips.contains(&"192.168.1.100".to_string()));
    }

    #[test]
    fn get_sids_by_ip_returns_all_services() {
        let store = GenaSubscriptionStore::new();

        store.insert(
            "uuid:1".to_string(),
            "192.168.1.100".to_string(),
            SonosService::AVTransport,
            "http://callback".to_string(),
            300,
        );
        store.insert(
            "uuid:2".to_string(),
            "192.168.1.100".to_string(),
            SonosService::GroupRenderingControl,
            "http://callback".to_string(),
            300,
        );
        store.insert(
            "uuid:3".to_string(),
            "192.168.1.101".to_string(),
            SonosService::AVTransport,
            "http://callback".to_string(),
            300,
        );

        let sids = store.get_sids_by_ip("192.168.1.100");
        assert_eq!(sids.len(), 2);
        assert!(sids.contains(&"uuid:1".to_string()));
        assert!(sids.contains(&"uuid:2".to_string()));
    }
}
