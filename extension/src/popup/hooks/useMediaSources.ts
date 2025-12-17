import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import type { CastStatus, MediaAction, MediaInfo } from '@thaumic-cast/shared';

const MAX_VISIBLE_SOURCES = 3;

export interface MediaSourcesState {
  mediaSources: MediaInfo[];
  selectedSourceTabId: number | null;
  selectedSource: MediaInfo | undefined;
  currentTabMedia: MediaInfo | null;
  otherMediaSources: MediaInfo[];
  activeTab: chrome.tabs.Tab | null;
  isCurrentTabSelected: boolean;
  showAllSources: boolean;
  setShowAllSources: (value: boolean) => void;
  setSelectedSourceTabId: (tabId: number) => void;
  handleMediaControl: (action: MediaAction) => Promise<void>;
  maxVisibleSources: number;
}

export function useMediaSources(): MediaSourcesState {
  const [mediaSources, setMediaSources] = useState<MediaInfo[]>([]);
  const [castingTabSource, setCastingTabSource] = useState<MediaInfo | null>(null);
  const [selectedSourceTabId, setSelectedSourceTabIdState] = useState<number | null>(null);
  const [showAllSources, setShowAllSources] = useState(false);
  const [activeTab, setActiveTab] = useState<chrome.tabs.Tab | null>(null);
  const [isVisible, setIsVisible] = useState(!document.hidden);
  const [hasInitialized, setHasInitialized] = useState(false);

  // Track visibility to avoid polling when popup is hidden
  useEffect(() => {
    const onVisibility = () => setIsVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Poll for media sources and track active tab
  useEffect(() => {
    if (!isVisible) return;

    async function fetchMediaSources() {
      try {
        const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        setActiveTab(currentTab || null);

        // Fetch both media sources and cast status
        const [mediaResponse, statusResponse] = await Promise.all([
          chrome.runtime.sendMessage({ type: 'GET_MEDIA_SOURCES' }),
          chrome.runtime.sendMessage({ type: 'GET_STATUS' }),
        ]);

        const sources = (mediaResponse?.sources as MediaInfo[]) || [];
        const status = (statusResponse?.status as CastStatus) || { isActive: false };

        setMediaSources(sources);

        // If casting is active, ensure the casting tab is available as a source
        if (status.isActive && status.tabId !== undefined) {
          const castingTabId = status.tabId;
          const existingSource = sources.find((s) => s.tabId === castingTabId);

          if (!existingSource) {
            // Casting tab isn't in media sources - fetch tab info and create synthetic source
            try {
              const tab = await chrome.tabs.get(castingTabId);
              const syntheticSource: MediaInfo = {
                tabId: castingTabId,
                tabTitle: tab.title || 'Casting Tab',
                tabFavicon: tab.favIconUrl,
                title: status.metadata?.title || tab.title,
                artist: status.metadata?.artist,
                album: status.metadata?.album,
                artwork: status.metadata?.artwork,
                isPlaying: true,
                lastUpdated: Date.now(),
                hasMetadata: !!status.metadata?.title,
              };
              setCastingTabSource(syntheticSource);
            } catch {
              // Tab may have been closed
              setCastingTabSource(null);
            }
          } else {
            // Casting tab exists in media sources, no need for synthetic
            setCastingTabSource(null);
          }
        } else {
          setCastingTabSource(null);
        }

        // On first initialization, prefer selecting the casting tab if active
        if (!hasInitialized) {
          setHasInitialized(true);
          if (status.isActive && status.tabId !== undefined) {
            setSelectedSourceTabIdState(status.tabId);
          } else if (currentTab?.id) {
            setSelectedSourceTabIdState(currentTab.id);
          }
        }
      } catch {
        // Extension context may be invalidated
      }
    }

    fetchMediaSources();
    const interval = setInterval(fetchMediaSources, 2000);
    return () => clearInterval(interval);
  }, [isVisible, hasInitialized]);

  // Combine media sources with the synthetic casting tab source if it exists
  const allSources = useMemo(() => {
    if (castingTabSource && !mediaSources.some((s) => s.tabId === castingTabSource.tabId)) {
      return [...mediaSources, castingTabSource];
    }
    return mediaSources;
  }, [mediaSources, castingTabSource]);

  const selectedSource = useMemo(
    () => allSources.find((s) => s.tabId === selectedSourceTabId),
    [allSources, selectedSourceTabId]
  );

  const currentTabMedia = useMemo(
    () => (activeTab?.id ? allSources.find((s) => s.tabId === activeTab.id) || null : null),
    [activeTab?.id, allSources]
  );

  const otherMediaSources = useMemo(
    () => (activeTab?.id ? allSources.filter((s) => s.tabId !== activeTab.id) : allSources),
    [activeTab?.id, allSources]
  );

  const isCurrentTabSelected = activeTab?.id === selectedSourceTabId;

  const handleMediaControl = useCallback(
    async (action: MediaAction) => {
      if (selectedSourceTabId === null) return;

      if (action === 'play' || action === 'pause') {
        const newPlayingState = action === 'play';
        // Update media sources optimistically
        setMediaSources((prev) =>
          prev.map((source) =>
            source.tabId === selectedSourceTabId
              ? { ...source, isPlaying: newPlayingState }
              : source
          )
        );
        // Also update casting tab source if that's what's selected
        if (castingTabSource?.tabId === selectedSourceTabId) {
          setCastingTabSource((prev) => (prev ? { ...prev, isPlaying: newPlayingState } : null));
        }
      }

      try {
        await chrome.runtime.sendMessage({
          type: 'CONTROL_MEDIA',
          tabId: selectedSourceTabId,
          action,
        });
      } catch {
        // Failed to send control
      }
    },
    [selectedSourceTabId, castingTabSource?.tabId]
  );

  return {
    mediaSources: allSources,
    selectedSourceTabId,
    selectedSource,
    currentTabMedia,
    otherMediaSources,
    activeTab,
    isCurrentTabSelected,
    showAllSources,
    setShowAllSources,
    setSelectedSourceTabId: setSelectedSourceTabIdState,
    handleMediaControl,
    maxVisibleSources: MAX_VISIBLE_SOURCES,
  };
}
