import {
  EncoderConfig,
  SonosStateSnapshot,
  BroadcastEvent,
  LatencyBroadcastEvent,
  TabMediaState,
  ActiveCast,
  TransportState,
  MediaAction,
  PlaybackResult,
  StreamMetadata,
} from '@thaumic-cast/protocol';
import type { RawMediaState } from './message-schemas';

// ─────────────────────────────────────────────────────────────────────────────
// Message Type Constants (organized by direction)
// ─────────────────────────────────────────────────────────────────────────────

/** Message types: Popup → Background */
export type PopupToBackgroundType =
  | 'START_CAST'
  | 'STOP_CAST'
  | 'GET_CAST_STATUS'
  | 'GET_SONOS_STATE'
  | 'GET_CONNECTION_STATUS'
  | 'GET_CURRENT_TAB_STATE'
  | 'GET_ACTIVE_CASTS'
  | 'ENSURE_CONNECTION'
  | 'SET_VOLUME'
  | 'SET_MUTE'
  | 'CONTROL_MEDIA'
  | 'SET_VIDEO_SYNC_ENABLED'
  | 'SET_VIDEO_SYNC_TRIM'
  | 'TRIGGER_RESYNC'
  | 'GET_VIDEO_SYNC_STATE'
  | 'WS_CONNECT'
  | 'WS_DISCONNECT'
  | 'WS_RECONNECT';

/** Message types: Background → Popup */
export type BackgroundToPopupType =
  | 'TAB_STATE_CHANGED'
  | 'ACTIVE_CASTS_CHANGED'
  | 'CAST_AUTO_STOPPED'
  | 'SPEAKER_REMOVED'
  | 'WS_STATE_CHANGED'
  | 'VOLUME_UPDATE'
  | 'MUTE_UPDATE'
  | 'TRANSPORT_STATE_UPDATE'
  | 'WS_CONNECTION_LOST'
  | 'NETWORK_HEALTH_CHANGED'
  | 'LATENCY_UPDATE'
  | 'LATENCY_STALE';

/** Message types: Content → Background */
export type ContentToBackgroundType = 'TAB_METADATA_UPDATE' | 'TAB_OG_IMAGE';

/** Message types: Background → Content */
export type BackgroundToContentType =
  | 'REQUEST_METADATA'
  | 'CONTROL_MEDIA'
  | 'SET_VIDEO_SYNC_ENABLED'
  | 'SET_VIDEO_SYNC_TRIM'
  | 'TRIGGER_RESYNC'
  | 'GET_VIDEO_SYNC_STATE'
  | 'LATENCY_EVENT';

/** Message types: Background → Offscreen */
export type BackgroundToOffscreenType =
  | 'START_CAPTURE'
  | 'STOP_CAPTURE'
  | 'START_PLAYBACK'
  | 'OFFSCREEN_METADATA_UPDATE'
  | 'WS_CONNECT'
  | 'WS_DISCONNECT'
  | 'WS_RECONNECT'
  | 'GET_WS_STATUS'
  | 'SYNC_SONOS_STATE'
  | 'DETECT_CODECS'
  | 'SET_VOLUME'
  | 'SET_MUTE';

/** Message types: Offscreen → Background */
export type OffscreenToBackgroundType =
  | 'WS_CONNECTED'
  | 'WS_DISCONNECTED'
  | 'WS_PERMANENTLY_DISCONNECTED'
  | 'SONOS_EVENT'
  | 'NETWORK_EVENT'
  | 'TOPOLOGY_EVENT'
  | 'OFFSCREEN_READY'
  | 'SESSION_DISCONNECTED';

/** Message types: Content broadcast */
export type ContentBroadcastType = 'VIDEO_SYNC_STATE_CHANGED';

/**
 * Message payload for starting a cast.
 * Supports multi-group casting via speakerIps array.
 */
export interface StartCastMessage {
  type: 'START_CAST';
  payload: {
    /** Target speaker IP addresses (multi-group support). */
    speakerIps: string[];
    /**
     * Encoder configuration. If omitted, background will auto-select
     * based on device capabilities and past session history.
     */
    encoderConfig?: EncoderConfig;
  };
}

/**
 * Message payload for stopping a cast.
 */
export interface StopCastMessage {
  type: 'STOP_CAST';
  payload?: {
    tabId?: number;
  };
}

/**
 * Message payload for getting cast status.
 */
export interface GetCastStatusMessage {
  type: 'GET_CAST_STATUS';
}

/**
 * Message payload for starting audio capture in offscreen.
 */
export interface StartCaptureMessage {
  type: 'START_CAPTURE';
  payload: {
    tabId: number;
    mediaStreamId: string;
    encoderConfig: EncoderConfig;
    baseUrl: string;
  };
}

/**
 * Message payload for stopping audio capture in offscreen.
 */
export interface StopCaptureMessage {
  type: 'STOP_CAPTURE';
  payload: {
    tabId: number;
  };
}

/**
 * Message payload for starting playback on Sonos speakers.
 * Sent from background to offscreen, which forwards via WebSocket.
 * Supports multi-group casting via speakerIps array.
 */
export interface StartPlaybackMessage {
  type: 'START_PLAYBACK';
  payload: {
    tabId: number;
    /** Target speaker IP addresses (multi-group support). */
    speakerIps: string[];
    /** Optional initial metadata to display on Sonos. */
    metadata?: StreamMetadata;
  };
}

/**
 * Response to START_PLAYBACK message.
 * Contains per-speaker results for multi-group casting.
 */
export interface StartPlaybackResponse {
  /** Overall success (at least one speaker started). */
  success: boolean;
  /** Per-speaker playback results. */
  results: PlaybackResult[];
  /** Overall error (if all speakers failed). */
  error?: string;
}

/**
 * Message payload for metadata updates from background to offscreen.
 * Uses nested structure with tabId and metadata separated.
 */
export interface OffscreenMetadataMessage {
  type: 'OFFSCREEN_METADATA_UPDATE';
  payload: {
    tabId: number;
    metadata: StreamMetadata;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab Metadata Messages (content → background)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Metadata update from content script (via bridge) to background.
 * Uses TAB_METADATA_UPDATE to distinguish from offscreen messages.
 * Payload includes supportedActions and playbackState from MediaSession.
 */
export interface TabMetadataUpdateMessage {
  type: 'TAB_METADATA_UPDATE';
  payload: RawMediaState | null;
}

/**
 * Request for content script to refresh and send metadata.
 */
export interface RequestMetadataMessage {
  type: 'REQUEST_METADATA';
}

/**
 * Open Graph image update from content script.
 */
export interface TabOgImageMessage {
  type: 'TAB_OG_IMAGE';
  payload: {
    ogImage: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection Status Messages (popup → background)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query for cached connection status.
 */
export interface GetConnectionStatusMessage {
  type: 'GET_CONNECTION_STATUS';
}

// ─────────────────────────────────────────────────────────────────────────────
// Popup Query Messages (popup → background)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query for current tab's media state.
 */
export interface GetCurrentTabStateMessage {
  type: 'GET_CURRENT_TAB_STATE';
}

/**
 * Response to GET_CURRENT_TAB_STATE.
 */
export interface CurrentTabStateResponse {
  state: TabMediaState | null;
  isCasting: boolean;
}

/**
 * Query for all active cast sessions.
 */
export interface GetActiveCastsMessage {
  type: 'GET_ACTIVE_CASTS';
}

/**
 * Response to GET_ACTIVE_CASTS.
 */
export interface ActiveCastsResponse {
  casts: ActiveCast[];
}

/**
 * Request background to ensure connection to desktop app.
 * Background handles discovery and WebSocket connection.
 */
export interface EnsureConnectionMessage {
  type: 'ENSURE_CONNECTION';
}

/**
 * Response to ENSURE_CONNECTION.
 * Background discovers and connects if needed, returns current state.
 */
export interface EnsureConnectionResponse {
  /** Whether connection is now established */
  connected: boolean;
  /** Desktop app URL if discovered */
  desktopAppUrl: string | null;
  /** Maximum concurrent streams allowed */
  maxStreams: number | null;
  /** Error message if connection failed */
  error: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Popup Notification Messages (background → popup)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notification when current tab's state changes.
 */
export interface TabStateChangedMessage {
  type: 'TAB_STATE_CHANGED';
  tabId: number;
  state: TabMediaState;
}

/**
 * Notification when active casts list changes.
 */
export interface ActiveCastsChangedMessage {
  type: 'ACTIVE_CASTS_CHANGED';
  casts: ActiveCast[];
}

/**
 * Response format for internal messages.
 */
export interface ExtensionResponse {
  success: boolean;
  streamId?: string;
  error?: string;
  isActive?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Control Messages (background ↔ offscreen)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Request to connect WebSocket to desktop app.
 */
export interface WsConnectMessage {
  type: 'WS_CONNECT';
  url: string;
}

/**
 * Request to disconnect WebSocket.
 */
export interface WsDisconnectMessage {
  type: 'WS_DISCONNECT';
}

/**
 * Request to reconnect WebSocket (resets retry counter).
 */
export interface WsReconnectMessage {
  type: 'WS_RECONNECT';
  url?: string;
}

/**
 * Query current WebSocket status from offscreen.
 */
export interface GetWsStatusMessage {
  type: 'GET_WS_STATUS';
}

/**
 * Response to GET_WS_STATUS.
 */
export interface WsStatusResponse {
  connected: boolean;
  url?: string;
  reconnectAttempts?: number;
  state?: SonosStateSnapshot;
}

/**
 * Sync Sonos state to offscreen for caching.
 */
export interface SyncSonosStateMessage {
  type: 'SYNC_SONOS_STATE';
  state: SonosStateSnapshot;
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Status Messages (offscreen → background)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WebSocket connected with initial state.
 */
export interface WsConnectedMessage {
  type: 'WS_CONNECTED';
  state: SonosStateSnapshot;
}

/**
 * WebSocket disconnected (will attempt reconnect).
 */
export interface WsDisconnectedMessage {
  type: 'WS_DISCONNECTED';
}

/**
 * WebSocket permanently disconnected after max retries.
 */
export interface WsPermanentlyDisconnectedMessage {
  type: 'WS_PERMANENTLY_DISCONNECTED';
}

/**
 * Sonos event received from desktop app.
 */
export interface SonosEventMessage {
  type: 'SONOS_EVENT';
  payload: BroadcastEvent;
}

/**
 * Offscreen document is ready.
 */
export interface OffscreenReadyMessage {
  type: 'OFFSCREEN_READY';
}

/**
 * Session disconnected unexpectedly (worker WebSocket closed).
 * Sent from offscreen to background to clean up session state.
 */
export interface SessionDisconnectedMessage {
  type: 'SESSION_DISCONNECTED';
  tabId: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// State Update Messages (background → popup)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get current Sonos state from background.
 */
export interface GetSonosStateMessage {
  type: 'GET_SONOS_STATE';
}

/**
 * Response to GET_SONOS_STATE.
 */
export interface SonosStateResponse {
  state: SonosStateSnapshot | null;
}

/**
 * Full state update (sent on connect or major changes).
 */
export interface WsStateChangedMessage {
  type: 'WS_STATE_CHANGED';
  state: SonosStateSnapshot;
}

/**
 * Volume update for a specific speaker.
 */
export interface VolumeUpdateMessage {
  type: 'VOLUME_UPDATE';
  speakerIp: string;
  volume: number;
}

/**
 * Mute update for a specific speaker.
 */
export interface MuteUpdateMessage {
  type: 'MUTE_UPDATE';
  speakerIp: string;
  muted: boolean;
}

/**
 * Transport state update for a specific speaker.
 */
export interface TransportStateUpdateMessage {
  type: 'TRANSPORT_STATE_UPDATE';
  speakerIp: string;
  state: TransportState;
}

/**
 * Cast was automatically stopped (e.g., user switched Sonos source).
 * The popup translates the reason code to a localized message.
 */
export interface CastAutoStoppedMessage {
  type: 'CAST_AUTO_STOPPED';
  tabId: number;
  speakerIp: string;
  reason: 'source_changed' | 'playback_stopped' | 'stream_ended';
}

/**
 * A speaker was removed from an active cast (multi-group partial removal).
 * The cast continues with remaining speakers.
 */
export interface SpeakerRemovedMessage {
  type: 'SPEAKER_REMOVED';
  tabId: number;
  speakerIp: string;
  reason: 'source_changed' | 'playback_stopped';
}

/**
 * WebSocket connection lost notification.
 */
export interface WsConnectionLostMessage {
  type: 'WS_CONNECTION_LOST';
  reason: string;
}

/**
 * Network health status from desktop app.
 */
export type NetworkHealthStatus = 'ok' | 'degraded';

/**
 * Network event from desktop app (offscreen → background).
 */
export interface NetworkEventMessage {
  type: 'NETWORK_EVENT';
  payload: {
    type: 'healthChanged';
    health: NetworkHealthStatus;
    reason?: string;
    timestamp: number;
  };
}

/**
 * Network health changed notification (background → popup).
 */
export interface NetworkHealthChangedMessage {
  type: 'NETWORK_HEALTH_CHANGED';
  health: NetworkHealthStatus;
  reason: string | null;
}

/**
 * Latency measurement update (background → popup).
 */
export interface LatencyUpdateMessage {
  type: 'LATENCY_UPDATE';
  streamId: string;
  speakerIp: string;
  epochId: number;
  latencyMs: number;
  jitterMs: number;
  confidence: number;
}

/**
 * Latency measurement stale notification (background → popup).
 */
export interface LatencyStaleMessage {
  type: 'LATENCY_STALE';
  streamId: string;
  speakerIp: string;
  epochId: number;
}

/**
 * Latency event forwarded to content script (background → content).
 */
export interface LatencyEventMessage {
  type: 'LATENCY_EVENT';
  payload: LatencyBroadcastEvent;
}

/**
 * Topology event from desktop app (offscreen → background).
 */
export interface TopologyEventMessage {
  type: 'TOPOLOGY_EVENT';
  payload: {
    type: 'groupsDiscovered';
    groups: SonosStateSnapshot['groups'];
    timestamp: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Control Commands (popup → background → offscreen → desktop)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Set volume for a speaker group.
 */
export interface SetVolumeMessage {
  type: 'SET_VOLUME';
  speakerIp: string;
  volume: number;
}

/**
 * Set mute state for a speaker group.
 */
export interface SetMuteMessage {
  type: 'SET_MUTE';
  speakerIp: string;
  muted: boolean;
}

/**
 * Control media playback on a specific tab.
 * Sent from popup to background, which forwards to content script.
 */
export interface ControlMediaMessage {
  type: 'CONTROL_MEDIA';
  payload: {
    tabId: number;
    action: MediaAction;
  };
}

/**
 * Control media message sent to content script (background → content).
 * Note: Different shape from ControlMediaMessage - no payload wrapper.
 */
export interface ContentControlMediaMessage {
  type: 'CONTROL_MEDIA';
  action: MediaAction;
}

// ─────────────────────────────────────────────────────────────────────────────
// Codec Detection Messages (background → offscreen)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Message to request codec detection from offscreen document.
 * AudioEncoder is only available in window contexts, not service workers.
 */
export interface DetectCodecsMessage {
  type: 'DETECT_CODECS';
}

// ─────────────────────────────────────────────────────────────────────────────
// Video Sync Messages (popup → background → content)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enable/disable video sync for a specific tab.
 */
export interface SetVideoSyncEnabledMessage {
  type: 'SET_VIDEO_SYNC_ENABLED';
  payload: {
    tabId: number;
    enabled: boolean;
  };
}

/**
 * Set the trim adjustment for video sync.
 */
export interface SetVideoSyncTrimMessage {
  type: 'SET_VIDEO_SYNC_TRIM';
  payload: {
    tabId: number;
    trimMs: number;
  };
}

/**
 * Trigger a manual resync for video sync.
 */
export interface TriggerResyncMessage {
  type: 'TRIGGER_RESYNC';
  payload: {
    tabId: number;
  };
}

/**
 * Query the current video sync state.
 */
export interface GetVideoSyncStateMessage {
  type: 'GET_VIDEO_SYNC_STATE';
  payload: {
    tabId: number;
  };
}

/**
 * Broadcast when video sync state changes (content → popup).
 */
export interface VideoSyncStateChangedMessage {
  type: 'VIDEO_SYNC_STATE_CHANGED';
  enabled: boolean;
  trimMs: number;
  state: 'off' | 'acquiring' | 'locked' | 'stale';
  lockedLatencyMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Directional Message Union Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Messages sent from popup to background.
 * Used for cast control, state queries, and settings changes.
 */
export type PopupToBackgroundMessage =
  | StartCastMessage
  | StopCastMessage
  | GetCastStatusMessage
  | GetSonosStateMessage
  | GetConnectionStatusMessage
  | GetCurrentTabStateMessage
  | GetActiveCastsMessage
  | EnsureConnectionMessage
  | SetVolumeMessage
  | SetMuteMessage
  | ControlMediaMessage
  | SetVideoSyncEnabledMessage
  | SetVideoSyncTrimMessage
  | TriggerResyncMessage
  | GetVideoSyncStateMessage
  | WsConnectMessage
  | WsDisconnectMessage
  | WsReconnectMessage;

/**
 * Messages sent from background to popup.
 * Used for state updates and notifications.
 */
export type BackgroundToPopupMessage =
  | TabStateChangedMessage
  | ActiveCastsChangedMessage
  | CastAutoStoppedMessage
  | SpeakerRemovedMessage
  | WsStateChangedMessage
  | VolumeUpdateMessage
  | MuteUpdateMessage
  | TransportStateUpdateMessage
  | WsConnectionLostMessage
  | NetworkHealthChangedMessage
  | LatencyUpdateMessage
  | LatencyStaleMessage
  | VideoSyncStateChangedMessage;

/**
 * Messages sent from content script to background.
 * Used for metadata updates from web pages.
 */
export type ContentToBackgroundMessage = TabMetadataUpdateMessage | TabOgImageMessage;

/**
 * Messages sent from background to content script.
 * Used for media control and video sync commands.
 * Note: Uses ContentControlMediaMessage (no payload wrapper) for content.
 */
export type BackgroundToContentMessage =
  | RequestMetadataMessage
  | ContentControlMediaMessage
  | SetVideoSyncEnabledMessage
  | SetVideoSyncTrimMessage
  | TriggerResyncMessage
  | GetVideoSyncStateMessage
  | LatencyEventMessage;

/**
 * Messages sent from background to offscreen document.
 * Used for capture control, WebSocket management, and codec detection.
 */
export type BackgroundToOffscreenMessage =
  | StartCaptureMessage
  | StopCaptureMessage
  | StartPlaybackMessage
  | OffscreenMetadataMessage
  | WsConnectMessage
  | WsDisconnectMessage
  | WsReconnectMessage
  | GetWsStatusMessage
  | SyncSonosStateMessage
  | DetectCodecsMessage
  | SetVolumeMessage
  | SetMuteMessage;

/**
 * Messages sent from offscreen document to background.
 * Used for WebSocket events, session status, and lifecycle signals.
 */
export type OffscreenToBackgroundMessage =
  | WsConnectedMessage
  | WsDisconnectedMessage
  | WsPermanentlyDisconnectedMessage
  | SonosEventMessage
  | NetworkEventMessage
  | TopologyEventMessage
  | OffscreenReadyMessage
  | SessionDisconnectedMessage;

/**
 * Messages broadcast from content script (video sync state).
 */
export type ContentBroadcastMessage = VideoSyncStateChangedMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Inbound Message Types (for listeners)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Messages that the background service worker receives.
 * From popup, content scripts (including broadcasts), and offscreen document.
 */
export type BackgroundInboundMessage =
  | PopupToBackgroundMessage
  | ContentToBackgroundMessage
  | OffscreenToBackgroundMessage
  | ContentBroadcastMessage;

/**
 * Messages that the offscreen document receives.
 * From background service worker only.
 */
export type OffscreenInboundMessage = BackgroundToOffscreenMessage;
