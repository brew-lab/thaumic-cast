//! Pure building blocks for the speaker monitor.
//!
//! The monitor loop itself lives in [`crate::services::latency_monitor`];
//! what it decides from its polls lives here, free of I/O, so each decision
//! can be tested on its own.

pub mod transport_gate;

pub use transport_gate::{
    GenaTransport, GenaTransportView, TransportGate, TransportSource, TransportStateView,
    TransportVerdict,
};
