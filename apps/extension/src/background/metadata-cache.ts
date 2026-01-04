/**
 * Metadata Cache Module
 *
 * In-memory cache for tab media states with session storage persistence.
 *
 * Design principles:
 * - Pure functions where possible
 * - Immutable updates
 * - Single responsibility: caching only
 *
 * Non-responsibilities:
 * - Message handling (main.ts handles this)
 * - Session management (session-manager.ts handles this)
 */

import type {
  TabMediaState,
  MediaMetadata,
  MediaAction,
  PlaybackState,
} from '@thaumic-cast/protocol';
import { createTabMediaState } from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';

const log = createLogger('MetadataCache');

/** In-memory cache storage */
const cache = new Map<number, TabMediaState>();

/** Session storage key for persistence */
const STORAGE_KEY = 'metadataCache';

/** Debounce timer for persistence */
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounce interval for persistence (ms) */
const PERSIST_DEBOUNCE_MS = 500;

/**
 * Gets cached state for a specific tab.
 * @param tabId - The Chrome tab ID
 * @returns The cached TabMediaState or undefined if not cached
 */
export function getCachedState(tabId: number): TabMediaState | undefined {
  return cache.get(tabId);
}

/**
 * Gets all cached states.
 * @returns Array of all cached TabMediaState objects
 */
export function getAllCachedStates(): TabMediaState[] {
  return Array.from(cache.values());
}

/**
 * Checks if a tab has cached metadata.
 * @param tabId - The Chrome tab ID
 * @returns True if the tab has cached state
 */
export function hasCachedState(tabId: number): boolean {
  return cache.has(tabId);
}

/**
 * Updates cache for a tab with new metadata.
 * @param tabId - The Chrome tab ID
 * @param tabInfo - Tab information (title, favicon, ogImage, source)
 * @param tabInfo.title
 * @param tabInfo.favIconUrl
 * @param tabInfo.ogImage
 * @param tabInfo.source - Source name derived from tab URL
 * @param metadata - Media metadata or null
 * @param supportedActions - Supported media control actions
 * @param playbackState - Current playback state from MediaSession
 * @returns The new TabMediaState
 */
export function updateCache(
  tabId: number,
  tabInfo: { title?: string; favIconUrl?: string; ogImage?: string; source?: string },
  metadata: MediaMetadata | null,
  supportedActions: MediaAction[] = [],
  playbackState: PlaybackState = 'none',
): TabMediaState {
  const state = createTabMediaState(
    {
      id: tabId,
      title: tabInfo.title,
      favIconUrl: tabInfo.favIconUrl,
      ogImage: tabInfo.ogImage,
      source: tabInfo.source,
    },
    metadata,
    supportedActions,
    playbackState,
  );
  cache.set(tabId, state);
  schedulePersist();
  return state;
}

/**
 * Updates only the tab info (title, favicon, ogImage, source) for a cached tab.
 * Preserves existing metadata if present.
 * @param tabId - The Chrome tab ID
 * @param tabInfo - Updated tab information
 * @param tabInfo.title
 * @param tabInfo.favIconUrl
 * @param tabInfo.ogImage
 * @param tabInfo.source - Source name derived from tab URL
 * @returns The updated TabMediaState or undefined if not cached
 */
export function updateTabInfo(
  tabId: number,
  tabInfo: { title?: string; favIconUrl?: string; ogImage?: string; source?: string },
): TabMediaState | undefined {
  const existing = cache.get(tabId);
  if (!existing) return undefined;

  const updated: TabMediaState = {
    ...existing,
    tabTitle: tabInfo.title || existing.tabTitle,
    tabFavicon: tabInfo.favIconUrl ?? existing.tabFavicon,
    tabOgImage: tabInfo.ogImage ?? existing.tabOgImage,
    source: tabInfo.source ?? existing.source,
    updatedAt: Date.now(),
  };
  cache.set(tabId, updated);
  schedulePersist();
  return updated;
}

/**
 * Removes a tab from cache.
 * @param tabId - The Chrome tab ID to remove
 */
export function removeFromCache(tabId: number): void {
  if (cache.delete(tabId)) {
    schedulePersist();
  }
}

/**
 * Clears the entire cache.
 */
export function clearCache(): void {
  cache.clear();
  schedulePersist();
}

/**
 * Gets the number of cached entries.
 * @returns The cache size
 */
export function getCacheSize(): number {
  return cache.size;
}

/**
 * Schedules a debounced persistence to session storage.
 * Prevents excessive writes during rapid updates.
 */
function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, PERSIST_DEBOUNCE_MS);
}

/**
 * Persists cache to session storage.
 */
async function persist(): Promise<void> {
  try {
    const data = Array.from(cache.entries());
    await chrome.storage.session.set({ [STORAGE_KEY]: data });
    log.debug(`Persisted ${data.length} cached states`);
  } catch (err) {
    log.error('Persist failed:', err);
  }
}

/**
 * Restores cache from session storage.
 * Call on service worker startup.
 */
export async function restoreCache(): Promise<void> {
  try {
    const result = await chrome.storage.session.get(STORAGE_KEY);
    const data = result[STORAGE_KEY];
    if (Array.isArray(data)) {
      cache.clear();
      for (const [tabId, state] of data) {
        cache.set(tabId, state);
      }
      log.info(`Restored ${cache.size} cached states`);
    }
  } catch (err) {
    log.error('Restore failed:', err);
  }
}
