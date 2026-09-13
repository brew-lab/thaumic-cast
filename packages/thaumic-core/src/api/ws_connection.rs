//! WebSocket connection tracking and management.
//!
//! This module provides tracking of WebSocket connections with force-close capability:
//!
//! - `WsConnectionManager`: Tracks all active WebSocket connections
//! - `ConnectionState`: Per-connection identity (connection id, peer, client id)
//! - `ConnectionGuard`: RAII guard for automatic cleanup on disconnect
//!
//! One companion serves many extensions at once, so the manager also records
//! which connection created which stream, keyed on the creator's peer address.
//! That bookkeeping is what lets `INITIAL_STATE` show a client its own sessions
//! in full while reducing every other client's session to "this speaker is
//! busy" (see `ws::build_initial_state`), and what keeps another client's live
//! stream ids out of the broadcast events it receives.

use std::collections::HashSet;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use parking_lot::RwLock;
use tokio_util::sync::CancellationToken;

/// Returns `true` if `ip` is on this machine.
///
/// Canonicalises first, so IPv4-mapped IPv6 loopback (`::ffff:127.0.0.1`) —
/// what a dual-stack listener reports for a local IPv4 client — counts too.
#[must_use]
pub fn is_loopback_ip(ip: IpAddr) -> bool {
    ip.to_canonical().is_loopback()
}

/// Identity and metadata of one live WebSocket connection.
///
/// `client_id` is whatever the client asserted on the upgrade. It is a label
/// for logs and display, **not** a credential and **not** an ownership key:
/// nothing verifies it, so any client can present any value. Ownership is keyed
/// on the peer address instead — see [`ConnectionState::owner_ip`].
pub struct ConnectionState {
    /// Manager-generated id, unique for the life of the process (`ws-{n}`).
    connection_id: String,
    /// Peer address of the TCP connection carrying this socket.
    remote_addr: SocketAddr,
    /// Client-asserted label, when the client sent one. Logs and display only.
    client_id: Option<String>,
}

impl ConnectionState {
    /// Returns the manager-generated connection id.
    #[must_use]
    pub fn connection_id(&self) -> &str {
        &self.connection_id
    }

    /// Returns the peer address of this connection.
    #[must_use]
    pub fn remote_addr(&self) -> SocketAddr {
        self.remote_addr
    }

    /// Returns the client-asserted label, if the client sent one.
    #[must_use]
    pub fn client_id(&self) -> Option<&str> {
        self.client_id.as_deref()
    }

    /// Returns the address this connection's streams are recorded under.
    ///
    /// The peer address, so every socket of one browser shares one owner: the
    /// extension opens a control socket alongside each streaming socket, and
    /// both come back on the same address after a reconnect.
    ///
    /// Deliberately *not* the client-asserted id. That is a value the client
    /// picks, so keying ownership on it lets any client claim any other
    /// client's streams — and with them the stream ids that `/stream/{id}`
    /// serves to whoever asks. A peer address cannot be forged over an
    /// established TCP connection. The cost is that two browsers on one machine
    /// share an owner, which is acceptable: they already share a user account.
    #[must_use]
    pub fn owner_ip(&self) -> IpAddr {
        self.remote_addr.ip().to_canonical()
    }
}

/// What is connected from machines other than the one this process runs on.
///
/// Plain owned numbers taken in one pass, so a caller can hold the summary —
/// and decide what to do about it — without holding any lock on the connection
/// table. See [`WsConnectionManager::remote_peers`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RemotePeers {
    /// Distinct owner addresses that are not this machine: how many *other*
    /// machines a server-wide action would reach.
    pub machines: usize,
    /// Live sockets those machines hold. Normally higher than `machines`: one
    /// browser keeps a control socket plus one socket per cast.
    pub connections: usize,
    /// Streams those machines currently own.
    pub streams: usize,
}

/// Which connection owns a stream.
struct StreamOwner {
    /// `ConnectionState::owner_ip` of the creator.
    owner_ip: IpAddr,
    /// Connection that created it, so its disconnect releases the record.
    connection_id: String,
}

/// Manages all active WebSocket connections.
///
/// Thread-safe and designed for concurrent access from multiple
/// WebSocket handlers. Uses hierarchical cancellation tokens for
/// efficient force-close of all connections.
pub struct WsConnectionManager {
    /// Active connections: connection_id -> ConnectionState
    connections: DashMap<String, Arc<ConnectionState>>,
    /// Streams created over a WebSocket: stream_id -> owner.
    stream_owners: DashMap<String, StreamOwner>,
    /// Counter for generating unique connection IDs.
    next_id: AtomicU64,
    /// Global cancellation token - when cancelled, all connections close.
    /// Wrapped in RwLock so it can be replaced after close_all().
    global_cancel: RwLock<CancellationToken>,
}

impl WsConnectionManager {
    /// Creates a new connection manager.
    pub fn new() -> Self {
        Self {
            connections: DashMap::new(),
            stream_owners: DashMap::new(),
            next_id: AtomicU64::new(1),
            global_cancel: RwLock::new(CancellationToken::new()),
        }
    }

    /// Registers a new connection and returns a guard for RAII cleanup.
    ///
    /// `remote_addr` is the peer address of the socket, and the key this
    /// connection's streams are recorded under. `client_id` is the (unverified,
    /// already sanitised) label the client asserted on the upgrade, or `None`;
    /// it is logged and displayed, never used to decide ownership.
    ///
    /// The returned `ConnectionGuard` will automatically unregister the
    /// connection — and release the streams it claimed — when dropped.
    pub fn register(
        self: &Arc<Self>,
        remote_addr: SocketAddr,
        client_id: Option<String>,
    ) -> ConnectionGuard {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let conn_id = format!("ws-{}", id);
        let cancel_token = self.global_cancel.read().child_token();

        let state = Arc::new(ConnectionState {
            connection_id: conn_id.clone(),
            remote_addr,
            client_id,
        });

        self.connections.insert(conn_id.clone(), Arc::clone(&state));
        log::info!(
            "[WS] Connection registered: {} (peer: {}, clientId: {}, total: {})",
            conn_id,
            remote_addr,
            state.client_id().unwrap_or("<none>"),
            self.connections.len()
        );

        ConnectionGuard {
            state,
            manager: Arc::clone(self),
            cancel_token,
        }
    }

    /// Unregisters a connection by ID and releases the streams it claimed.
    fn unregister(&self, id: &str) {
        self.stream_owners
            .retain(|_, owner| owner.connection_id != id);
        if self.connections.remove(id).is_some() {
            log::info!(
                "[WS] Connection unregistered: {} (remaining: {})",
                id,
                self.connections.len()
            );
        }
    }

    /// Records that `state`'s connection created `stream_id`.
    fn claim_stream(&self, state: &ConnectionState, stream_id: &str) {
        self.stream_owners.insert(
            stream_id.to_string(),
            StreamOwner {
                owner_ip: state.owner_ip(),
                connection_id: state.connection_id().to_string(),
            },
        );
    }

    /// Drops the ownership record for `stream_id`.
    pub fn release_stream(&self, stream_id: &str) {
        self.stream_owners.remove(stream_id);
    }

    /// Returns `true` if `stream_id` was created by the same client as `state`.
    fn owns_stream(&self, state: &ConnectionState, stream_id: &str) -> bool {
        self.stream_owners
            .get(stream_id)
            .is_some_and(|owner| owner.owner_ip == state.owner_ip())
    }

    /// Returns `true` if `stream_id` is currently claimed by a different client.
    fn stream_is_owned_by_other(&self, state: &ConnectionState, stream_id: &str) -> bool {
        self.stream_owners
            .get(stream_id)
            .is_some_and(|owner| owner.owner_ip != state.owner_ip())
    }

    /// Returns the number of active connections.
    #[must_use]
    pub fn connection_count(&self) -> usize {
        self.connections.len()
    }

    /// Summarises what is connected from machines other than this one.
    ///
    /// This is the "who else does a server-wide action reach" question, and the
    /// unit is machines, not sockets: one browser holds a control socket plus
    /// one socket per cast (see `api::ws`), so counting sockets would multiply
    /// a single user into a crowd. Two browsers on one machine count once,
    /// which is the same grouping ownership already uses (see
    /// [`ConnectionState::owner_ip`]).
    ///
    /// `host_ip` is this process's own advertised address, or `None` when it
    /// has no local client to exclude — the headless server, where every client
    /// is on another machine by definition. Loopback is always local; the
    /// advertised address counts as local too, because a browser on this very
    /// machine may have been pointed at the LAN address rather than
    /// `localhost`, which is the same allowance `ws::is_companion_host` makes.
    ///
    /// One pass over two small maps, cheap enough to call on a tray click, and
    /// it copies out what it needs rather than lending a borrow, so nothing is
    /// locked once it returns.
    #[must_use]
    pub fn remote_peers(&self, host_ip: Option<IpAddr>) -> RemotePeers {
        let host_ip = host_ip.map(|ip| ip.to_canonical());
        // `owner_ip()` and `StreamOwner::owner_ip` are already canonical, so
        // both sides of this comparison are.
        let is_remote = |ip: IpAddr| !is_loopback_ip(ip) && Some(ip) != host_ip;

        let mut machines = HashSet::new();
        let mut connections = 0;
        for entry in self.connections.iter() {
            let ip = entry.value().owner_ip();
            if is_remote(ip) {
                machines.insert(ip);
                connections += 1;
            }
        }

        let streams = self
            .stream_owners
            .iter()
            .filter(|entry| is_remote(entry.value().owner_ip))
            .count();

        RemotePeers {
            machines: machines.len(),
            connections,
            streams,
        }
    }

    /// Force-closes all connections.
    ///
    /// This cancels the global token, which signals all connection handlers
    /// to terminate gracefully. After cancellation, a fresh token is created
    /// so new connections can still be accepted.
    ///
    /// Returns the number of connections that were signaled to close.
    pub fn close_all(&self) -> usize {
        let count = self.connections.len();
        if count > 0 {
            log::info!("[WS] Force-closing {} connection(s)", count);
            // Cancel current token and replace with a fresh one
            let mut guard = self.global_cancel.write();
            guard.cancel();
            *guard = CancellationToken::new();
        } else {
            log::info!("[WS] close_all called but no connections to close");
        }
        count
    }
}

impl Default for WsConnectionManager {
    fn default() -> Self {
        Self::new()
    }
}

/// RAII guard that unregisters a connection when dropped.
///
/// This ensures connections are always cleaned up, even if the handler
/// panics or exits early.
pub struct ConnectionGuard {
    state: Arc<ConnectionState>,
    manager: Arc<WsConnectionManager>,
    /// Token for this specific connection - cancelled on force-close.
    cancel_token: CancellationToken,
}

impl ConnectionGuard {
    /// Returns the connection ID.
    pub fn id(&self) -> &str {
        self.state.connection_id()
    }

    /// Returns this connection's identity and metadata.
    #[must_use]
    pub fn state(&self) -> &ConnectionState {
        &self.state
    }

    /// Returns the peer address of this connection.
    #[must_use]
    pub fn remote_addr(&self) -> SocketAddr {
        self.state.remote_addr()
    }

    /// Returns a handle to the manager, for holding ownership records that
    /// outlive a borrow of this guard.
    #[must_use]
    pub fn manager(&self) -> Arc<WsConnectionManager> {
        Arc::clone(&self.manager)
    }

    /// Records that this connection created `stream_id`.
    pub fn claim_stream(&self, stream_id: &str) {
        self.manager.claim_stream(&self.state, stream_id);
    }

    /// Returns `true` if `stream_id` was created by this client.
    ///
    /// Also true for another connection from the same peer address — that is
    /// what lets the extension's control socket recognise the stream its own
    /// streaming socket created (see [`ConnectionState::owner_ip`]).
    #[must_use]
    pub fn owns_stream(&self, stream_id: &str) -> bool {
        self.manager.owns_stream(&self.state, stream_id)
    }

    /// Returns `true` if `stream_id` is live and belongs to a *different*
    /// client.
    ///
    /// This is the "may I be told about this stream at all" question, and it is
    /// deliberately not the negation of [`owns_stream`]: a stream with no
    /// ownership record left is one that has already been released, so its id
    /// no longer buys anything and events naming it may go to everyone. That
    /// distinction is what lets stream teardown be announced to every client
    /// (each extension cleans up its own session from those events) without
    /// also announcing a *still live* stream id — the case where one speaker
    /// leaves a cast that keeps playing on the others.
    #[must_use]
    pub fn stream_is_owned_by_other(&self, stream_id: &str) -> bool {
        self.manager
            .stream_is_owned_by_other(&self.state, stream_id)
    }

    /// Returns the cancellation token for this connection.
    ///
    /// Use this in `tokio::select!` to detect force-close requests:
    /// ```ignore
    /// tokio::select! {
    ///     _ = cancel_token.cancelled() => break,
    ///     // ... other branches
    /// }
    /// ```
    pub fn cancel_token(&self) -> &CancellationToken {
        &self.cancel_token
    }
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.manager.unregister(self.state.connection_id());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(s: &str) -> SocketAddr {
        s.parse().expect("valid socket address")
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().expect("valid IP address")
    }

    fn manager() -> Arc<WsConnectionManager> {
        Arc::new(WsConnectionManager::new())
    }

    #[test]
    fn each_connection_gets_its_own_identity() {
        let manager = manager();
        let first = manager.register(addr("127.0.0.1:5001"), None);
        let second = manager.register(addr("192.168.1.9:5002"), Some("ext-a".into()));

        assert_ne!(first.id(), second.id());
        assert_eq!(second.state().client_id(), Some("ext-a"));
        assert_eq!(second.remote_addr(), addr("192.168.1.9:5002"));
        assert_eq!(manager.connection_count(), 2);
    }

    #[test]
    fn ownership_ignores_the_client_asserted_id() {
        let manager = manager();
        // The victim's browser, which asserts nothing (today's extension).
        let victim = manager.register(addr("192.168.1.9:5001"), None);
        victim.claim_stream("victim-stream");

        // An attacker that asserts the victim's connection id, its peer
        // address, or anything else it can think of: none of it is an
        // ownership key, so none of it un-redacts the victim's stream.
        for asserted in [
            victim.id().to_string(),
            "192.168.1.9".to_string(),
            "ws-1".to_string(),
        ] {
            let attacker = manager.register(addr("192.168.1.20:6000"), Some(asserted.clone()));
            assert!(
                !attacker.owns_stream("victim-stream"),
                "clientId {asserted:?} must not grant ownership"
            );
        }
    }

    #[test]
    fn loopback_detection_covers_v6_and_mapped_v4() {
        let loopback = |s: &str| is_loopback_ip(s.parse().expect("valid IP address"));
        assert!(loopback("127.0.0.1"));
        assert!(loopback("::1"));
        assert!(loopback("::ffff:127.0.0.1"));
        assert!(!loopback("192.168.1.9"));
        assert!(!loopback("fe80::1"));
    }

    #[test]
    fn a_stream_is_owned_only_by_the_client_that_created_it() {
        let manager = manager();
        let mine = manager.register(addr("127.0.0.1:5001"), None);
        let theirs = manager.register(addr("192.168.1.9:5002"), None);

        mine.claim_stream("stream-1");
        theirs.claim_stream("stream-2");

        assert!(mine.owns_stream("stream-1"));
        assert!(!mine.owns_stream("stream-2"));
        assert!(theirs.owns_stream("stream-2"));
        assert!(!theirs.owns_stream("stream-1"));
        assert!(!mine.owns_stream("stream-unknown"));
    }

    #[test]
    fn connections_from_one_browser_share_their_streams() {
        let manager = manager();
        // The extension opens a streaming socket and an always-on control
        // socket from the same machine, so the control socket still recognises
        // the stream the streaming socket created — with no cooperation from
        // the client.
        let streaming = manager.register(addr("192.168.1.9:5001"), None);
        let control = manager.register(addr("192.168.1.9:5002"), None);
        let other_browser = manager.register(addr("192.168.1.20:5003"), None);

        streaming.claim_stream("stream-1");

        assert!(control.owns_stream("stream-1"));
        assert!(!other_browser.owns_stream("stream-1"));
    }

    #[test]
    fn a_mapped_v4_peer_is_the_same_owner_as_the_plain_v4_peer() {
        // A dual-stack listener reports ::ffff:a.b.c.d for some clients and
        // a.b.c.d for others; the same machine must not split into two owners.
        let manager = manager();
        let mapped = manager.register(addr("[::ffff:192.168.1.9]:5001"), None);
        let plain = manager.register(addr("192.168.1.9:5002"), None);

        mapped.claim_stream("stream-1");
        assert!(plain.owns_stream("stream-1"));
    }

    #[test]
    fn disconnecting_releases_only_that_connections_claims() {
        let manager = manager();
        let keeper = manager.register(addr("127.0.0.1:5001"), None);
        keeper.claim_stream("stream-keep");

        {
            let leaving = manager.register(addr("192.168.1.9:5002"), None);
            leaving.claim_stream("stream-gone");
            assert!(leaving.owns_stream("stream-gone"));
        }

        assert!(!keeper.owns_stream("stream-gone"));
        assert!(keeper.owns_stream("stream-keep"));
        assert_eq!(manager.connection_count(), 1);
    }

    #[test]
    fn a_reconnect_does_not_inherit_a_released_stream() {
        let manager = manager();
        {
            let first = manager.register(addr("192.168.1.9:5001"), None);
            first.claim_stream("stream-1");
        }
        // The stream died with the socket that created it, so the record must
        // be gone even though the same machine comes back.
        let reconnected = manager.register(addr("192.168.1.9:5002"), None);
        assert!(!reconnected.owns_stream("stream-1"));
    }

    #[test]
    fn a_stream_is_owned_by_another_client_only_while_it_is_claimed() {
        let manager = manager();
        let owner = manager.register(addr("192.168.1.9:5001"), None);
        let stranger = manager.register(addr("192.168.1.20:5002"), None);
        owner.claim_stream("stream-1");

        assert!(stranger.stream_is_owned_by_other("stream-1"));
        assert!(!owner.stream_is_owned_by_other("stream-1"));
        // An unclaimed or already-released id belongs to nobody, so nobody is
        // excluded from events that name it.
        assert!(!stranger.stream_is_owned_by_other("stream-unknown"));
        owner.manager().release_stream("stream-1");
        assert!(!stranger.stream_is_owned_by_other("stream-1"));
    }

    #[test]
    fn nothing_connected_reaches_nobody() {
        let manager = manager();
        assert_eq!(manager.remote_peers(None), RemotePeers::default());
        assert_eq!(
            manager.remote_peers(Some(ip("192.168.1.5"))),
            RemotePeers::default()
        );
    }

    #[test]
    fn loopback_clients_are_not_other_machines() {
        let manager = manager();
        let local = manager.register(addr("127.0.0.1:5001"), None);
        let local_v6 = manager.register(addr("[::1]:5002"), None);
        let local_mapped = manager.register(addr("[::ffff:127.0.0.1]:5003"), None);
        local.claim_stream("stream-1");
        local_v6.claim_stream("stream-2");
        local_mapped.claim_stream("stream-3");

        assert_eq!(manager.connection_count(), 3);
        assert_eq!(manager.remote_peers(None), RemotePeers::default());
    }

    #[test]
    fn several_sockets_from_one_browser_are_one_machine() {
        let manager = manager();
        // Control socket plus one socket per cast, all from one extension.
        let _control = manager.register(addr("192.168.1.9:5001"), None);
        let first_cast = manager.register(addr("192.168.1.9:5002"), None);
        let second_cast = manager.register(addr("[::ffff:192.168.1.9]:5003"), None);
        first_cast.claim_stream("stream-1");
        second_cast.claim_stream("stream-2");

        let remote = manager.remote_peers(None);
        assert_eq!(remote.machines, 1, "one browser is one machine");
        assert_eq!(remote.connections, 3);
        assert_eq!(remote.streams, 2);
    }

    #[test]
    fn a_mix_of_loopback_and_remote_counts_only_the_remote() {
        let manager = manager();
        let _local = manager.register(addr("127.0.0.1:5001"), None);
        let local_cast = manager.register(addr("127.0.0.1:5002"), None);
        let far = manager.register(addr("192.168.1.9:5003"), None);
        let farther = manager.register(addr("192.168.1.20:5004"), None);
        local_cast.claim_stream("local-stream");
        far.claim_stream("far-stream");
        farther.claim_stream("farther-stream");

        let remote = manager.remote_peers(None);
        assert_eq!(remote.machines, 2);
        assert_eq!(remote.connections, 2);
        assert_eq!(remote.streams, 2, "the loopback stream is not theirs");
        assert_eq!(manager.connection_count(), 4);
    }

    #[test]
    fn the_advertised_lan_address_is_this_machine_too() {
        // A browser on this very machine may have been pointed at the address
        // the Server view offers to copy instead of localhost.
        let manager = manager();
        let same_machine = manager.register(addr("192.168.1.5:5001"), None);
        let other_machine = manager.register(addr("192.168.1.9:5002"), None);
        same_machine.claim_stream("mine");
        other_machine.claim_stream("theirs");

        let remote = manager.remote_peers(Some(ip("192.168.1.5")));
        assert_eq!(remote.machines, 1);
        assert_eq!(remote.connections, 1);
        assert_eq!(remote.streams, 1);

        // With no host address to exclude — the headless server — both are
        // other machines.
        assert_eq!(manager.remote_peers(None).machines, 2);
    }

    #[test]
    fn a_disconnected_peer_stops_counting() {
        let manager = manager();
        {
            let leaving = manager.register(addr("192.168.1.9:5001"), None);
            leaving.claim_stream("stream-1");
            assert_eq!(manager.remote_peers(None).machines, 1);
        }
        assert_eq!(manager.remote_peers(None), RemotePeers::default());
    }

    #[test]
    fn releasing_a_stream_drops_its_ownership_record() {
        let manager = manager();
        let conn = manager.register(addr("127.0.0.1:5001"), None);
        conn.claim_stream("stream-1");
        conn.manager().release_stream("stream-1");
        assert!(!conn.owns_stream("stream-1"));
    }
}
