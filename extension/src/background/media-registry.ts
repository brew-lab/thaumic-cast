import type { MediaInfo } from '@thaumic-cast/shared';

// Media state tracking for all tabs (in-memory cache)
let mediaByTab = new Map<number, MediaInfo>();
// Track when each tab's media was first detected (for stable sorting)
let firstDetectedByTab = new Map<number, number>();

// Debounce persistence to avoid excessive storage writes
let persistTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Persist media state to chrome.storage.session.
 * This survives service worker restarts within the same browser session.
 * Debounced to avoid excessive writes during rapid updates.
 */
function persistState(): void {
  if (persistTimeout) {
    clearTimeout(persistTimeout);
  }
  persistTimeout = setTimeout(async () => {
    try {
      await chrome.storage.session.set({
        mediaByTab: Array.from(mediaByTab.entries()),
        firstDetectedByTab: Array.from(firstDetectedByTab.entries()),
      });
    } catch (err) {
      console.error('[MediaRegistry] Failed to persist state:', err);
    }
  }, 100); // Debounce 100ms
}

/**
 * Restore media state from chrome.storage.session.
 * Called on service worker startup to recover state after unload.
 */
export async function restoreState(): Promise<void> {
  try {
    const data = await chrome.storage.session.get(['mediaByTab', 'firstDetectedByTab']);
    if (data.mediaByTab && Array.isArray(data.mediaByTab)) {
      mediaByTab = new Map(data.mediaByTab);
      console.log(
        '[MediaRegistry] Restored',
        mediaByTab.size,
        'media sources from session storage'
      );
    }
    if (data.firstDetectedByTab && Array.isArray(data.firstDetectedByTab)) {
      firstDetectedByTab = new Map(data.firstDetectedByTab);
    }
  } catch (err) {
    console.error('[MediaRegistry] Failed to restore state:', err);
  }
}

export function handleMediaUpdate(
  media: Omit<MediaInfo, 'tabId' | 'tabTitle' | 'tabFavicon'> | null,
  sender: chrome.runtime.MessageSender
): void {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  if (!media) {
    // Tab no longer has media
    purgeTab(tabId);
    return;
  }

  // Track when this source was first detected (for stable ordering)
  if (!firstDetectedByTab.has(tabId)) {
    firstDetectedByTab.set(tabId, Date.now());
  }

  // Build full media info with tab details
  const fullInfo: MediaInfo = {
    tabId,
    tabTitle: sender.tab?.title || 'Unknown tab',
    tabFavicon: sender.tab?.favIconUrl,
    title: media.title,
    artist: media.artist,
    album: media.album,
    artwork: media.artwork,
    isPlaying: media.isPlaying,
    lastUpdated: Date.now(),
    hasMetadata: media.hasMetadata ?? false,
  };

  mediaByTab.set(tabId, fullInfo);
  persistState();
}

export async function getMediaSources(): Promise<MediaInfo[]> {
  const sources: MediaInfo[] = [];

  // Verify each tab still exists and collect valid sources
  for (const [tabId, info] of mediaByTab) {
    try {
      await chrome.tabs.get(tabId);
      sources.push(info);
    } catch {
      purgeTab(tabId);
    }
  }

  // Stable sort by first detected time only (oldest first)
  // Do NOT sort by playing status to avoid UI jumping
  sources.sort((a, b) => {
    const aFirst = firstDetectedByTab.get(a.tabId) || 0;
    const bFirst = firstDetectedByTab.get(b.tabId) || 0;
    return aFirst - bFirst;
  });

  return sources;
}

export function purgeTab(tabId: number): void {
  const hadTab = mediaByTab.has(tabId);
  mediaByTab.delete(tabId);
  firstDetectedByTab.delete(tabId);
  if (hadTab) {
    persistState();
  }
}
