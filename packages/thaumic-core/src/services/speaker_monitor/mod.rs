//! Pure building blocks for the speaker monitor.
//!
//! The monitor loop itself lives in [`crate::services::latency_monitor`];
//! what it decides from its polls lives here, free of I/O, so each decision
//! can be tested on its own:
//!
//! - [`bounds`] turns one poll into bounds on the playhead and the reserve;
//! - [`reserve`] estimates the reserve from a window of those bounds;
//! - [`clock_fit`] measures the speaker's clock rate against ours;
//! - [`segment`] decides when measurements stop being continuous;
//! - [`tracker`] ties the three together for one speaker;
//! - [`rollup`] reduces a window of samples for the log;
//! - [`transport_gate`] decides whether the speaker is playing;
//! - [`topology_diff`] names what changed in the household between two
//!   zone topology snapshots.

pub mod bounds;
pub mod clock_fit;
pub mod reserve;
pub mod rollup;
pub mod segment;
pub mod topology_diff;
pub mod tracker;
pub mod transport_gate;

#[cfg(test)]
mod sim;
#[cfg(test)]
pub(crate) mod test_support;

pub use bounds::{PlayheadBound, PollObservation};
pub use clock_fit::{ClockEstimate, ClockFit};
pub use reserve::{ReserveEstimate, ReserveEstimator};
pub use rollup::WindowStats;
pub use segment::{Segment, SegmentBreak};
pub use topology_diff::{MemberChange, RadioField, TopologyDiff};
pub use tracker::{AckedReserve, ConnectionStats, MonitorState, ReserveTracker};
pub use transport_gate::{
    GenaTransport, GenaTransportView, TransportGate, TransportSource, TransportStateView,
    TransportVerdict,
};
