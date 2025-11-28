// Extension messaging types between popup, service worker, and offscreen document

import type { QualityPreset } from './api';

// Message types
export type MessageType =
  | 'GET_STATUS'
  | 'START_CAST'
  | 'STOP_CAST'
  | 'OFFSCREEN_START'
  | 'OFFSCREEN_STOP'
  | 'CAST_ERROR'
  | 'CAST_ENDED'
  | 'STATUS_UPDATE';

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
}

// STOP_CAST: popup -> service worker
export interface StopCastMessage extends BaseMessage {
  type: 'STOP_CAST';
  streamId: string;
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

// Cast status
export interface CastStatus {
  isActive: boolean;
  streamId?: string;
  tabId?: number;
  groupId?: string;
  groupName?: string;
  quality?: QualityPreset;
}

// Union of all messages
export type ExtensionMessage =
  | GetStatusMessage
  | StartCastMessage
  | StopCastMessage
  | OffscreenStartMessage
  | OffscreenStopMessage
  | CastErrorMessage
  | CastEndedMessage
  | StatusUpdateMessage;

// Response types
export interface StatusResponse {
  status: CastStatus;
}
