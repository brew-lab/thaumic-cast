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
/// Used in WAV headers (RIFF file size, data chunk size) and, by default, as
/// the HTTP Content-Length of a PCM response, to signal an "infinite" stream.
/// As a Content-Length it is also a real end: hyper stops the body once this
/// many bytes are written. Field experiments can change both (see
/// [`crate::stream::pcm_http`]).
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

/// Timeout for a background position poll (milliseconds).
///
/// A healthy speaker answers `GetPositionInfo` in tens of milliseconds. A
/// poll still outstanding after a second and a half is abandoned, so a
/// speaker that has stopped answering costs its poller at most this long
/// per attempt instead of the full [`SOAP_TIMEOUT_SECS`].
pub const POSITION_POLL_TIMEOUT_MS: u64 = 1500;

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

/// Wire-protocol semver advertised to extension clients in the handshake ACK.
///
/// Kept in sync with `@thaumic-cast/protocol`'s exported `PROTOCOL_VERSION`
/// (`packages/protocol/src/websocket.ts`) by `scripts/sync-versions.ts`,
/// invoked at release time via `bun run changeset:version`. Do not edit by
/// hand; see `CONTRIBUTING.md` → Protocol versioning for the bump policy and
/// its relationship with `MIN_COMPATIBLE_PROTOCOL_VERSION`.
pub const PROTOCOL_VERSION: &str = "0.5.0";

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
/// Minimum jitter buffer size (ms).
pub const MIN_JITTER_BUFFER_MS: u64 = 100;

/// Maximum jitter buffer size (ms).
pub const MAX_JITTER_BUFFER_MS: u64 = 1000;

/// Default jitter buffer size (ms).
pub const DEFAULT_JITTER_BUFFER_MS: u64 = 200;

/// Overflow cap multiplier: `overflow_cap = buffer_depth × this factor`.
/// Allows short producer bursts past the intended buffer depth without
/// immediately dropping frames, while still bounding memory on pathological
/// input (slow HTTP consumer with fast WebSocket producer).
pub const JITTER_OVERFLOW_MULTIPLIER: usize = 3;

/// Minimum overflow cap (frames). Ensures at least one frame can be queued
/// even when the configured jitter buffer is 0 (pass-through mode).
pub const MIN_OVERFLOW_CAP: usize = 1;

/// The smoothing (jitter buffer) steps the extension offers for PCM, in ms.
/// The ingest-gap notice only ever suggests one of these; the wire still
/// accepts anything from [`MIN_JITTER_BUFFER_MS`] to [`MAX_JITTER_BUFFER_MS`].
pub const PCM_SMOOTHING_OPTIONS_MS: [u32; 4] = [100, 200, 300, 500];

/// Maximum cadence queue size (frames).
/// Upper bound on the overflow cap. Calculated using `MIN_FRAME_DURATION_MS`
/// to ensure the cap can accommodate the configured capacity at the smallest
/// possible frame duration.
pub const MAX_CADENCE_QUEUE_SIZE: usize =
    (MAX_JITTER_BUFFER_MS / MIN_FRAME_DURATION_MS as u64) as usize * JITTER_OVERFLOW_MULTIPLIER;

/// Default PCM connect burst (ms): audio handed to a speaker as fast as TCP
/// takes it when its GET starts, ahead of real-time pacing.
///
/// A Sonos speaker playing an endless WAV holds only the audio that reached
/// it ahead of its playhead. Paced from the first frame, that is a few tens
/// of milliseconds, which a Wi-Fi retransmission burst outlasts. HTTP
/// renderers expect a large first portion on GET and regulate the rest with
/// TCP flow control, so the speaker keeps this much in hand.
pub const DEFAULT_PCM_CONNECT_BURST_MS: u64 = 500;

/// Maximum PCM connect burst (ms). End-to-end latency grows by the burst, and
/// the stream's ring must hold this much on top of [`MAX_JITTER_BUFFER_MS`].
pub const MAX_PCM_CONNECT_BURST_MS: u64 = 2000;

/// The speaker head start (PCM connect burst) steps a speaker notice may
/// suggest, in ms, ending at [`MAX_PCM_CONNECT_BURST_MS`]. A speaker that
/// would need more than the last step gets the no-remedy notice instead.
pub const HEAD_START_LADDER_MS: [u32; 6] = [250, 500, 750, 1000, 1500, 2000];

/// Ring buffer frames a PCM stream keeps for late-joining connections, at
/// `frame_duration_ms`: enough for the largest connect burst plus the largest
/// jitter buffer, each rounded up to whole frames the way the cadence rounds
/// them, so neither setting is silently capped by the ring.
pub const fn pcm_ring_frames(frame_duration_ms: u32) -> usize {
    let frame_ms = if frame_duration_ms == 0 {
        1
    } else {
        frame_duration_ms as u64
    };
    (MAX_PCM_CONNECT_BURST_MS.div_ceil(frame_ms) + MAX_JITTER_BUFFER_MS.div_ceil(frame_ms)) as usize
}
