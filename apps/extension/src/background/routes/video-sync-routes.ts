/**
 * Video Sync Routes
 *
 * Handles message routing for video synchronization:
 * - SET_VIDEO_SYNC_ENABLED, SET_VIDEO_SYNC_TRIM, TRIGGER_RESYNC
 * - GET_VIDEO_SYNC_STATE, VIDEO_SYNC_STATE_CHANGED
 */

import type {
  SetVideoSyncEnabledMessage,
  SetVideoSyncTrimMessage,
  TriggerResyncMessage,
  GetVideoSyncStateMessage,
  VideoSyncStateChangedMessage,
} from '../../lib/messages';
import { registerRoute } from '../router';
import {
  handleVideoSyncMessage,
  handleGetVideoSyncState,
  handleVideoSyncStateChanged,
} from '../handlers/media-control';

/**
 * Registers all video sync routes.
 */
export function registerVideoSyncRoutes(): void {
  registerRoute<SetVideoSyncEnabledMessage>('SET_VIDEO_SYNC_ENABLED', async (msg) => {
    return handleVideoSyncMessage(msg, msg.payload.tabId);
  });

  registerRoute<SetVideoSyncTrimMessage>('SET_VIDEO_SYNC_TRIM', async (msg) => {
    return handleVideoSyncMessage(msg, msg.payload.tabId);
  });

  registerRoute<TriggerResyncMessage>('TRIGGER_RESYNC', async (msg) => {
    return handleVideoSyncMessage(msg, msg.payload.tabId);
  });

  registerRoute<GetVideoSyncStateMessage>('GET_VIDEO_SYNC_STATE', async (msg) => {
    return handleGetVideoSyncState(msg.payload.tabId);
  });

  registerRoute<VideoSyncStateChangedMessage>('VIDEO_SYNC_STATE_CHANGED', (msg) => {
    handleVideoSyncStateChanged(msg);
    return { success: true };
  });
}
