/**
 * Media Control Handlers
 *
 * Handles volume, mute, and transport control messages.
 *
 * Responsibilities:
 * - Forward volume/mute commands to offscreen
 * - Forward media controls to content scripts
 *
 * Non-responsibilities:
 * - WebSocket communication (handled by offscreen)
 * - Content script message handling (handled by content scripts)
 * - Bi-directional Sonos control (handled by sonos-event-handlers.ts)
 */

import type { SetVolumeMessage, SetMuteMessage, ControlMediaMessage } from '../../lib/messages';
import { offscreenBroker } from '../offscreen-broker';

/**
 * Handles SET_VOLUME message from popup.
 * Forwards to offscreen for WebSocket transmission.
 * @param msg - The volume message
 * @returns The offscreen response
 */
export async function handleSetVolume(
  msg: SetVolumeMessage,
): Promise<{ success: boolean } | undefined> {
  return offscreenBroker.setVolume(msg.speakerIp, msg.volume, msg.group);
}

/**
 * Handles SET_MUTE message from popup.
 * Forwards to offscreen for WebSocket transmission.
 * @param msg - The mute message
 * @returns The offscreen response
 */
export async function handleSetMute(
  msg: SetMuteMessage,
): Promise<{ success: boolean } | undefined> {
  return offscreenBroker.setMute(msg.speakerIp, msg.muted, msg.group);
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
