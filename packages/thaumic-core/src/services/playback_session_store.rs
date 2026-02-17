//! Playback session storage with indexed lookups.
//!
//! Provides O(1) session lookups by (stream_id, speaker_ip) composite key
//! and by speaker_ip alone via a secondary index.

use dashmap::DashMap;

use crate::stream::AudioCodec;

/// Composite key for playback sessions: (stream_id, speaker_ip).
/// Allows multiple speakers to receive the same stream (multi-group casting).
#[derive(Debug, Clone, Hash, Eq, PartialEq)]
pub(crate) struct PlaybackSessionKey {
    pub stream_id: String,
    pub speaker_ip: String,
}

impl PlaybackSessionKey {
    pub fn new(stream_id: &str, speaker_ip: &str) -> Self {
        Self {
            stream_id: stream_id.to_string(),
            speaker_ip: speaker_ip.to_string(),
        }
    }
}

/// Role of a speaker in synchronized group playback.
///
/// When multiple speakers play the same stream, one becomes the coordinator
/// (receives actual stream URL) and others become slaves (sync to coordinator
/// via x-rincon protocol).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupRole {
    /// Coordinator receives the actual stream URL and controls playback timing.
    /// All slaves sync their playback to the coordinator.
    #[default]
    Coordinator,
    /// Slave joins the coordinator via x-rincon protocol for synchronized playback.
    /// Does not fetch the stream directly - follows coordinator's timing.
    Slave,
}

/// Tracks an active playback session linking a stream to a speaker.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSession {
    /// The stream ID being played.
    pub stream_id: String,
    /// The speaker IP address receiving the stream.
    pub speaker_ip: String,
    /// The full URL the speaker is fetching audio from.
    /// For coordinators: the actual stream URL.
    /// For slaves: the x-rincon:{uuid} URI.
    pub stream_url: String,
    /// The codec being used (for Sonos URI formatting).
    pub codec: AudioCodec,
    /// Role in synchronized group playback.
    pub role: GroupRole,
    /// For slaves: the coordinator's IP address.
    /// For coordinators: None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coordinator_ip: Option<String>,
    /// The coordinator's UUID (for cleanup operations).
    /// Set for both coordinators (self UUID) and slaves (coordinator UUID).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coordinator_uuid: Option<String>,
    /// Original group coordinator UUID before joining the streaming group.
    /// For slaves: the UUID of the coordinator they were grouped with before streaming.
    /// None if the speaker was already standalone or is a coordinator.
    /// Used to restore group membership after streaming ends.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_coordinator_uuid: Option<String>,
}

/// Result of starting playback on a single speaker.
/// Used for reporting per-speaker success/failure in multi-group casting.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackResult {
    /// IP address of the speaker.
    pub speaker_ip: String,
    /// Whether playback started successfully.
    pub success: bool,
    /// Stream URL the speaker is fetching (on success).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_url: Option<String>,
    /// Error message (on failure).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Indexed storage for playback sessions.
///
/// Provides O(1) lookups by composite key (stream_id, speaker_ip) and by
/// speaker_ip alone via a secondary index. The secondary index eliminates
/// linear scans that were previously needed to find sessions by IP.
pub(crate) struct PlaybackSessionStore {
    /// Primary: (stream_id, speaker_ip) -> PlaybackSession
    sessions: DashMap<PlaybackSessionKey, PlaybackSession>,
    /// Secondary: speaker_ip -> PlaybackSessionKey (O(1) lookup)
    ip_index: DashMap<String, PlaybackSessionKey>,
}

impl PlaybackSessionStore {
    /// Creates a new empty store.
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
            ip_index: DashMap::new(),
        }
    }

    /// Inserts a playback session.
    ///
    /// Maintains the ip_index. If a session with the same key already existed,
    /// returns the old session.
    pub fn insert(&self, session: PlaybackSession) -> Option<PlaybackSession> {
        let key = PlaybackSessionKey::new(&session.stream_id, &session.speaker_ip);
        self.ip_index
            .insert(session.speaker_ip.clone(), key.clone());
        self.sessions.insert(key, session)
    }

    /// Removes a session by (stream_id, speaker_ip).
    ///
    /// Returns the removed session if it existed. Only removes the ip_index
    /// entry if the index points to this exact key (avoids removing a newer
    /// session's index entry).
    pub fn remove(&self, stream_id: &str, speaker_ip: &str) -> Option<PlaybackSession> {
        let key = PlaybackSessionKey::new(stream_id, speaker_ip);
        let removed = self.sessions.remove(&key).map(|(_, v)| v);
        if removed.is_some() {
            // Only remove ip_index if it still points to this key
            self.ip_index
                .remove_if(speaker_ip, |_, stored_key| *stored_key == key);
        }
        removed
    }

    /// Gets a session by (stream_id, speaker_ip).
    pub fn get(&self, stream_id: &str, speaker_ip: &str) -> Option<PlaybackSession> {
        let key = PlaybackSessionKey::new(stream_id, speaker_ip);
        self.sessions.get(&key).map(|r| r.value().clone())
    }

    /// Gets a session by speaker IP using the secondary index (O(1)).
    pub fn get_by_speaker_ip(&self, speaker_ip: &str) -> Option<PlaybackSession> {
        let key = self.ip_index.get(speaker_ip)?;
        self.sessions.get(key.value()).map(|r| r.value().clone())
    }

    /// Gets the session key for a speaker IP using the secondary index (O(1)).
    pub fn get_key_by_speaker_ip(&self, speaker_ip: &str) -> Option<PlaybackSessionKey> {
        self.ip_index.get(speaker_ip).map(|r| r.value().clone())
    }

    /// Gets all sessions for a specific stream.
    pub fn get_all_for_stream(&self, stream_id: &str) -> Vec<PlaybackSession> {
        self.sessions
            .iter()
            .filter(|r| r.key().stream_id == stream_id)
            .map(|r| r.value().clone())
            .collect()
    }

    /// Gets all speaker IPs for a specific stream.
    pub fn get_ips_for_stream(&self, stream_id: &str) -> Vec<String> {
        self.sessions
            .iter()
            .filter(|r| r.key().stream_id == stream_id)
            .map(|r| r.key().speaker_ip.clone())
            .collect()
    }

    /// Removes all sessions for a stream, returning the removed sessions.
    pub fn remove_all_for_stream(&self, stream_id: &str) -> Vec<PlaybackSession> {
        let keys: Vec<PlaybackSessionKey> = self
            .sessions
            .iter()
            .filter(|r| r.key().stream_id == stream_id)
            .map(|r| r.key().clone())
            .collect();

        let mut removed = Vec::with_capacity(keys.len());
        for key in keys {
            if let Some((_, session)) = self.sessions.remove(&key) {
                self.ip_index
                    .remove_if(&key.speaker_ip, |_, stored_key| *stored_key == key);
                removed.push(session);
            }
        }
        removed
    }

    /// Checks if any sessions exist for a stream.
    pub fn has_sessions_for_stream(&self, stream_id: &str) -> bool {
        self.sessions.iter().any(|r| r.key().stream_id == stream_id)
    }

    /// Checks if a speaker is in a sync session.
    ///
    /// Returns `Some(true)` if the speaker is in a session with slaves,
    /// `Some(false)` if in a session with no slaves, `None` if not in any session.
    pub fn is_in_sync_session(&self, speaker_ip: &str) -> Option<bool> {
        let key = self.ip_index.get(speaker_ip)?;
        let stream_id = &key.value().stream_id;
        let has_slaves = self
            .sessions
            .iter()
            .any(|r| r.key().stream_id == *stream_id && r.value().role == GroupRole::Slave);
        Some(has_slaves)
    }

    /// Gets all slaves joined to a specific coordinator for a stream.
    pub fn get_slaves_for_coordinator(
        &self,
        stream_id: &str,
        coordinator_ip: &str,
    ) -> Vec<(PlaybackSessionKey, PlaybackSession)> {
        self.sessions
            .iter()
            .filter(|r| {
                r.key().stream_id == stream_id
                    && r.value().role == GroupRole::Slave
                    && r.value().coordinator_ip.as_deref() == Some(coordinator_ip)
            })
            .map(|r| (r.key().clone(), r.value().clone()))
            .collect()
    }

    /// Checks if any slaves exist for a stream.
    pub fn has_slaves_for_stream(&self, stream_id: &str) -> bool {
        self.sessions
            .iter()
            .any(|r| r.key().stream_id == stream_id && r.value().role == GroupRole::Slave)
    }

    /// Finds the coordinator IP for a stream.
    pub fn find_coordinator_ip_for_stream(&self, stream_id: &str) -> Option<String> {
        self.sessions
            .iter()
            .find(|r| r.key().stream_id == stream_id && r.value().role == GroupRole::Coordinator)
            .map(|r| r.key().speaker_ip.clone())
    }

    /// Gets all sessions across all streams.
    pub fn all_sessions(&self) -> Vec<PlaybackSession> {
        self.sessions.iter().map(|r| r.value().clone()).collect()
    }

    /// Finds a session for a speaker on a different stream than the given one.
    pub fn find_other_stream(
        &self,
        speaker_ip: &str,
        not_stream_id: &str,
    ) -> Option<(PlaybackSessionKey, PlaybackSession)> {
        // Use ip_index for O(1) lookup, then check if it's a different stream
        let key = self.ip_index.get(speaker_ip)?;
        if key.value().stream_id != not_stream_id {
            let session = self.sessions.get(key.value())?.value().clone();
            Some((key.value().clone(), session))
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─────────────────────────────────────────────────────────────────────────
    // GroupRole Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn group_role_default_is_coordinator() {
        assert_eq!(GroupRole::default(), GroupRole::Coordinator);
    }

    #[test]
    fn group_role_equality() {
        assert_eq!(GroupRole::Coordinator, GroupRole::Coordinator);
        assert_eq!(GroupRole::Slave, GroupRole::Slave);
        assert_ne!(GroupRole::Coordinator, GroupRole::Slave);
    }

    #[test]
    fn group_role_serializes_to_snake_case() {
        assert_eq!(
            serde_json::to_string(&GroupRole::Coordinator).unwrap(),
            "\"coordinator\""
        );
        assert_eq!(
            serde_json::to_string(&GroupRole::Slave).unwrap(),
            "\"slave\""
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PlaybackSessionKey Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn playback_session_key_equality() {
        let key1 = PlaybackSessionKey::new("stream1", "192.168.1.100");
        let key2 = PlaybackSessionKey::new("stream1", "192.168.1.100");
        let key3 = PlaybackSessionKey::new("stream1", "192.168.1.101");
        let key4 = PlaybackSessionKey::new("stream2", "192.168.1.100");

        assert_eq!(key1, key2);
        assert_ne!(key1, key3); // different speaker
        assert_ne!(key1, key4); // different stream
    }

    #[test]
    fn playback_session_key_hash_consistent() {
        use std::collections::HashMap;

        let mut map = HashMap::new();
        let key1 = PlaybackSessionKey::new("stream1", "192.168.1.100");
        map.insert(key1.clone(), "value1");

        let key2 = PlaybackSessionKey::new("stream1", "192.168.1.100");
        assert_eq!(map.get(&key2), Some(&"value1"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PlaybackSession Tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn playback_session_coordinator_has_no_coordinator_ip() {
        let session = PlaybackSession {
            stream_id: "stream1".to_string(),
            speaker_ip: "192.168.1.100".to_string(),
            stream_url: "http://server:8080/stream/abc".to_string(),
            codec: AudioCodec::Aac,
            role: GroupRole::Coordinator,
            coordinator_ip: None,
            coordinator_uuid: Some("RINCON_XXX".to_string()),
            original_coordinator_uuid: None,
        };

        assert_eq!(session.role, GroupRole::Coordinator);
        assert!(session.coordinator_ip.is_none());
        assert!(session.original_coordinator_uuid.is_none());
    }

    #[test]
    fn playback_session_slave_has_coordinator_info() {
        let session = PlaybackSession {
            stream_id: "stream1".to_string(),
            speaker_ip: "192.168.1.101".to_string(),
            stream_url: "x-rincon:RINCON_XXX".to_string(),
            codec: AudioCodec::Aac,
            role: GroupRole::Slave,
            coordinator_ip: Some("192.168.1.100".to_string()),
            coordinator_uuid: Some("RINCON_XXX".to_string()),
            original_coordinator_uuid: None,
        };

        assert_eq!(session.role, GroupRole::Slave);
        assert_eq!(session.coordinator_ip, Some("192.168.1.100".to_string()));
        assert!(session.stream_url.starts_with("x-rincon:"));
    }

    #[test]
    fn playback_session_slave_stores_original_coordinator() {
        let session = PlaybackSession {
            stream_id: "stream1".to_string(),
            speaker_ip: "192.168.1.101".to_string(),
            stream_url: "x-rincon:RINCON_STREAMING".to_string(),
            codec: AudioCodec::Aac,
            role: GroupRole::Slave,
            coordinator_ip: Some("192.168.1.100".to_string()),
            coordinator_uuid: Some("RINCON_STREAMING".to_string()),
            original_coordinator_uuid: Some("RINCON_ORIGINAL".to_string()),
        };

        assert_eq!(session.role, GroupRole::Slave);
        assert_eq!(
            session.original_coordinator_uuid,
            Some("RINCON_ORIGINAL".to_string())
        );
    }

    #[test]
    fn playback_session_coordinator_can_have_original_group() {
        let session = PlaybackSession {
            stream_id: "stream1".to_string(),
            speaker_ip: "192.168.1.101".to_string(),
            stream_url: "http://server:8080/stream/abc".to_string(),
            codec: AudioCodec::Aac,
            role: GroupRole::Coordinator,
            coordinator_ip: None,
            coordinator_uuid: Some("RINCON_KITCHEN".to_string()),
            original_coordinator_uuid: Some("RINCON_LIVING".to_string()),
        };

        assert_eq!(session.role, GroupRole::Coordinator);
        assert_eq!(
            session.original_coordinator_uuid,
            Some("RINCON_LIVING".to_string())
        );
    }

    #[test]
    fn playback_session_serializes_correctly() {
        let session = PlaybackSession {
            stream_id: "stream1".to_string(),
            speaker_ip: "192.168.1.100".to_string(),
            stream_url: "http://server:8080/stream".to_string(),
            codec: AudioCodec::Aac,
            role: GroupRole::Coordinator,
            coordinator_ip: None,
            coordinator_uuid: Some("RINCON_XXX".to_string()),
            original_coordinator_uuid: None,
        };

        let json = serde_json::to_value(&session).unwrap();
        assert_eq!(json["role"], "coordinator");
        assert_eq!(json["streamId"], "stream1");
        assert_eq!(json["speakerIp"], "192.168.1.100");
        assert!(json.get("coordinatorIp").is_none());
        assert!(json.get("originalCoordinatorUuid").is_none());
    }

    #[test]
    fn playback_session_slave_serializes_with_coordinator_ip() {
        let session = PlaybackSession {
            stream_id: "stream1".to_string(),
            speaker_ip: "192.168.1.101".to_string(),
            stream_url: "x-rincon:RINCON_XXX".to_string(),
            codec: AudioCodec::Aac,
            role: GroupRole::Slave,
            coordinator_ip: Some("192.168.1.100".to_string()),
            coordinator_uuid: Some("RINCON_XXX".to_string()),
            original_coordinator_uuid: Some("RINCON_ORIGINAL".to_string()),
        };

        let json = serde_json::to_value(&session).unwrap();
        assert_eq!(json["role"], "slave");
        assert_eq!(json["coordinatorIp"], "192.168.1.100");
        assert_eq!(json["originalCoordinatorUuid"], "RINCON_ORIGINAL");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PlaybackSessionStore Tests
    // ─────────────────────────────────────────────────────────────────────────

    fn make_session(stream_id: &str, speaker_ip: &str, role: GroupRole) -> PlaybackSession {
        PlaybackSession {
            stream_id: stream_id.to_string(),
            speaker_ip: speaker_ip.to_string(),
            stream_url: match role {
                GroupRole::Coordinator => "http://server/stream".to_string(),
                GroupRole::Slave => "x-rincon:RINCON_100".to_string(),
            },
            codec: AudioCodec::Aac,
            role,
            coordinator_ip: match role {
                GroupRole::Coordinator => None,
                GroupRole::Slave => Some("192.168.1.100".to_string()),
            },
            coordinator_uuid: Some("RINCON_100".to_string()),
            original_coordinator_uuid: None,
        }
    }

    #[test]
    fn insert_and_get_by_key() {
        let store = PlaybackSessionStore::new();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));

        let session = store.get("s1", "192.168.1.100").unwrap();
        assert_eq!(session.stream_id, "s1");
        assert_eq!(session.speaker_ip, "192.168.1.100");
    }

    #[test]
    fn get_by_speaker_ip_uses_index() {
        let store = PlaybackSessionStore::new();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));

        let session = store.get_by_speaker_ip("192.168.1.100").unwrap();
        assert_eq!(session.stream_id, "s1");
    }

    #[test]
    fn get_by_speaker_ip_returns_none_for_unknown() {
        let store = PlaybackSessionStore::new();
        assert!(store.get_by_speaker_ip("192.168.1.200").is_none());
    }

    #[test]
    fn remove_clears_index() {
        let store = PlaybackSessionStore::new();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));

        let removed = store.remove("s1", "192.168.1.100");
        assert!(removed.is_some());
        assert!(store.get_by_speaker_ip("192.168.1.100").is_none());
        assert!(store.get("s1", "192.168.1.100").is_none());
    }

    #[test]
    fn insert_displacement_returns_old_session() {
        let store = PlaybackSessionStore::new();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));

        let old = store.insert(make_session("s1", "192.168.1.100", GroupRole::Slave));
        assert!(old.is_some());
        assert_eq!(old.unwrap().role, GroupRole::Coordinator);

        // New session should be retrievable
        let session = store.get("s1", "192.168.1.100").unwrap();
        assert_eq!(session.role, GroupRole::Slave);
    }

    #[test]
    fn remove_all_for_stream() {
        let store = PlaybackSessionStore::new();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));
        store.insert(make_session("s1", "192.168.1.101", GroupRole::Slave));
        store.insert(make_session("s2", "192.168.1.102", GroupRole::Coordinator));

        let removed = store.remove_all_for_stream("s1");
        assert_eq!(removed.len(), 2);

        // s1 sessions gone
        assert!(store.get_by_speaker_ip("192.168.1.100").is_none());
        assert!(store.get_by_speaker_ip("192.168.1.101").is_none());

        // s2 session still exists
        assert!(store.get_by_speaker_ip("192.168.1.102").is_some());
    }

    #[test]
    fn has_sessions_for_stream() {
        let store = PlaybackSessionStore::new();
        assert!(!store.has_sessions_for_stream("s1"));

        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));
        assert!(store.has_sessions_for_stream("s1"));
        assert!(!store.has_sessions_for_stream("s2"));
    }

    #[test]
    fn sync_detection_returns_none_for_unknown_speaker() {
        let store = PlaybackSessionStore::new();
        assert_eq!(store.is_in_sync_session("192.168.1.100"), None);
    }

    #[test]
    fn sync_detection_returns_false_for_solo_coordinator() {
        let store = PlaybackSessionStore::new();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));
        assert_eq!(store.is_in_sync_session("192.168.1.100"), Some(false));
    }

    #[test]
    fn sync_detection_returns_true_when_slaves_exist() {
        let store = PlaybackSessionStore::new();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));
        store.insert(make_session("s1", "192.168.1.101", GroupRole::Slave));

        assert_eq!(store.is_in_sync_session("192.168.1.100"), Some(true));
        assert_eq!(store.is_in_sync_session("192.168.1.101"), Some(true));
    }

    #[test]
    fn find_other_stream() {
        let store = PlaybackSessionStore::new();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));

        // Same stream - should return None
        assert!(store.find_other_stream("192.168.1.100", "s1").is_none());

        // Different stream - should find it
        let result = store.find_other_stream("192.168.1.100", "s2");
        assert!(result.is_some());
        let (key, session) = result.unwrap();
        assert_eq!(key.stream_id, "s1");
        assert_eq!(session.speaker_ip, "192.168.1.100");
    }

    #[test]
    fn get_slaves_for_coordinator() {
        let store = PlaybackSessionStore::new();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));
        store.insert(make_session("s1", "192.168.1.101", GroupRole::Slave));
        store.insert(make_session("s1", "192.168.1.102", GroupRole::Slave));

        let slaves = store.get_slaves_for_coordinator("s1", "192.168.1.100");
        assert_eq!(slaves.len(), 2);
    }

    #[test]
    fn has_slaves_for_stream() {
        let store = PlaybackSessionStore::new();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));
        assert!(!store.has_slaves_for_stream("s1"));

        store.insert(make_session("s1", "192.168.1.101", GroupRole::Slave));
        assert!(store.has_slaves_for_stream("s1"));
    }

    #[test]
    fn find_coordinator_ip_for_stream() {
        let store = PlaybackSessionStore::new();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));
        store.insert(make_session("s1", "192.168.1.101", GroupRole::Slave));

        assert_eq!(
            store.find_coordinator_ip_for_stream("s1"),
            Some("192.168.1.100".to_string())
        );
        assert_eq!(store.find_coordinator_ip_for_stream("s2"), None);
    }

    #[test]
    fn all_sessions_returns_everything() {
        let store = PlaybackSessionStore::new();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));
        store.insert(make_session("s2", "192.168.1.101", GroupRole::Coordinator));

        assert_eq!(store.all_sessions().len(), 2);
    }

    #[test]
    fn get_ips_for_stream() {
        let store = PlaybackSessionStore::new();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));
        store.insert(make_session("s1", "192.168.1.101", GroupRole::Slave));
        store.insert(make_session("s2", "192.168.1.102", GroupRole::Coordinator));

        let mut ips = store.get_ips_for_stream("s1");
        ips.sort();
        assert_eq!(ips, vec!["192.168.1.100", "192.168.1.101"]);
    }

    #[test]
    fn get_all_for_stream() {
        let store = PlaybackSessionStore::new();
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));
        store.insert(make_session("s1", "192.168.1.101", GroupRole::Slave));
        store.insert(make_session("s2", "192.168.1.102", GroupRole::Coordinator));

        let sessions = store.get_all_for_stream("s1");
        assert_eq!(sessions.len(), 2);
    }

    #[test]
    fn ip_index_updated_on_stream_switch() {
        let store = PlaybackSessionStore::new();
        // Speaker plays stream s1
        store.insert(make_session("s1", "192.168.1.100", GroupRole::Coordinator));
        assert_eq!(
            store.get_by_speaker_ip("192.168.1.100").unwrap().stream_id,
            "s1"
        );

        // Speaker switches to stream s2 - insert new session for same IP
        store.insert(make_session("s2", "192.168.1.100", GroupRole::Coordinator));
        // ip_index should point to the latest session
        assert_eq!(
            store.get_by_speaker_ip("192.168.1.100").unwrap().stream_id,
            "s2"
        );

        // Old session still accessible by key
        assert!(store.get("s1", "192.168.1.100").is_some());
    }
}
