/**
 * Video Sync Routes
 *
 * Handles message routing for video synchronization:
 * - SET_VIDEO_SYNC_ENABLED, SET_VIDEO_SYNC_TRIM, TRIGGER_RESYNC
 * - GET_VIDEO_SYNC_STATE, VIDEO_SYNC_STATE_CHANGED
 * - VIDEO_SYNC_HOOK_STATUS (a frame's audio-lead hook, through its relay)
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
  VideoSyncHookStatusMessageSchema,
} from '../../lib/message-schemas';
import { handleHookStatus } from '../video-sync/lead-api';

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

  registerValidatedRoute(
    'VIDEO_SYNC_HOOK_STATUS',
    VideoSyncHookStatusMessageSchema,
    (msg, sender) => {
      handleHookStatus(msg, sender);
      return { success: true };
    },
  );
}
