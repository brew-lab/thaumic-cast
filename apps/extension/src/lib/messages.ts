import {
  EncoderConfig,
  StreamMetadata,
  SonosStateSnapshot,
  BroadcastEvent,
  TabMediaState,
  ActiveCast,
  TransportState,
} from '@thaumic-cast/protocol';

/**
 * Internal message types for extension communication.
 */
export type ExtensionMessageType =
  | 'START_CAST'
  | 'STOP_CAST'
  | 'GET_CAST_STATUS'
  | 'GET_SONOS_STATE'
  | 'GET_CONNECTION_STATUS'
  | 'START_CAPTURE'
  | 'STOP_CAPTURE'
  | 'START_PLAYBACK'
  | 'METADATA_UPDATE'
  // Metadata messages (content → background → offscreen)
  | 'TAB_METADATA_UPDATE'
  | 'REQUEST_METADATA'
  // Popup queries (popup → background)
  | 'GET_CURRENT_TAB_STATE'
  | 'GET_ACTIVE_CASTS'
  // Popup notifications (background → popup)
  | 'TAB_STATE_CHANGED'
  | 'ACTIVE_CASTS_CHANGED'
  | 'CAST_AUTO_STOPPED'
  // WebSocket control messages (background ↔ offscreen)
  | 'WS_CONNECT'
  | 'WS_DISCONNECT'
  | 'WS_RECONNECT'
  | 'GET_WS_STATUS'
  | 'SYNC_SONOS_STATE'
  // WebSocket status messages (offscreen → background)
  | 'WS_CONNECTED'
  | 'WS_DISCONNECTED'
  | 'WS_PERMANENTLY_DISCONNECTED'
  | 'SONOS_EVENT'
  // State update messages (background → popup)
  | 'WS_STATE_CHANGED'
  | 'VOLUME_UPDATE'
  | 'MUTE_UPDATE'
  | 'TRANSPORT_STATE_UPDATE'
  | 'WS_CONNECTION_LOST'
  // Control commands (popup → background → offscreen)
  | 'SET_VOLUME'
  | 'SET_MUTE'
  // Offscreen lifecycle
  | 'OFFSCREEN_READY'
  // Session health (offscreen → background)
  | 'SESSION_HEALTH';

/**
 * Message payload for starting a cast.
 */
export interface StartCastMessage {
  type: 'START_CAST';
  payload: {
    speakerIp: string;
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
 * Message payload for starting playback on a Sonos speaker.
 * Sent from background to offscreen, which forwards via WebSocket.
 */
export interface StartPlaybackMessage {
  type: 'START_PLAYBACK';
  payload: {
    tabId: number;
    speakerIp: string;
    /** Optional initial metadata to display on Sonos. */
    metadata?: StreamMetadata;
  };
}

/**
 * Response to START_PLAYBACK message.
 */
export interface StartPlaybackResponse {
  success: boolean;
  speakerIp?: string;
  streamUrl?: string;
  error?: string;
}

/**
 * Session health report sent from offscreen to background when a session ends.
 * Used to record whether the session was stable (for config learning).
 */
export interface SessionHealthMessage {
  type: 'SESSION_HEALTH';
  payload: {
    tabId: number;
    encoderConfig: EncoderConfig;
    /** Whether any audio drops occurred during the session. */
    hadDrops: boolean;
    /** Total samples dropped by producer (buffer overflow). */
    totalProducerDrops: number;
    /** Total samples dropped by consumer catch-up. */
    totalCatchUpDrops: number;
    /** Total frames dropped due to backpressure. */
    totalConsumerDrops: number;
    /** Total underflows (source starvation events). */
    totalUnderflows: number;
  };
}

/**
 * Message payload for metadata updates from content script to background.
 * Contains only the track metadata.
 */
export interface ContentMetadataMessage {
  type: 'METADATA_UPDATE';
  payload: StreamMetadata;
}

/**
 * Message payload for metadata updates from background to offscreen.
 * Uses nested structure with tabId and metadata separated.
 */
export interface OffscreenMetadataMessage {
  type: 'METADATA_UPDATE';
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
 */
export interface TabMetadataUpdateMessage {
  type: 'TAB_METADATA_UPDATE';
  payload: StreamMetadata;
}

/**
 * Request for content script to refresh and send metadata.
 */
export interface RequestMetadataMessage {
  type: 'REQUEST_METADATA';
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
  connected: boolean;
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
 */
export interface CastAutoStoppedMessage {
  type: 'CAST_AUTO_STOPPED';
  tabId: number;
  speakerIp: string;
  reason: 'source_changed' | 'playback_stopped' | 'stream_ended';
  message: string;
}

/**
 * WebSocket connection lost notification.
 */
export interface WsConnectionLostMessage {
  type: 'WS_CONNECTION_LOST';
  reason: string;
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

// ─────────────────────────────────────────────────────────────────────────────
// Updated Union Type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Union of all internal extension messages.
 */
export type ExtensionMessage =
  | StartCastMessage
  | StopCastMessage
  | GetCastStatusMessage
  | GetSonosStateMessage
  | GetConnectionStatusMessage
  | StartCaptureMessage
  | StopCaptureMessage
  | StartPlaybackMessage
  | ContentMetadataMessage
  // Tab metadata messages
  | TabMetadataUpdateMessage
  | RequestMetadataMessage
  // Popup query messages
  | GetCurrentTabStateMessage
  | GetActiveCastsMessage
  // Popup notification messages
  | TabStateChangedMessage
  | ActiveCastsChangedMessage
  | CastAutoStoppedMessage
  // WebSocket messages
  | WsConnectMessage
  | WsDisconnectMessage
  | WsReconnectMessage
  | GetWsStatusMessage
  | SyncSonosStateMessage
  | WsConnectedMessage
  | WsDisconnectedMessage
  | WsPermanentlyDisconnectedMessage
  | SonosEventMessage
  | OffscreenReadyMessage
  | WsStateChangedMessage
  | VolumeUpdateMessage
  | MuteUpdateMessage
  | TransportStateUpdateMessage
  | WsConnectionLostMessage
  | SetVolumeMessage
  | SetMuteMessage
  // Session health
  | SessionHealthMessage;
