//! Generated Rust types from OpenAPI schema.
//!
//! DO NOT EDIT - regenerate with `bun run codegen`
//!
//! This file is auto-generated from packages/protocol/openapi.yaml

use serde::{Deserialize, Serialize};

// ============ Enums ============

/// Audio quality preset for streaming
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum QualityPreset {
    #[serde(rename = "ultra-low")]
    UltraLow,
    #[serde(rename = "low")]
    Low,
    #[serde(rename = "medium")]
    Medium,
    #[serde(rename = "high")]
    High,
}

/// Audio codec for encoding
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AudioCodec {
    #[serde(rename = "he-aac")]
    HeAac,
    #[serde(rename = "aac-lc")]
    AacLc,
    #[serde(rename = "mp3")]
    Mp3,
}

/// Current status of a stream
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum StreamStatus {
    #[serde(rename = "starting")]
    Starting,
    #[serde(rename = "active")]
    Active,
    #[serde(rename = "stopped")]
    Stopped,
    #[serde(rename = "error")]
    Error,
}

/// Sonos connection mode (cloud API vs local UPnP)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SonosMode {
    #[serde(rename = "cloud")]
    Cloud,
    #[serde(rename = "local")]
    Local,
}

/// UPnP AVTransport transport states
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TransportState {
    #[serde(rename = "PLAYING")]
    Playing,
    #[serde(rename = "PAUSED_PLAYBACK")]
    PausedPlayback,
    #[serde(rename = "STOPPED")]
    Stopped,
    #[serde(rename = "TRANSITIONING")]
    Transitioning,
}

/// Sonos UPnP services for GENA subscriptions
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum GenaService {
    #[serde(rename = "AVTransport")]
    AVTransport,
    #[serde(rename = "ZoneGroupTopology")]
    ZoneGroupTopology,
    #[serde(rename = "GroupRenderingControl")]
    GroupRenderingControl,
}

/// Structured error codes for error handling
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ErrorCode {
    #[serde(rename = "NETWORK_TIMEOUT")]
    NetworkTimeout,
    #[serde(rename = "NETWORK_UNREACHABLE")]
    NetworkUnreachable,
    #[serde(rename = "CONNECTION_REFUSED")]
    ConnectionRefused,
    #[serde(rename = "SPEAKER_NOT_FOUND")]
    SpeakerNotFound,
    #[serde(rename = "SPEAKER_UNREACHABLE")]
    SpeakerUnreachable,
    #[serde(rename = "DISCOVERY_FAILED")]
    DiscoveryFailed,
    #[serde(rename = "PLAYBACK_FAILED")]
    PlaybackFailed,
    #[serde(rename = "INVALID_STREAM_URL")]
    InvalidStreamUrl,
    #[serde(rename = "INVALID_IP_ADDRESS")]
    InvalidIpAddress,
    #[serde(rename = "INVALID_URL")]
    InvalidUrl,
    #[serde(rename = "INVALID_REQUEST")]
    InvalidRequest,
    #[serde(rename = "UNAUTHORIZED")]
    Unauthorized,
    #[serde(rename = "SESSION_EXPIRED")]
    SessionExpired,
    #[serde(rename = "UNKNOWN_ERROR")]
    UnknownError,
}

// ============ Structs ============

/// Stream metadata for Sonos display (ICY metadata)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StreamMetadata {
    /// Song title or tab title
    pub title: Option<String>,
    /// Artist name
    pub artist: Option<String>,
    /// Album name
    pub album: Option<String>,
    /// Album art URL
    pub artwork: Option<String>,
}

/// Minimal speaker info from SSDP discovery
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Speaker {
    /// Unique identifier from SSDP
    pub uuid: String,
    /// Local IP address
    pub ip: String,
}

/// Full speaker info including zone name and model
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSpeaker {
    /// Unique identifier from zone topology
    pub uuid: String,
    /// Local IP address
    pub ip: String,
    /// User-configured room name
    pub zone_name: String,
    /// Sonos device model (e.g., "Sonos One")
    pub model: String,
}

/// Sonos zone group with coordinator and members
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalGroup {
    /// Zone group identifier
    pub id: String,
    /// Coordinator's zone name
    pub name: String,
    /// UUID of the group coordinator
    pub coordinator_uuid: String,
    /// IP address of the group coordinator
    pub coordinator_ip: String,
    /// Speakers in this group
    pub members: Vec<LocalSpeaker>,
}

/// Sonos group from cloud API
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SonosGroup {
    /// Cloud API group identifier
    pub id: String,
    /// Group display name
    pub name: String,
}

/// Runtime status of a Sonos group from GENA events
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupStatus {
    /// IP address of the group coordinator
    pub coordinator_ip: String,
    pub transport_state: TransportState,
    /// Current track/source URI
    pub current_uri: Option<String>,
    /// True if playing our stream, false if playing other source, null if unknown
    pub is_playing_our_stream: Option<bool>,
}

/// Complete Sonos state snapshot emitted on any change
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SonosStateSnapshot {
    /// Zone groups with their members
    pub groups: Vec<LocalGroup>,
    /// Runtime status for each group coordinator
    pub group_statuses: Vec<GroupStatus>,
    /// Number of Sonos devices from last discovery
    pub discovered_devices: u64,
    /// Number of active GENA subscriptions
    pub gena_subscriptions: u64,
    /// Unix timestamp of last successful speaker discovery
    pub last_discovery_at: Option<u64>,
    /// True while SSDP discovery is running
    pub is_discovering: bool,
}

/// Request to create a new audio stream
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateStreamRequest {
    pub group_id: String,
    pub quality: QualityPreset,
    pub metadata: Option<StreamMetadata>,
    pub codec: Option<AudioCodec>,
}

/// Response after creating a stream
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateStreamResponse {
    pub stream_id: String,
    /// WebSocket URL for audio ingest
    pub ingest_url: String,
    /// HTTP URL for stream playback
    pub playback_url: String,
    /// Non-fatal issues (e.g., GENA subscription failed)
    pub warning: Option<String>,
}

/// GET /api/me response
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    pub user: Option<MeResponseUser>,
    pub sonos_linked: bool,
}

/// GET /api/sonos/status response
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SonosStatusResponse {
    pub linked: bool,
    pub household_id: Option<String>,
}

/// GET /api/sonos/groups response (cloud API)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SonosGroupsResponse {
    pub household_id: String,
    pub groups: Vec<SonosGroup>,
}

/// GET /api/local/discover response
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LocalDiscoveryResponse {
    pub speakers: Vec<Speaker>,
}

/// GET /api/local/groups response
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LocalGroupsResponse {
    pub groups: Vec<LocalGroup>,
}

/// Basic API error response
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApiError {
    pub error: String,
    pub message: String,
}

/// Enhanced API error response with structured code
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApiErrorResponse {
    pub error: String,
    pub message: String,
    pub code: Option<ErrorCode>,
    pub details: Option<serde_json::Map<String, serde_json::Value>>,
}

/// GENA subscription info stored per speaker/service
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenaSubscription {
    /// Subscription ID from SUBSCRIBE response
    pub sid: String,
    pub speaker_ip: String,
    pub service: GenaService,
    /// Unix timestamp when subscription expires
    pub expires_at: u64,
    pub callback_path: String,
}

/// Tauri get_status command response
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatusResponse {
    pub server_running: bool,
    /// HTTP server port
    pub port: u16,
    /// GENA listener port (null if not started)
    pub gena_port: Option<u16>,
    /// Local network IP address
    pub local_ip: Option<String>,
    pub active_streams: u64,
    /// Number of Sonos devices from last discovery
    pub discovered_devices: u64,
    /// Number of active GENA subscriptions
    pub gena_subscriptions: u64,
    /// Non-fatal errors encountered during startup
    pub startup_errors: Option<Vec<String>>,
    /// Unix timestamp of last successful speaker discovery
    pub last_discovery_at: Option<u64>,
}

/// Tauri get_config command response
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConfigResponse {
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeResponseUser {
    pub id: String,
    pub email: String,
    pub name: Option<String>,
}

// ============ Discriminated Unions ============

/// Union type for all Sonos events sent via WebSocket
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SonosEvent {
    #[serde(rename = "transportState")]
    TransportState {
        state: TransportState,
        #[serde(rename = "speakerIp")]
        speaker_ip: String,
        timestamp: u64,
    },
    #[serde(rename = "zoneChange")]
    ZoneChange {
        timestamp: u64,
    },
    #[serde(rename = "sourceChanged")]
    SourceChanged {
        #[serde(rename = "currentUri")]
        current_uri: String,
        #[serde(rename = "expectedUri")]
        expected_uri: Option<String>,
        #[serde(rename = "speakerIp")]
        speaker_ip: String,
        timestamp: u64,
    },
    #[serde(rename = "groupVolume")]
    GroupVolume {
        volume: u8,
        #[serde(rename = "speakerIp")]
        speaker_ip: String,
        timestamp: u64,
    },
    #[serde(rename = "groupMute")]
    GroupMute {
        mute: bool,
        #[serde(rename = "speakerIp")]
        speaker_ip: String,
        timestamp: u64,
    },
}

