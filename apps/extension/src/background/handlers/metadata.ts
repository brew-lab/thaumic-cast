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
import type { StreamMetadata, MediaMetadata, TabMediaState } from '@thaumic-cast/protocol';
import type { TabMetadataUpdateMessage, CurrentTabStateResponse } from '../../lib/messages';
import { getSourceFromUrl } from '../../lib/url-utils';
import { getActiveTab } from '../../lib/tab-utils';
import { getCachedState, updateCache, updateTabInfo } from '../metadata-cache';
import { hasSession, onMetadataUpdate } from '../session-manager';
import { notifyPopup } from '../notification-service';
import { offscreenBroker } from '../offscreen-broker';
import { onSourcePlaybackStarted } from '../sonos-event-handlers';

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
 * Compares two MediaMetadata objects for equality.
 * @param a - First metadata object (or null)
 * @param b - Second metadata object (or null)
 * @returns True if both are equal
 */
function metadataEqual(a: MediaMetadata | null, b: MediaMetadata | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.title === b.title && a.artist === b.artist && a.album === b.album && a.artwork === b.artwork
  );
}

/**
 * Compares two arrays of media actions for equality.
 * @param a - First actions array
 * @param b - Second actions array
 * @returns True if both contain the same actions
 */
function actionsEqual(a: MediaAction[], b: MediaAction[]): boolean {
  if (a.length !== b.length) return false;
  // Actions are typically in order, so simple comparison works
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Checks if an update would change the cached state.
 * Used to skip redundant cache writes and notifications.
 * @param existing - The existing cached state (or undefined)
 * @param tabInfo - New tab info
 * @param tabInfo.title - Tab title
 * @param tabInfo.favIconUrl - Tab favicon URL
 * @param tabInfo.ogImage - Tab Open Graph image URL
 * @param tabInfo.source - Source name derived from URL
 * @param metadata - New metadata
 * @param supportedActions - New supported actions
 * @param playbackState - New playback state
 * @returns True if the update would change the state
 */
function hasStateChanged(
  existing: TabMediaState | undefined,
  tabInfo: { title?: string; favIconUrl?: string; ogImage?: string; source?: string },
  metadata: MediaMetadata | null,
  supportedActions: MediaAction[],
  playbackState: PlaybackState,
): boolean {
  // No existing state means this is a new entry
  if (!existing) return true;

  // Compare tab info fields
  if ((tabInfo.title || 'Unknown Tab') !== existing.tabTitle) return true;
  if (tabInfo.favIconUrl !== existing.tabFavicon) return true;
  if (tabInfo.ogImage !== existing.tabOgImage) return true;
  if (tabInfo.source !== existing.source) return true;

  // Compare metadata
  if (!metadataEqual(metadata, existing.metadata)) return true;

  // Compare supported actions
  if (!actionsEqual(supportedActions, existing.supportedActions)) return true;

  // Compare playback state
  if (playbackState !== existing.playbackState) return true;

  return false;
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

  // Early-return if nothing changed to avoid redundant writes/notifications
  if (!hasStateChanged(existing, tabInfo, metadata, supportedActions, playbackState)) {
    return;
  }

  // Update the cache with metadata, supported actions, and playback state
  const state = updateCache(tabId, tabInfo, metadata, supportedActions, playbackState);

  // Notify popup of state change so CurrentTabCard updates
  notifyPopup({ type: 'TAB_STATE_CHANGED', tabId, state });

  // If this tab is casting, notify popup and forward to offscreen
  if (hasSession(tabId)) {
    onMetadataUpdate(tabId);
    // Enrich metadata with source for Sonos display
    const streamMeta: StreamMetadata = {
      title: metadata?.title,
      artist: metadata?.artist,
      source,
    };
    forwardMetadataToOffscreen(tabId, streamMeta);

    // Bi-directional control: when source transitions to 'playing',
    // resume Sonos if paused (handles YouTube clicks, keyboard shortcuts, etc.)
    const wasPlaying = existing?.playbackState === 'playing';
    const nowPlaying = playbackState === 'playing';
    if (!wasPlaying && nowPlaying) {
      onSourcePlaybackStarted(tabId);
    }
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

  // Check if ogImage has actually changed
  const existing = getCachedState(tabId);
  if (existing?.tabOgImage === payload.ogImage) {
    return;
  }

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
function forwardMetadataToOffscreen(tabId: number, metadata: StreamMetadata): void {
  offscreenBroker.updateMetadata(tabId, metadata);
}

/**
 * Handles GET_CURRENT_TAB_STATE query from popup.
 * Returns the current tab's media state and cast status.
 * @returns The current tab state response
 */
export async function handleGetCurrentTabState(): Promise<CurrentTabStateResponse> {
  const tab = await getActiveTab();
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
