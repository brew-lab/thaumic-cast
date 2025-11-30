import type { MediaInfo } from '@thaumic-cast/shared';

// Media state tracking for all tabs
const mediaByTab = new Map<number, MediaInfo>();
// Track when each tab's media was first detected (for stable sorting)
const firstDetectedByTab = new Map<number, number>();

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
  mediaByTab.delete(tabId);
  firstDetectedByTab.delete(tabId);
}
