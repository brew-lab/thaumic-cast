//! WebSocket connection tracking and management.
//!
//! This module provides tracking of WebSocket connections with force-close capability:
//!
//! - `WsConnectionManager`: Tracks all active WebSocket connections
//! - `ConnectionGuard`: RAII guard for automatic cleanup on disconnect

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use parking_lot::RwLock;
use tokio_util::sync::CancellationToken;

/// Internal connection state (placeholder for future metadata).
struct ConnectionState {}

/// Manages all active WebSocket connections.
///
/// Thread-safe and designed for concurrent access from multiple
/// WebSocket handlers. Uses hierarchical cancellation tokens for
/// efficient force-close of all connections.
pub struct WsConnectionManager {
    /// Active connections: connection_id -> ConnectionState
    connections: DashMap<String, ConnectionState>,
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
            next_id: AtomicU64::new(1),
            global_cancel: RwLock::new(CancellationToken::new()),
        }
    }

    /// Registers a new connection and returns a guard for RAII cleanup.
    ///
    /// The returned `ConnectionGuard` will automatically unregister the
    /// connection when dropped.
    pub fn register(self: &Arc<Self>) -> ConnectionGuard {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let conn_id = format!("ws-{}", id);
        let cancel_token = self.global_cancel.read().child_token();

        let state = ConnectionState {};

        self.connections.insert(conn_id.clone(), state);
        log::info!(
            "[WS] Connection registered: {} (total: {})",
            conn_id,
            self.connections.len()
        );

        ConnectionGuard {
            id: conn_id,
            manager: Arc::clone(self),
            cancel_token,
        }
    }

    /// Unregisters a connection by ID.
    fn unregister(&self, id: &str) {
        if self.connections.remove(id).is_some() {
            log::info!(
                "[WS] Connection unregistered: {} (remaining: {})",
                id,
                self.connections.len()
            );
        }
    }

    /// Returns the number of active connections.
    #[must_use]
    pub fn connection_count(&self) -> usize {
        self.connections.len()
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
    id: String,
    manager: Arc<WsConnectionManager>,
    /// Token for this specific connection - cancelled on force-close.
    cancel_token: CancellationToken,
}

impl ConnectionGuard {
    /// Returns the connection ID.
    pub fn id(&self) -> &str {
        &self.id
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
        self.manager.unregister(&self.id);
    }
}
