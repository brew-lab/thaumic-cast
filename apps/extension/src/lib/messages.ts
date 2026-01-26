/**
 * Extension Message Types
 *
 * Re-exports message types from message-schemas.ts and defines
 * directional union types for type-safe message passing.
 *
 * All individual message types are defined as Zod schemas in message-schemas.ts,
 * which is the SINGLE SOURCE OF TRUTH. Types are derived via z.infer<>.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Re-export all message types from schemas (single source of truth)
// ─────────────────────────────────────────────────────────────────────────────

export {
  // Primitive schemas (for validation)
  SpeakerIpSchema,
  TabIdSchema,
  VolumeSchema,

  // Raw media state
  RawMediaStateSchema,
  type RawMediaState,

  // Cast messages
  StartCastMessageSchema,
  type StartCastMessage,
  StopCastMessageSchema,
  type StopCastMessage,
  RemoveSpeakerMessageSchema,
  type RemoveSpeakerMessage,
  StartCaptureMessageSchema,
  type StartCaptureMessage,
  StopCaptureMessageSchema,
  type StopCaptureMessage,
  StartPlaybackMessageSchema,
  type StartPlaybackMessage,
  StartPlaybackResponseSchema,
  type StartPlaybackResponse,
  OffscreenMetadataMessageSchema,
  type OffscreenMetadataMessage,

  // Tab metadata messages
  TabMetadataUpdateMessageSchema,
  type TabMetadataUpdateMessage,
  RequestMetadataMessageSchema,
  type RequestMetadataMessage,
  TabOgImageMessageSchema,
  type TabOgImageMessage,

  // Connection status messages
  GetCurrentTabStateMessageSchema,
  type GetCurrentTabStateMessage,
  CurrentTabStateResponseSchema,
  type CurrentTabStateResponse,
  GetActiveCastsMessageSchema,
  type GetActiveCastsMessage,
  ActiveCastsResponseSchema,
  type ActiveCastsResponse,
  EnsureConnectionMessageSchema,
  type EnsureConnectionMessage,
  EnsureConnectionResponseSchema,
  type EnsureConnectionResponse,

  // Popup notification messages
  TabStateChangedMessageSchema,
  type TabStateChangedMessage,
  ActiveCastsChangedMessageSchema,
  type ActiveCastsChangedMessage,
  ExtensionResponseSchema,
  type ExtensionResponse,

  // WebSocket control messages
  WsConnectMessageSchema,
  type WsConnectMessage,
  WsDisconnectMessageSchema,
  type WsDisconnectMessage,
  WsReconnectMessageSchema,
  type WsReconnectMessage,
  GetWsStatusMessageSchema,
  type GetWsStatusMessage,
  WsStatusResponseSchema,
  type WsStatusResponse,
  SyncSonosStateMessageSchema,
  type SyncSonosStateMessage,

  // WebSocket status messages
  WsConnectedMessageSchema,
  type WsConnectedMessage,
  WsDisconnectedMessageSchema,
  type WsDisconnectedMessage,
  WsPermanentlyDisconnectedMessageSchema,
  type WsPermanentlyDisconnectedMessage,
  SonosEventMessageSchema,
  type SonosEventMessage,
  OffscreenReadyMessageSchema,
  type OffscreenReadyMessage,
  SessionDisconnectedMessageSchema,
  type SessionDisconnectedMessage,

  // State update messages
  GetSonosStateMessageSchema,
  type GetSonosStateMessage,
  SonosStateResponseSchema,
  type SonosStateResponse,
  WsStateChangedMessageSchema,
  type WsStateChangedMessage,
  VolumeUpdateMessageSchema,
  type VolumeUpdateMessage,
  MuteUpdateMessageSchema,
  type MuteUpdateMessage,
  TransportStateUpdateMessageSchema,
  type TransportStateUpdateMessage,
  SpeakerRemovalReasonSchema,
  type SpeakerRemovalReason,
  CastAutoStopReasonSchema,
  type CastAutoStopReason,
  CastAutoStoppedMessageSchema,
  type CastAutoStoppedMessage,
  SpeakerRemovedMessageSchema,
  type SpeakerRemovedMessage,
  SpeakerStopFailedMessageSchema,
  type SpeakerStopFailedMessage,
  WsConnectionLostMessageSchema,
  type WsConnectionLostMessage,
  ConnectionAttemptFailedMessageSchema,
  type ConnectionAttemptFailedMessage,
  NetworkHealthStatusSchema,
  type NetworkHealthStatus,
  NetworkEventMessageSchema,
  type NetworkEventMessage,
  NetworkHealthChangedMessageSchema,
  type NetworkHealthChangedMessage,
  LatencyUpdateMessageSchema,
  type LatencyUpdateMessage,
  LatencyStaleMessageSchema,
  type LatencyStaleMessage,
  LatencyEventMessageSchema,
  type LatencyEventMessage,
  TopologyEventMessageSchema,
  type TopologyEventMessage,

  // Control commands
  SetVolumeMessageSchema,
  type SetVolumeMessage,
  SetOriginalGroupVolumeMessageSchema,
  type SetOriginalGroupVolumeMessage,
  SetMuteMessageSchema,
  type SetMuteMessage,
  StopPlaybackSpeakerMessageSchema,
  type StopPlaybackSpeakerMessage,
  ControlMediaMessageSchema,
  type ControlMediaMessage,
  ContentControlMediaMessageSchema,
  type ContentControlMediaMessage,

  // Codec detection
  DetectCodecsMessageSchema,
  type DetectCodecsMessage,

  // Video sync messages
  SetVideoSyncEnabledMessageSchema,
  type SetVideoSyncEnabledMessage,
  SetVideoSyncTrimMessageSchema,
  type SetVideoSyncTrimMessage,
  TriggerResyncMessageSchema,
  type TriggerResyncMessage,
  GetVideoSyncStateMessageSchema,
  type GetVideoSyncStateMessage,
  VideoSyncStateSchema,
  type VideoSyncState,
  VideoSyncStateChangedMessageSchema,
  type VideoSyncStateChangedMessage,

  // Simple query messages
  GetCastStatusMessageSchema,
  type GetCastStatusMessage,
  GetConnectionStatusMessageSchema,
  type GetConnectionStatusMessage,
} from './message-schemas';

// Import types needed for union definitions
import type {
  StartCastMessage,
  StopCastMessage,
  RemoveSpeakerMessage,
  GetSonosStateMessage,
  GetActiveCastsMessage,
  EnsureConnectionMessage,
  SetVolumeMessage,
  SetOriginalGroupVolumeMessage,
  SetMuteMessage,
  ControlMediaMessage,
  SetVideoSyncEnabledMessage,
  SetVideoSyncTrimMessage,
  TriggerResyncMessage,
  GetVideoSyncStateMessage,
  WsConnectMessage,
  WsDisconnectMessage,
  WsReconnectMessage,
  TabStateChangedMessage,
  ActiveCastsChangedMessage,
  CastAutoStoppedMessage,
  SpeakerRemovedMessage,
  SpeakerStopFailedMessage,
  WsStateChangedMessage,
  VolumeUpdateMessage,
  MuteUpdateMessage,
  TransportStateUpdateMessage,
  WsConnectionLostMessage,
  ConnectionAttemptFailedMessage,
  NetworkHealthChangedMessage,
  LatencyUpdateMessage,
  LatencyStaleMessage,
  VideoSyncStateChangedMessage,
  TabMetadataUpdateMessage,
  TabOgImageMessage,
  RequestMetadataMessage,
  ContentControlMediaMessage,
  LatencyEventMessage,
  StartCaptureMessage,
  StopCaptureMessage,
  StartPlaybackMessage,
  OffscreenMetadataMessage,
  GetWsStatusMessage,
  SyncSonosStateMessage,
  DetectCodecsMessage,
  StopPlaybackSpeakerMessage,
  WsConnectedMessage,
  WsDisconnectedMessage,
  WsPermanentlyDisconnectedMessage,
  SonosEventMessage,
  NetworkEventMessage,
  TopologyEventMessage,
  OffscreenReadyMessage,
  SessionDisconnectedMessage,
} from './message-schemas';

// ─────────────────────────────────────────────────────────────────────────────
// Message Type Constants (organized by direction)
// ─────────────────────────────────────────────────────────────────────────────

/** Message types: Popup → Background */
export type PopupToBackgroundType =
  | 'START_CAST'
  | 'STOP_CAST'
  | 'REMOVE_SPEAKER'
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
  | 'SPEAKER_STOP_FAILED'
  | 'WS_STATE_CHANGED'
  | 'VOLUME_UPDATE'
  | 'MUTE_UPDATE'
  | 'TRANSPORT_STATE_UPDATE'
  | 'WS_CONNECTION_LOST'
  | 'CONNECTION_ATTEMPT_FAILED'
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
  | 'SET_MUTE'
  | 'STOP_PLAYBACK_SPEAKER';

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
  | RemoveSpeakerMessage
  | { type: 'GET_CAST_STATUS' }
  | GetSonosStateMessage
  | { type: 'GET_CONNECTION_STATUS' }
  | { type: 'GET_CURRENT_TAB_STATE' }
  | GetActiveCastsMessage
  | EnsureConnectionMessage
  | SetVolumeMessage
  | SetOriginalGroupVolumeMessage
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
  | SpeakerStopFailedMessage
  | WsStateChangedMessage
  | VolumeUpdateMessage
  | MuteUpdateMessage
  | TransportStateUpdateMessage
  | WsConnectionLostMessage
  | ConnectionAttemptFailedMessage
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
  | SetMuteMessage
  | SetOriginalGroupVolumeMessage
  | StopPlaybackSpeakerMessage;

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
