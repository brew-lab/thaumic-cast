//! The vocabulary the rest of the crate shares: small value types and the
//! pure functions on them, with nothing above them to depend on.
//!
//! Events carry these types, the stream path reads them and the services
//! decide them, so they live below all three. A module here may use only
//! `std`, `serde`, `log`, [`crate::protocol_constants`] and
//! [`crate::sonos::types`]. Each item is still exported from the module it
//! came from.

pub mod drift;
pub mod head_start;
pub mod monitor_switch;
pub mod notice;
pub mod timeline;
pub mod topology;

pub use drift::{drift_compensation_mode, DriftMode, DRIFT_COMPENSATION_ENV};
pub use head_start::{parse_pcm_connect_burst_ms, pcm_connect_burst_ms, PCM_CONNECT_BURST_ENV};
pub use monitor_switch::{
    parse_speaker_monitor_switch, SPEAKER_DIAGNOSTICS_ENV, SPEAKER_MONITOR_ENV,
};
pub use notice::{SpeakerNotice, SpeakerNoticeCause, SpeakerNoticeKind};
pub use timeline::{PlayoutTimeline, TimelineEntry};
pub use topology::{MemberChange, RadioField};
