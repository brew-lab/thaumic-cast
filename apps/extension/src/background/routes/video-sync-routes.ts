/**
 * Video Sync Routes
 *
 * Handles message routing for video synchronization:
 * - SET_VIDEO_SYNC_ENABLED, SET_VIDEO_SYNC_TRIM, VIDEO_SYNC_REARM,
 *   GET_VIDEO_SYNC_STATE (popup, answered with the cast's status)
 * - VIDEO_SYNC_HOOK_STATUS (a frame's audio-lead hook, through its relay)
 * - CAPTURE_DELAY (the offscreen document: audio held in the extension)
 */

import { registerValidatedRoute } from '../router';
import {
  SetVideoSyncEnabledMessageSchema,
  SetVideoSyncTrimMessageSchema,
  VideoSyncRearmMessageSchema,
  GetVideoSyncStateMessageSchema,
  VideoSyncHookStatusMessageSchema,
  CaptureDelayMessageSchema,
} from '../../lib/message-schemas';
import { handleHookStatus } from '../video-sync/lead-api';
import {
  getVideoSyncStatus,
  handleCaptureDelay,
  rearmVideoSync,
  setVideoSyncEnabled,
  setVideoSyncTrim,
} from '../video-sync/service';

/**
 * Registers all video sync routes.
 */
export function registerVideoSyncRoutes(): void {
  registerValidatedRoute('SET_VIDEO_SYNC_ENABLED', SetVideoSyncEnabledMessageSchema, (msg) =>
    setVideoSyncEnabled(msg.payload.tabId, msg.payload.enabled),
  );

  registerValidatedRoute('SET_VIDEO_SYNC_TRIM', SetVideoSyncTrimMessageSchema, (msg) =>
    setVideoSyncTrim(msg.payload.tabId, msg.payload.trimMs),
  );

  registerValidatedRoute('VIDEO_SYNC_REARM', VideoSyncRearmMessageSchema, (msg) =>
    rearmVideoSync(msg.payload.tabId),
  );

  registerValidatedRoute('GET_VIDEO_SYNC_STATE', GetVideoSyncStateMessageSchema, (msg) =>
    getVideoSyncStatus(msg.payload.tabId),
  );

  registerValidatedRoute(
    'VIDEO_SYNC_HOOK_STATUS',
    VideoSyncHookStatusMessageSchema,
    (msg, sender) => {
      handleHookStatus(msg, sender);
      return { success: true };
    },
  );

  registerValidatedRoute('CAPTURE_DELAY', CaptureDelayMessageSchema, async (msg) => {
    await handleCaptureDelay(msg.tabId, msg.ms);
    return { success: true };
  });
}
