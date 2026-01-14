//! Event emitter abstraction for decoupling services from transport.
//!
//! Services depend on the [`EventEmitter`] trait rather than concrete broadcast
//! channels, enabling testing and alternative transport implementations.

use super::{LatencyEvent, NetworkEvent, SonosEvent, StreamEvent, TopologyEvent};

/// Trait for emitting domain events without knowledge of transport.
///
/// Services use this trait to emit events, decoupling them from the
/// specifics of how events are delivered to clients (WebSocket, SSE, Tauri frontend, etc.).
///
/// # Example
///
/// ```ignore
/// struct MyService {
///     emitter: Arc<dyn EventEmitter>,
/// }
///
/// impl MyService {
///     fn do_something(&self) {
///         self.emitter.emit_stream(StreamEvent::Created { ... });
///     }
/// }
/// ```
pub trait EventEmitter: Send + Sync {
    /// Emits a stream lifecycle event.
    fn emit_stream(&self, event: StreamEvent);

    /// Emits a Sonos device event (from GENA notifications).
    fn emit_sonos(&self, event: SonosEvent);

    /// Emits a network health event.
    fn emit_network(&self, event: NetworkEvent);

    /// Emits a topology discovery event.
    fn emit_topology(&self, event: TopologyEvent);

    /// Emits a latency measurement event.
    fn emit_latency(&self, event: LatencyEvent);
}

/// No-op emitter for headless server or testing.
///
/// Events are silently discarded. In a standalone server, events are typically
/// delivered only via WebSocket to connected clients, so this no-op emitter
/// is used when there's no need to emit to a separate UI frontend.
pub struct NoopEventEmitter;

impl EventEmitter for NoopEventEmitter {
    fn emit_stream(&self, _event: StreamEvent) {
        // No-op: events go via WebSocket only in server mode
    }

    fn emit_sonos(&self, _event: SonosEvent) {
        // No-op
    }

    fn emit_network(&self, _event: NetworkEvent) {
        // No-op
    }

    fn emit_topology(&self, _event: TopologyEvent) {
        // No-op
    }

    fn emit_latency(&self, _event: LatencyEvent) {
        // No-op
    }
}

/// Logging emitter for debugging and development.
///
/// Logs all events at debug level. Useful for debugging event flow
/// or in development environments.
pub struct LoggingEventEmitter;

impl EventEmitter for LoggingEventEmitter {
    fn emit_stream(&self, event: StreamEvent) {
        tracing::debug!(?event, "stream_event");
    }

    fn emit_sonos(&self, event: SonosEvent) {
        tracing::debug!(?event, "sonos_event");
    }

    fn emit_network(&self, event: NetworkEvent) {
        tracing::debug!(?event, "network_event");
    }

    fn emit_topology(&self, event: TopologyEvent) {
        tracing::debug!(?event, "topology_event");
    }

    fn emit_latency(&self, event: LatencyEvent) {
        tracing::debug!(?event, "latency_event");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Test emitter that counts events.
    struct CountingEventEmitter {
        stream_count: AtomicUsize,
        sonos_count: AtomicUsize,
    }

    impl CountingEventEmitter {
        fn new() -> Self {
            Self {
                stream_count: AtomicUsize::new(0),
                sonos_count: AtomicUsize::new(0),
            }
        }
    }

    impl EventEmitter for CountingEventEmitter {
        fn emit_stream(&self, _event: StreamEvent) {
            self.stream_count.fetch_add(1, Ordering::SeqCst);
        }

        fn emit_sonos(&self, _event: SonosEvent) {
            self.sonos_count.fetch_add(1, Ordering::SeqCst);
        }

        fn emit_network(&self, _event: NetworkEvent) {}
        fn emit_topology(&self, _event: TopologyEvent) {}
        fn emit_latency(&self, _event: LatencyEvent) {}
    }

    #[test]
    fn counting_emitter_tracks_events() {
        let emitter = Arc::new(CountingEventEmitter::new());

        emitter.emit_stream(StreamEvent::Created {
            stream_id: "test".to_string(),
            timestamp: 0,
        });
        emitter.emit_stream(StreamEvent::Ended {
            stream_id: "test".to_string(),
            timestamp: 0,
        });
        emitter.emit_sonos(SonosEvent::ZoneGroupsUpdated {
            groups: vec![],
            timestamp: 0,
        });

        assert_eq!(emitter.stream_count.load(Ordering::SeqCst), 2);
        assert_eq!(emitter.sonos_count.load(Ordering::SeqCst), 1);
    }
}
