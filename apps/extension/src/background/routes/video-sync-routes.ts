/**
 * Video Sync Routes
 *
 * Handles message routing for video synchronization:
 * - SET_VIDEO_SYNC_ENABLED, SET_VIDEO_SYNC_TRIM, TRIGGER_RESYNC
 * - GET_VIDEO_SYNC_STATE, VIDEO_SYNC_STATE_CHANGED
 */

import { registerRoute } from '../router';
import {
  handleVideoSyncMessage,
  handleGetVideoSyncState,
  handleVideoSyncStateChanged,
} from '../handlers/media-control';
import {
  SetVideoSyncEnabledMessageSchema,
  SetVideoSyncTrimMessageSchema,
  TriggerResyncMessageSchema,
  GetVideoSyncStateMessageSchema,
  VideoSyncStateChangedMessageSchema,
} from '../../lib/message-schemas';

/**
 * Registers all video sync routes.
 */
export function registerVideoSyncRoutes(): void {
  registerRoute('SET_VIDEO_SYNC_ENABLED', async (msg) => {
    const validated = SetVideoSyncEnabledMessageSchema.parse(msg);
    return handleVideoSyncMessage(validated, validated.payload.tabId);
  });

  registerRoute('SET_VIDEO_SYNC_TRIM', async (msg) => {
    const validated = SetVideoSyncTrimMessageSchema.parse(msg);
    return handleVideoSyncMessage(validated, validated.payload.tabId);
  });

  registerRoute('TRIGGER_RESYNC', async (msg) => {
    const validated = TriggerResyncMessageSchema.parse(msg);
    return handleVideoSyncMessage(validated, validated.payload.tabId);
  });

  registerRoute('GET_VIDEO_SYNC_STATE', async (msg) => {
    const validated = GetVideoSyncStateMessageSchema.parse(msg);
    return handleGetVideoSyncState(validated.payload.tabId);
  });

  registerRoute('VIDEO_SYNC_STATE_CHANGED', (msg) => {
    const validated = VideoSyncStateChangedMessageSchema.parse(msg);
    handleVideoSyncStateChanged(validated);
    return { success: true };
  });
}
