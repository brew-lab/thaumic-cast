pub mod icy;
pub mod manager;
pub mod wav;

pub use icy::{IcyFormatter, IcyMetadataInjector, ICY_METAINT};
pub use manager::{AudioCodec, StreamManager, StreamMetadata, StreamState};
pub use wav::create_wav_header;

// Deprecated re-exports for backward compatibility
#[allow(deprecated)]
pub use manager::inject_icy_metadata;
