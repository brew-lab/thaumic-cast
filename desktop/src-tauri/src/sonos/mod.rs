mod client;
pub mod gena;
pub(crate) mod soap;
mod ssdp;
pub mod state;

// Re-export functions from client
pub use client::{
    discover_speakers, get_cached_speaker_count, get_group_volume, get_last_discovery_timestamp,
    get_zone_groups, play_stream, set_group_volume, stop,
};

// Re-export types from generated module
pub use crate::generated::StreamMetadata;

// Re-export GENA types (with local extension traits)
pub use gena::{GenaListener, GenaService, SonosEvent};

// Re-export state manager
pub use state::SonosState;
