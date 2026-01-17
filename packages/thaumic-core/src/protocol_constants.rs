//! Fixed protocol constants that should NOT be changed.
//!
//! These values are defined by external specifications (UPnP, GENA, audio standards)
//! and changing them would break protocol compliance.

// ─────────────────────────────────────────────────────────────────────────────
// GENA (UPnP General Event Notification Architecture)
// ─────────────────────────────────────────────────────────────────────────────

/// GENA subscription timeout requested from speaker (seconds).
///
/// 1 hour is a reasonable default per UPnP spec recommendations.
pub const GENA_SUBSCRIPTION_TIMEOUT_SECS: u64 = 3600;

/// Time before subscription expiry to trigger renewal (seconds).
///
/// 5 minutes provides comfortable buffer for network delays.
pub const GENA_RENEWAL_BUFFER_SECS: u64 = 300;

/// Interval between subscription renewal checks (seconds).
pub const GENA_RENEWAL_CHECK_SECS: u64 = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Audio Standards
// ─────────────────────────────────────────────────────────────────────────────

/// Default audio sample rate (Hz).
///
/// 48kHz is the standard for digital audio (DVD, Blu-ray, professional audio).
pub const DEFAULT_SAMPLE_RATE: u32 = 48000;

/// Default number of audio channels (stereo).
pub const DEFAULT_CHANNELS: u16 = 2;

/// Maximum size indicator for WAV streams (4,294,967,295 bytes / ~4.3 GB).
///
/// Used in WAV headers (RIFF file size, data chunk size) and HTTP Content-Length
/// to signal an "infinite" stream. This prevents chunked transfer encoding,
/// which some renderers (including Sonos) handle poorly for WAV.
pub const WAV_STREAM_SIZE_MAX: u32 = u32::MAX;

// ─────────────────────────────────────────────────────────────────────────────
// ICY Protocol (Shoutcast/Icecast metadata)
// ─────────────────────────────────────────────────────────────────────────────

/// ICY metadata interval (bytes between metadata blocks).
///
/// 8192 bytes is the interval we use for Sonos compatibility.
/// This is a protocol specification constant, not a tunable parameter.
pub const ICY_METAINT: usize = 8192;

// ─────────────────────────────────────────────────────────────────────────────
// HTTP/SOAP
// ─────────────────────────────────────────────────────────────────────────────

/// Timeout for SOAP HTTP requests (seconds).
///
/// 10 seconds is reasonable for LAN operations.
pub const SOAP_TIMEOUT_SECS: u64 = 10;

/// Maximum size of GENA notification body (bytes).
pub const MAX_GENA_BODY_SIZE: usize = 64 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Application Identity
// ─────────────────────────────────────────────────────────────────────────────

/// Application name used in protocol data (DIDL-Lite metadata, ICY headers).
///
/// This is intentionally NOT localized since it appears in network protocols
/// where consistency matters more than translation.
pub const APP_NAME: &str = "Thaumic Cast";

/// Service identifier used for discovery (health endpoint).
///
/// The extension probes /health and expects this exact string to identify
/// a valid Thaumic Cast server. Generic name since the core runs in both
/// desktop app and standalone server.
pub const SERVICE_ID: &str = "thaumic-cast";

// ─────────────────────────────────────────────────────────────────────────────
// Streaming Configuration Constants
// ─────────────────────────────────────────────────────────────────────────────

/// Capacity of the event broadcast channel for WebSocket clients.
pub const EVENT_CHANNEL_CAPACITY: usize = 100;

/// Capacity of the internal GENA event channel (SubscriptionLost events).
pub const GENA_EVENT_CHANNEL_CAPACITY: usize = 64;

/// WebSocket heartbeat timeout (seconds).
pub const WS_HEARTBEAT_TIMEOUT_SECS: u64 = 30;

/// Interval between WebSocket heartbeat checks (seconds).
pub const WS_HEARTBEAT_CHECK_INTERVAL_SECS: u64 = 1;

/// Default frame duration for injected silence (ms).
/// Used as fallback when client doesn't specify frame_size_samples.
/// At 48kHz this corresponds to 480 samples.
pub const SILENCE_FRAME_DURATION_MS: u32 = 10;

/// Minimum frame duration (ms).
/// 5ms is reasonable for low-latency PCM streaming.
pub const MIN_FRAME_DURATION_MS: u32 = 5;

/// Maximum frame duration (ms).
/// Must accommodate codec requirements at all supported sample rates:
/// - AAC: 1024 samples at 8kHz = 128ms (spec-mandated frame size)
/// - FLAC: 4096 samples at 48kHz = 85ms (larger frames improve compression)
///
/// 150ms provides margin for all cases.
pub const MAX_FRAME_DURATION_MS: u32 = 150;

/// Frame size constraints (samples per channel).
/// Used to derive exact frame duration without floating-point rounding.
///
/// SYNC REQUIRED: These must match the TypeScript constants in:
///   packages/protocol/src/audio.ts
///   - FRAME_SIZE_SAMPLES_MIN
///   - FRAME_SIZE_SAMPLES_MAX
#[allow(dead_code)]
pub const MIN_FRAME_SIZE_SAMPLES: u32 = 64;
#[allow(dead_code)]
pub const MAX_FRAME_SIZE_SAMPLES: u32 = 8192;

/// Minimum streaming buffer size (ms).
pub const MIN_STREAMING_BUFFER_MS: u64 = 100;

/// Maximum streaming buffer size (ms).
pub const MAX_STREAMING_BUFFER_MS: u64 = 1000;

/// Default streaming buffer size (ms).
pub const DEFAULT_STREAMING_BUFFER_MS: u64 = 200;

/// Maximum cadence queue size (frames).
/// Calculated using MIN_FRAME_DURATION_MS to ensure buffer can hold enough frames
/// at the smallest possible frame duration.
pub const MAX_CADENCE_QUEUE_SIZE: usize =
    (MAX_STREAMING_BUFFER_MS / MIN_FRAME_DURATION_MS as u64) as usize;
