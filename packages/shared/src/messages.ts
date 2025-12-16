// Extension messaging types between popup, service worker, and offscreen document

import type { QualityPreset, SonosMode, StreamMetadata, WsAction, SonosStateSnapshot } from './api';
import type { SonosEvent } from './events';

// Message types
export type MessageType =
  | 'GET_STATUS'
  | 'START_CAST'
  | 'STOP_CAST'
  | 'OFFSCREEN_START'
  | 'OFFSCREEN_STOP'
  | 'OFFSCREEN_PAUSE'
  | 'OFFSCREEN_RESUME'
  | 'OFFSCREEN_READY'
  | 'CAST_ERROR'
  | 'CAST_ENDED'
  | 'STATUS_UPDATE'
  // Media detection messages
  | 'MEDIA_UPDATE'
  | 'GET_MEDIA_SOURCES'
  | 'MEDIA_SOURCES'
  | 'CONTROL_MEDIA'
  // Sonos event messages (bidirectional sync)
  | 'SONOS_EVENT'
  // Volume/mute updates from GENA
  | 'VOLUME_UPDATE'
  | 'MUTE_UPDATE'
  // WebSocket control messages
  | 'CONNECT_WS' // popup -> background (request connection)
  | 'DISCONNECT_WS' // popup -> background (request disconnection)
  | 'WS_CONNECT' // background -> offscreen (connect to server)
  | 'WS_DISCONNECT' // background -> offscreen (disconnect from server)
  | 'WS_COMMAND' // background -> offscreen (send command)
  | 'WS_RESPONSE' // offscreen -> background (command response)
  | 'WS_CONNECTED' // offscreen -> background (connection established)
  | 'WS_STATE_CHANGED'; // background -> popup (state update)

// Media info from a tab
export interface MediaInfo {
  tabId: number;
  tabTitle: string;
  tabFavicon?: string;
  title?: string;
  artist?: string;
  album?: string;
  artwork?: string;
  isPlaying: boolean;
  lastUpdated: number;
  hasMetadata: boolean; // true if we have rich metadata from Media Session API
}

// Media control actions
export type MediaAction = 'play' | 'pause' | 'previoustrack' | 'nexttrack';

// Base message interface
interface BaseMessage {
  type: MessageType;
}

// GET_STATUS: popup -> service worker
export interface GetStatusMessage extends BaseMessage {
  type: 'GET_STATUS';
}

// START_CAST: popup -> service worker
export interface StartCastMessage extends BaseMessage {
  type: 'START_CAST';
  tabId: number;
  groupId: string;
  groupName: string;
  quality: QualityPreset;
  mediaStreamId: string;
  mode?: SonosMode;
  coordinatorIp?: string; // Only for local mode
  metadata?: StreamMetadata; // Media info for Sonos display
}

// STOP_CAST: popup -> service worker
export interface StopCastMessage extends BaseMessage {
  type: 'STOP_CAST';
  streamId: string;
  mode?: SonosMode;
  coordinatorIp?: string; // Only for local mode
}

// OFFSCREEN_START: service worker -> offscreen
export interface OffscreenStartMessage extends BaseMessage {
  type: 'OFFSCREEN_START';
  streamId: string;
  mediaStreamId: string;
  quality: QualityPreset;
  ingestUrl: string;
}

// OFFSCREEN_STOP: service worker -> offscreen
export interface OffscreenStopMessage extends BaseMessage {
  type: 'OFFSCREEN_STOP';
  streamId: string;
}

// OFFSCREEN_PAUSE: service worker -> offscreen (pause audio capture but keep stream alive)
export interface OffscreenPauseMessage extends BaseMessage {
  type: 'OFFSCREEN_PAUSE';
  streamId: string;
}

// OFFSCREEN_RESUME: service worker -> offscreen (resume audio capture after pause)
export interface OffscreenResumeMessage extends BaseMessage {
  type: 'OFFSCREEN_RESUME';
  streamId: string;
}

// OFFSCREEN_READY: offscreen -> service worker
export interface OffscreenReadyMessage extends BaseMessage {
  type: 'OFFSCREEN_READY';
}

// CAST_ERROR: offscreen -> service worker -> popup
export interface CastErrorMessage extends BaseMessage {
  type: 'CAST_ERROR';
  reason: 'connection_lost' | 'encoding_error' | 'capture_failed' | 'unknown';
  message?: string;
}

// CAST_ENDED: offscreen -> service worker -> popup
export interface CastEndedMessage extends BaseMessage {
  type: 'CAST_ENDED';
  reason: 'tab_closed' | 'user_stopped' | 'server_stopped';
  streamId: string;
}

// STATUS_UPDATE: service worker -> popup
export interface StatusUpdateMessage extends BaseMessage {
  type: 'STATUS_UPDATE';
  status: CastStatus;
}

// MEDIA_UPDATE: content script -> service worker
export interface MediaUpdateMessage extends BaseMessage {
  type: 'MEDIA_UPDATE';
  media: Omit<MediaInfo, 'tabId' | 'tabTitle' | 'tabFavicon'>;
}

// GET_MEDIA_SOURCES: popup -> service worker
export interface GetMediaSourcesMessage extends BaseMessage {
  type: 'GET_MEDIA_SOURCES';
}

// MEDIA_SOURCES: service worker -> popup
export interface MediaSourcesMessage extends BaseMessage {
  type: 'MEDIA_SOURCES';
  sources: MediaInfo[];
}

// CONTROL_MEDIA: popup -> service worker -> content script
export interface ControlMediaMessage extends BaseMessage {
  type: 'CONTROL_MEDIA';
  tabId: number;
  action: MediaAction;
}

// SONOS_EVENT: offscreen -> service worker (forwarded from server via WebSocket)
export interface SonosEventMessage extends BaseMessage {
  type: 'SONOS_EVENT';
  payload: SonosEvent;
}

// VOLUME_UPDATE: service worker -> popup (from GENA event)
export interface VolumeUpdateMessage extends BaseMessage {
  type: 'VOLUME_UPDATE';
  volume: number;
  speakerIp: string;
}

// MUTE_UPDATE: service worker -> popup (from GENA event)
export interface MuteUpdateMessage extends BaseMessage {
  type: 'MUTE_UPDATE';
  mute: boolean;
  speakerIp: string;
}

// CONNECT_WS: popup -> service worker (request WebSocket connection)
export interface ConnectWsMessage extends BaseMessage {
  type: 'CONNECT_WS';
  serverUrl: string; // Server base URL (e.g., http://localhost:45100)
}

// DISCONNECT_WS: popup -> service worker (request WebSocket disconnection)
export interface DisconnectWsMessage extends BaseMessage {
  type: 'DISCONNECT_WS';
}

// WS_CONNECT: service worker -> offscreen (connect to server WebSocket)
export interface WsConnectMessage extends BaseMessage {
  type: 'WS_CONNECT';
  url: string; // WebSocket URL (e.g., ws://localhost:45100/ws)
}

// WS_DISCONNECT: service worker -> offscreen (disconnect from server WebSocket)
export interface WsDisconnectMessage extends BaseMessage {
  type: 'WS_DISCONNECT';
}

// WS_COMMAND: service worker -> offscreen (send command to server)
export interface WsCommandMessage extends BaseMessage {
  type: 'WS_COMMAND';
  id: string; // Request ID for correlation
  action: WsAction;
  payload?: Record<string, unknown>;
}

// WS_RESPONSE: offscreen -> service worker (response from server)
export interface WsResponseMessage extends BaseMessage {
  type: 'WS_RESPONSE';
  id: string; // Request ID for correlation
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

// WS_CONNECTED: offscreen -> service worker (connection established with initial state)
export interface WsConnectedMessage extends BaseMessage {
  type: 'WS_CONNECTED';
  state: SonosStateSnapshot;
}

// WS_STATE_CHANGED: service worker -> popup (Sonos state changed)
export interface WsStateChangedMessage extends BaseMessage {
  type: 'WS_STATE_CHANGED';
  state: SonosStateSnapshot;
}

// Cast status
export interface CastStatus {
  isActive: boolean;
  isPaused?: boolean; // True when stream is paused (Sonos stopped but stream kept alive)
  streamId?: string;
  tabId?: number;
  groupId?: string;
  groupName?: string;
  quality?: QualityPreset;
  mode?: SonosMode;
  coordinatorIp?: string; // Only for local mode
  playbackUrl?: string; // Stream URL for metadata updates
  metadata?: StreamMetadata; // Current metadata sent to speaker
}

// Union of all messages
export type ExtensionMessage =
  | GetStatusMessage
  | StartCastMessage
  | StopCastMessage
  | OffscreenStartMessage
  | OffscreenStopMessage
  | OffscreenPauseMessage
  | OffscreenResumeMessage
  | OffscreenReadyMessage
  | CastErrorMessage
  | CastEndedMessage
  | StatusUpdateMessage
  | MediaUpdateMessage
  | GetMediaSourcesMessage
  | MediaSourcesMessage
  | ControlMediaMessage
  | SonosEventMessage
  | VolumeUpdateMessage
  | MuteUpdateMessage
  | ConnectWsMessage
  | DisconnectWsMessage
  | WsConnectMessage
  | WsDisconnectMessage
  | WsCommandMessage
  | WsResponseMessage
  | WsConnectedMessage
  | WsStateChangedMessage;

// Response types
export interface StatusResponse {
  status: CastStatus;
}

export interface MediaSourcesResponse {
  sources: MediaInfo[];
}
