/**
 * Video Sync Routes
 *
 * Handles message routing for video synchronization:
 * - SET_VIDEO_SYNC_ENABLED, SET_VIDEO_SYNC_TRIM, TRIGGER_RESYNC
 * - GET_VIDEO_SYNC_STATE, VIDEO_SYNC_STATE_CHANGED
 */

import { registerValidatedRoute } from '../router';
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
  registerValidatedRoute('SET_VIDEO_SYNC_ENABLED', SetVideoSyncEnabledMessageSchema, (msg) =>
    handleVideoSyncMessage(msg, msg.payload.tabId),
  );

  registerValidatedRoute('SET_VIDEO_SYNC_TRIM', SetVideoSyncTrimMessageSchema, (msg) =>
    handleVideoSyncMessage(msg, msg.payload.tabId),
  );

  registerValidatedRoute('TRIGGER_RESYNC', TriggerResyncMessageSchema, (msg) =>
    handleVideoSyncMessage(msg, msg.payload.tabId),
  );

  registerValidatedRoute('GET_VIDEO_SYNC_STATE', GetVideoSyncStateMessageSchema, (msg) =>
    handleGetVideoSyncState(msg.payload.tabId),
  );

  registerValidatedRoute('VIDEO_SYNC_STATE_CHANGED', VideoSyncStateChangedMessageSchema, (msg) => {
    handleVideoSyncStateChanged(msg);
    return { success: true };
  });
}
