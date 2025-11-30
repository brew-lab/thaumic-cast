// Extension messaging types between popup, service worker, and offscreen document

import type { QualityPreset, SonosMode, StreamMetadata } from './api';

// Message types
export type MessageType =
  | 'GET_STATUS'
  | 'START_CAST'
  | 'STOP_CAST'
  | 'OFFSCREEN_START'
  | 'OFFSCREEN_STOP'
  | 'OFFSCREEN_READY'
  | 'CAST_ERROR'
  | 'CAST_ENDED'
  | 'STATUS_UPDATE'
  // Media detection messages
  | 'MEDIA_UPDATE'
  | 'GET_MEDIA_SOURCES'
  | 'MEDIA_SOURCES'
  | 'CONTROL_MEDIA';

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

// Cast status
export interface CastStatus {
  isActive: boolean;
  streamId?: string;
  tabId?: number;
  groupId?: string;
  groupName?: string;
  quality?: QualityPreset;
  mode?: SonosMode;
  coordinatorIp?: string; // Only for local mode
}

// Union of all messages
export type ExtensionMessage =
  | GetStatusMessage
  | StartCastMessage
  | StopCastMessage
  | OffscreenStartMessage
  | OffscreenStopMessage
  | OffscreenReadyMessage
  | CastErrorMessage
  | CastEndedMessage
  | StatusUpdateMessage
  | MediaUpdateMessage
  | GetMediaSourcesMessage
  | MediaSourcesMessage
  | ControlMediaMessage;

// Response types
export interface StatusResponse {
  status: CastStatus;
}

export interface MediaSourcesResponse {
  sources: MediaInfo[];
}
