//! Event emitter abstraction for decoupling services from transport.
//!
//! Services depend on the [`EventEmitter`] trait rather than concrete broadcast
//! channels, enabling testing and alternative transport implementations.

use super::{NetworkEvent, StreamEvent};
use crate::sonos::gena::SonosEvent;

/// Trait for emitting domain events without knowledge of transport.
///
/// Services use this trait to emit events, decoupling them from the
/// specifics of how events are delivered to clients (WebSocket, SSE, etc.).
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

    /// Emits a Sonos device event.
    fn emit_sonos(&self, event: SonosEvent);

    /// Emits a network health event.
    fn emit_network(&self, event: NetworkEvent);
}
