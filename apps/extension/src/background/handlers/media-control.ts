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
 */

import type { SetVolumeMessage, SetMuteMessage, ControlMediaMessage } from '../../lib/messages';
import { sendToOffscreen } from '../offscreen-manager';
import { notifyPopup } from '../notify';

/**
 * Handles SET_VOLUME message from popup.
 * Forwards to offscreen for WebSocket transmission.
 * @param msg - The volume message
 * @returns The offscreen response
 */
export async function handleSetVolume(
  msg: SetVolumeMessage,
): Promise<{ success: boolean } | undefined> {
  const { speakerIp, volume } = msg;
  return sendToOffscreen({ type: 'SET_VOLUME', speakerIp, volume });
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
  const { speakerIp, muted } = msg;
  return sendToOffscreen({ type: 'SET_MUTE', speakerIp, muted });
}

/**
 * Handles CONTROL_MEDIA message from popup.
 * Forwards to content script for media session control.
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
export function handleVideoSyncStateChanged(msg: object): void {
  notifyPopup(msg);
}
