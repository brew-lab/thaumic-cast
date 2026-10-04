/**
 * Video Sync Routes
 *
 * Handles message routing for video synchronization:
 * - SET_VIDEO_SYNC_ENABLED, SET_VIDEO_SYNC_TRIM, VIDEO_SYNC_REARM,
 *   GET_VIDEO_SYNC_STATE (popup, answered with `{ status }`: the cast's
 *   status, or null when the tab has no cast running video sync)
 * - VIDEO_SYNC_HOOK_STATUS (a frame's audio-lead hook, through its relay)
 * - CAPTURE_DELAY (the offscreen document: audio held in the extension)
 */

import type { VideoSyncStatus } from '@thaumic-cast/protocol';
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
 * Wraps a status for the popup. A bare null would reach the popup as the
 * router's default `{ success: true }`, which says nothing.
 * @param pending - The status, or null
 * @returns The answer
 */
async function answer(
  pending: Promise<VideoSyncStatus | null>,
): Promise<{ status: VideoSyncStatus | null }> {
  return { status: await pending };
}

/**
 * Registers all video sync routes.
 */
export function registerVideoSyncRoutes(): void {
  registerValidatedRoute('SET_VIDEO_SYNC_ENABLED', SetVideoSyncEnabledMessageSchema, (msg) =>
    answer(setVideoSyncEnabled(msg.payload.tabId, msg.payload.enabled)),
  );

  registerValidatedRoute('SET_VIDEO_SYNC_TRIM', SetVideoSyncTrimMessageSchema, (msg) =>
    answer(setVideoSyncTrim(msg.payload.tabId, msg.payload.trimMs)),
  );

  registerValidatedRoute('VIDEO_SYNC_REARM', VideoSyncRearmMessageSchema, (msg) =>
    answer(rearmVideoSync(msg.payload.tabId)),
  );

  registerValidatedRoute('GET_VIDEO_SYNC_STATE', GetVideoSyncStateMessageSchema, (msg) =>
    answer(getVideoSyncStatus(msg.payload.tabId)),
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
