/**
 * Media Control Handlers
 *
 * Handles volume, mute, and transport control messages.
 *
 * Responsibilities:
 * - Forward volume/mute commands to offscreen
 * - Forward media controls to content scripts
 * - Forward video sync commands to content scripts
 *
 * Non-responsibilities:
 * - WebSocket communication (handled by offscreen)
 * - Content script message handling (handled by content scripts)
 * - Bi-directional Sonos control (handled by sonos-event-handlers.ts)
 */

import type {
  SetVolumeMessage,
  SetMuteMessage,
  SetOriginalGroupVolumeMessage,
  ControlMediaMessage,
  VideoSyncStateChangedMessage,
} from '../../lib/messages';
import { createLogger } from '@thaumic-cast/shared';
import { offscreenBroker } from '../offscreen-broker';
import { notifyPopup } from '../notification-service';
import { getSessionBySpeakerIp, getOriginalGroupForSpeaker } from '../session-manager';

const log = createLogger('MediaControl');

/**
 * Handles SET_VOLUME message from popup.
 *
 * For sync sessions with original groups, routes to SET_ORIGINAL_GROUP_VOLUME
 * which uses RenderingControl (per-speaker) instead of GroupRenderingControl.
 * This ensures all sliders work correctly when multiple groups are joined.
 *
 * @param msg - The volume message
 * @returns The offscreen response
 */
export async function handleSetVolume(
  msg: SetVolumeMessage,
): Promise<{ success: boolean } | undefined> {
  // Check if this speaker is in a sync session with original groups
  const session = getSessionBySpeakerIp(msg.speakerIp);

  if (session?.syncSpeakers) {
    const coordinatorUuid = getOriginalGroupForSpeaker(session.tabId, msg.speakerIp);
    if (coordinatorUuid) {
      // Route through SET_ORIGINAL_GROUP_VOLUME for per-group volume control
      log.debug(
        `Using SET_ORIGINAL_GROUP_VOLUME for sync session (speaker=${msg.speakerIp}, group=${coordinatorUuid})`,
      );
      return offscreenBroker.setOriginalGroupVolume(session.streamId, coordinatorUuid, msg.volume);
    }
  }

  // Default: use group volume control
  return offscreenBroker.setVolume(msg.speakerIp, msg.volume);
}

/**
 * Handles SET_MUTE message from popup.
 *
 * For sync sessions with original groups, routes to SET_ORIGINAL_GROUP_MUTE
 * which uses RenderingControl (per-speaker) instead of GroupRenderingControl.
 * This ensures mute works correctly when multiple groups are joined.
 *
 * @param msg - The mute message
 * @returns The offscreen response
 */
export async function handleSetMute(
  msg: SetMuteMessage,
): Promise<{ success: boolean } | undefined> {
  // Check if this speaker is in a sync session with original groups
  const session = getSessionBySpeakerIp(msg.speakerIp);

  if (session?.syncSpeakers) {
    const coordinatorUuid = getOriginalGroupForSpeaker(session.tabId, msg.speakerIp);
    if (coordinatorUuid) {
      // Route through SET_ORIGINAL_GROUP_MUTE for per-group mute control
      log.debug(
        `Using SET_ORIGINAL_GROUP_MUTE for sync session (speaker=${msg.speakerIp}, group=${coordinatorUuid})`,
      );
      return offscreenBroker.setOriginalGroupMute(session.streamId, coordinatorUuid, msg.muted);
    }
  }

  // Default: use group mute control
  return offscreenBroker.setMute(msg.speakerIp, msg.muted);
}

/**
 * Handles SET_ORIGINAL_GROUP_VOLUME message from popup.
 * Forwards to offscreen for WebSocket transmission to desktop.
 * Used for per-original-group volume control during synchronized multi-group streaming.
 * @param msg - The original group volume message
 * @returns The offscreen response
 */
export async function handleSetOriginalGroupVolume(
  msg: SetOriginalGroupVolumeMessage,
): Promise<{ success: boolean } | undefined> {
  return offscreenBroker.setOriginalGroupVolume(msg.streamId, msg.coordinatorUuid, msg.volume);
}

/**
 * Handles CONTROL_MEDIA message from popup.
 * Forwards to content script for media session control.
 *
 * Note: Bi-directional Sonos control (resuming Sonos when source plays)
 * is handled by onSourcePlaybackStarted in sonos-event-handlers.ts,
 * triggered when the MediaSession playbackState changes to 'playing'.
 *
 * @param msg - The control message
 */
export async function handleControlMedia(msg: ControlMediaMessage): Promise<void> {
  const { tabId, action } = msg.payload;
  await chrome.tabs.sendMessage(tabId, { type: 'CONTROL_MEDIA', action });
}

/**
 * Handles video sync messages (SET_VIDEO_SYNC_ENABLED, SET_VIDEO_SYNC_TRIM, TRIGGER_RESYNC).
 * Forwards to content script and returns the response.
 * @param msg - The video sync message
 * @param tabId - The tab ID to send to
 * @returns The content script response
 */
export async function handleVideoSyncMessage(
  msg: object,
  tabId: number,
): Promise<
  { success: boolean; error?: string } | { state: string; enabled: boolean; trimMs: number }
> {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    return { success: false, error: 'Content script not available' };
  }
}

/**
 * Handles GET_VIDEO_SYNC_STATE message from popup.
 * Queries content script for current video sync state.
 * @param tabId - The tab ID to query
 * @returns The video sync state
 */
export async function handleGetVideoSyncState(
  tabId: number,
): Promise<{ state: string; enabled: boolean; trimMs: number }> {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'GET_VIDEO_SYNC_STATE' });
  } catch {
    return { state: 'off', enabled: false, trimMs: 0 };
  }
}

/**
 * Handles VIDEO_SYNC_STATE_CHANGED message from content script.
 * Forwards to popup.
 * @param msg - The state change message
 */
export function handleVideoSyncStateChanged(msg: VideoSyncStateChangedMessage): void {
  notifyPopup(msg);
}
