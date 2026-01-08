/**
 * Metadata Handlers
 *
 * Handles tab metadata updates from content scripts.
 *
 * Responsibilities:
 * - Process metadata from content scripts
 * - Update metadata cache
 * - Forward metadata to offscreen for streaming
 * - Handle og:image updates
 *
 * Non-responsibilities:
 * - Metadata cache storage (handled by metadata-cache.ts)
 * - Session management (handled by session-manager.ts)
 */

import {
  parseMediaMetadata,
  MediaAction,
  MediaActionSchema,
  PlaybackState,
  PlaybackStateSchema,
} from '@thaumic-cast/protocol';
import type {
  TabMetadataUpdateMessage,
  OffscreenMetadataMessage,
  CurrentTabStateResponse,
} from '../../lib/messages';
import { getSourceFromUrl } from '../../lib/url-utils';
import { getCachedState, updateCache, updateTabInfo } from '../metadata-cache';
import { hasSession, onMetadataUpdate } from '../session-manager';
import { notifyPopup } from '../notify';
import { sendToOffscreen } from '../offscreen-manager';

/**
 * Extracts and validates supported actions from raw payload.
 * @param payload - Raw metadata payload from content script
 * @returns Array of validated media actions
 */
function extractSupportedActions(payload: unknown): MediaAction[] {
  if (!payload || typeof payload !== 'object') return [];
  const raw = (payload as { supportedActions?: unknown }).supportedActions;
  if (!Array.isArray(raw)) return [];

  return raw.filter((action): action is MediaAction => {
    const result = MediaActionSchema.safeParse(action);
    return result.success;
  });
}

/**
 * Extracts and validates playback state from raw payload.
 * @param payload - Raw metadata payload from content script
 * @returns Validated playback state or 'none' if invalid
 */
function extractPlaybackState(payload: unknown): PlaybackState {
  if (!payload || typeof payload !== 'object') return 'none';
  const raw = (payload as { playbackState?: unknown }).playbackState;
  const result = PlaybackStateSchema.safeParse(raw);
  return result.success ? result.data : 'none';
}

/**
 * Handles metadata updates from content scripts.
 * Updates the cache and forwards to offscreen if casting.
 *
 * @param msg - The metadata message from content script
 * @param sender - The message sender information
 */
export async function handleTabMetadataUpdate(
  msg: TabMetadataUpdateMessage,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  // Parse and validate the metadata
  const metadata = parseMediaMetadata(msg.payload);

  // Extract supported actions and playback state from payload
  const supportedActions = extractSupportedActions(msg.payload);
  const playbackState = extractPlaybackState(msg.payload);

  // Derive source from tab URL (single point of derivation per SoC)
  const source = getSourceFromUrl(sender.tab?.url);

  // Preserve existing ogImage if present
  const existing = getCachedState(tabId);
  const tabInfo = {
    title: sender.tab?.title,
    favIconUrl: sender.tab?.favIconUrl,
    ogImage: existing?.tabOgImage,
    source,
  };

  // Update the cache with metadata, supported actions, and playback state
  const state = updateCache(tabId, tabInfo, metadata, supportedActions, playbackState);

  // Notify popup of state change so CurrentTabCard updates
  notifyPopup({ type: 'TAB_STATE_CHANGED', tabId, state });

  // If this tab is casting, notify popup and forward to offscreen
  if (hasSession(tabId)) {
    onMetadataUpdate(tabId);
    // Enrich metadata with source for Sonos display
    forwardMetadataToOffscreen(tabId, { ...msg.payload, source });
  }
}

/**
 * Handles og:image updates from content scripts.
 * Updates the cache with the Open Graph image.
 * Creates a cache entry if one doesn't exist.
 *
 * @param payload - The og:image payload
 * @param payload.ogImage
 * @param sender - The message sender information
 */
export function handleTabOgImage(
  payload: { ogImage: string },
  sender: chrome.runtime.MessageSender,
): void {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  // Try to update existing cache entry
  let state = updateTabInfo(tabId, { ogImage: payload.ogImage });

  // If no cache entry exists, create one with og:image
  if (!state) {
    state = updateCache(
      tabId,
      {
        title: sender.tab?.title,
        favIconUrl: sender.tab?.favIconUrl,
        ogImage: payload.ogImage,
      },
      null,
    );
  }

  notifyPopup({ type: 'TAB_STATE_CHANGED', tabId, state });
}

/**
 * Forwards metadata to offscreen document for streaming.
 * @param tabId - The tab ID
 * @param metadata - The stream metadata to forward
 */
function forwardMetadataToOffscreen(tabId: number, metadata: unknown): void {
  const offscreenMsg: OffscreenMetadataMessage = {
    type: 'OFFSCREEN_METADATA_UPDATE',
    payload: {
      tabId,
      metadata: metadata as OffscreenMetadataMessage['payload']['metadata'],
    },
  };
  sendToOffscreen(offscreenMsg).catch(() => {});
}

/**
 * Handles GET_CURRENT_TAB_STATE query from popup.
 * Returns the current tab's media state and cast status.
 * @returns The current tab state response
 */
export async function handleGetCurrentTabState(): Promise<CurrentTabStateResponse> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return { state: null, isCasting: false };
  }

  // Return cached state or create minimal state from tab info
  const cached = getCachedState(tab.id);
  const state = cached ?? {
    tabId: tab.id,
    tabTitle: tab.title || 'Unknown Tab',
    tabFavicon: tab.favIconUrl,
    metadata: null,
    supportedActions: [],
    playbackState: 'none' as const,
    updatedAt: Date.now(),
  };

  return { state, isCasting: hasSession(tab.id) };
}
