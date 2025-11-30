import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import type { MediaAction, MediaInfo } from '@thaumic-cast/shared';

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
  const [selectedSourceTabId, setSelectedSourceTabIdState] = useState<number | null>(null);
  const [showAllSources, setShowAllSources] = useState(false);
  const [activeTab, setActiveTab] = useState<chrome.tabs.Tab | null>(null);
  const [isVisible, setIsVisible] = useState(!document.hidden);

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

        const response = await chrome.runtime.sendMessage({ type: 'GET_MEDIA_SOURCES' });
        if (response?.sources) {
          setMediaSources(response.sources as MediaInfo[]);

          if (selectedSourceTabId === null && currentTab?.id) {
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
  }, [selectedSourceTabId, isVisible]);

  const selectedSource = useMemo(
    () => mediaSources.find((s) => s.tabId === selectedSourceTabId),
    [mediaSources, selectedSourceTabId]
  );

  const currentTabMedia = useMemo(
    () => (activeTab?.id ? mediaSources.find((s) => s.tabId === activeTab.id) || null : null),
    [activeTab?.id, mediaSources]
  );

  const otherMediaSources = useMemo(
    () => (activeTab?.id ? mediaSources.filter((s) => s.tabId !== activeTab.id) : mediaSources),
    [activeTab?.id, mediaSources]
  );

  const isCurrentTabSelected = activeTab?.id === selectedSourceTabId;

  const handleMediaControl = useCallback(
    async (action: MediaAction) => {
      if (selectedSourceTabId === null) return;

      if (action === 'play' || action === 'pause') {
        setMediaSources((prev) =>
          prev.map((source) =>
            source.tabId === selectedSourceTabId
              ? { ...source, isPlaying: action === 'play' }
              : source
          )
        );
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
    [selectedSourceTabId]
  );

  return {
    mediaSources,
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
