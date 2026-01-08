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
import { persistenceManager } from './persistence-manager';

const log = createLogger('MetadataCache');

/** In-memory cache storage */
const cache = new Map<number, TabMediaState>();

/** Debounced storage for persistence, registered with manager */
const storage = persistenceManager.register<[number, TabMediaState][]>(
  {
    storageKey: 'metadataCache',
    debounceMs: 500,
    loggerName: 'MetadataCache',
    serialize: () => Array.from(cache.entries()),
    restore: (stored) => {
      if (!Array.isArray(stored)) return undefined;
      return stored as [number, TabMediaState][];
    },
  },
  (data) => {
    if (data) {
      cache.clear();
      for (const [tabId, state] of data) {
        cache.set(tabId, state);
      }
      log.info(`Restored ${cache.size} cached states`);
    }
  },
);

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
  storage.schedule();
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
  storage.schedule();
  return updated;
}

/**
 * Removes a tab from cache.
 * @param tabId - The Chrome tab ID to remove
 */
export function removeFromCache(tabId: number): void {
  if (cache.delete(tabId)) {
    storage.schedule();
  }
}

/**
 * Clears the entire cache.
 */
export function clearCache(): void {
  cache.clear();
  storage.schedule();
}

/**
 * Gets the number of cached entries.
 * @returns The cache size
 */
export function getCacheSize(): number {
  return cache.size;
}

/**
 * Restores cache from session storage.
 * @deprecated Use persistenceManager.restoreAll() instead
 */
export async function restoreCache(): Promise<void> {
  const data = await storage.restore();
  // onRestore callback handles population
  if (data) {
    log.debug('restoreCache called directly (prefer persistenceManager.restoreAll)');
  }
}
