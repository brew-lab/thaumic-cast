import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { getSession } from '../lib/auth-client';
import {
  getSonosStatus,
  getSonosGroups,
  getGroupVolume,
  setGroupVolume,
  getLocalGroups,
  getLocalVolume,
  setLocalVolume,
} from '../api/client';
import type {
  CastStatus,
  QualityPreset,
  SonosMode,
  MediaInfo,
  MediaAction,
} from '@thaumic-cast/shared';

// Unified group type for UI
interface DisplayGroup {
  id: string;
  name: string;
  coordinatorIp?: string; // Only for local mode
}

export function Popup() {
  const [loading, setLoading] = useState(true);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [sonosMode, setSonosMode] = useState<SonosMode>('cloud');
  const [sonosLinked, setSonosLinked] = useState(false);
  const [groups, setGroups] = useState<DisplayGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string>('');
  const [quality, setQuality] = useState<QualityPreset>('medium');
  const [castStatus, setCastStatus] = useState<CastStatus>({ isActive: false });
  const [casting, setCasting] = useState(false);
  const [castingPhase, setCastingPhase] = useState<string>('');
  const [volume, setVolume] = useState<number>(50);
  const [volumeLoading, setVolumeLoading] = useState(false);
  const volumeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Media source state
  const [mediaSources, setMediaSources] = useState<MediaInfo[]>([]);
  const [selectedSourceTabId, setSelectedSourceTabId] = useState<number | null>(null);
  const [showAllSources, setShowAllSources] = useState(false);
  const [activeTab, setActiveTab] = useState<chrome.tabs.Tab | null>(null);
  const MAX_VISIBLE_SOURCES = 3;

  // Auto-clear errors after 8 seconds
  useEffect(() => {
    if (error) {
      if (errorTimeoutRef.current) {
        clearTimeout(errorTimeoutRef.current);
      }
      errorTimeoutRef.current = setTimeout(() => {
        setError(null);
      }, 8000);
    }
    return () => {
      if (errorTimeoutRef.current) {
        clearTimeout(errorTimeoutRef.current);
      }
    };
  }, [error]);

  // Auto-clear warnings after 5 seconds
  useEffect(() => {
    if (warning) {
      const timeout = setTimeout(() => setWarning(null), 5000);
      return () => clearTimeout(timeout);
    }
  }, [warning]);

  useEffect(() => {
    init();
  }, []);

  // Poll for media sources and track active tab
  useEffect(() => {
    async function fetchMediaSources() {
      try {
        // Get active tab info
        const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        setActiveTab(currentTab || null);

        const response = await chrome.runtime.sendMessage({ type: 'GET_MEDIA_SOURCES' });
        console.log('[Popup] Media sources response:', response);
        if (response?.sources) {
          setMediaSources(response.sources);

          // Auto-select current tab on first load (when selectedSourceTabId is null)
          if (selectedSourceTabId === null && currentTab?.id) {
            setSelectedSourceTabId(currentTab.id);
          }
        }
      } catch {
        // Extension context may be invalidated
      }
    }

    fetchMediaSources();
    const interval = setInterval(fetchMediaSources, 2000);
    return () => clearInterval(interval);
  }, [selectedSourceTabId]);

  // Periodic group refresh during active casting to detect stale state
  useEffect(() => {
    if (!castStatus.isActive || sonosMode !== 'local') return;

    const interval = setInterval(async () => {
      // Fetch current groups
      const storage = (await chrome.storage.sync.get('speakerIp')) as { speakerIp?: string };
      const { data: groupsData } = await getLocalGroups(storage.speakerIp || undefined);

      if (groupsData) {
        // Check if active group still exists with same coordinator
        const activeGroup = groupsData.groups.find((g) => g.id === castStatus.groupId);

        if (!activeGroup) {
          setWarning('Speaker group may have changed. Consider stopping and restarting the cast.');
        } else if (activeGroup.coordinatorIp !== castStatus.coordinatorIp) {
          setWarning('Speaker coordinator changed. Audio may not be playing correctly.');
        }
      }
    }, 30000); // Check every 30 seconds

    return () => clearInterval(interval);
  }, [castStatus.isActive, castStatus.groupId, castStatus.coordinatorIp, sonosMode]);

  // Fetch volume when group is selected or casting starts
  useEffect(() => {
    const groupId = castStatus.isActive ? castStatus.groupId : selectedGroup;
    if (groupId && (sonosLinked || sonosMode === 'local')) {
      fetchVolume(groupId);
    }
  }, [selectedGroup, sonosLinked, sonosMode, castStatus.isActive, castStatus.groupId]);

  async function fetchVolume(groupId: string) {
    setVolumeLoading(true);

    if (sonosMode === 'local') {
      // For local mode, find the coordinator IP
      const group = groups.find((g) => g.id === groupId);
      if (group?.coordinatorIp) {
        const { data, error: volError } = await getLocalVolume(group.coordinatorIp);
        if (data && !volError) {
          setVolume(data.volume);
        }
      }
    } else {
      const { data, error: volError } = await getGroupVolume(groupId);
      if (data && !volError) {
        setVolume(data.volume);
      }
    }

    setVolumeLoading(false);
  }

  // Send media control command to selected source
  const handleMediaControl = useCallback(
    async (action: MediaAction) => {
      if (selectedSourceTabId === null) return;

      // Optimistically update UI for play/pause
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

  // Get the currently selected source (could be current tab or another media source)
  const selectedSource = mediaSources.find((s) => s.tabId === selectedSourceTabId);

  // Get media info for current tab (if it has detected media)
  const currentTabMedia = activeTab?.id ? mediaSources.find((s) => s.tabId === activeTab.id) : null;

  // Filter out current tab from other media sources to avoid duplication
  const otherMediaSources = activeTab?.id
    ? mediaSources.filter((s) => s.tabId !== activeTab.id)
    : mediaSources;

  // Check if current tab is selected
  const isCurrentTabSelected = activeTab?.id === selectedSourceTabId;

  function handleVolumeChange(newVolume: number) {
    setVolume(newVolume);

    // Use active group when casting, otherwise use selected group
    const groupId = castStatus.isActive ? castStatus.groupId : selectedGroup;

    // Debounce API call
    if (volumeTimeoutRef.current) {
      clearTimeout(volumeTimeoutRef.current);
    }

    volumeTimeoutRef.current = setTimeout(async () => {
      if (groupId) {
        if (sonosMode === 'local') {
          // For local mode, use coordinator IP
          const group = groups.find((g) => g.id === groupId);
          const ip = castStatus.isActive ? castStatus.coordinatorIp : group?.coordinatorIp;
          if (ip) {
            const { error: volError } = await setLocalVolume(ip, newVolume);
            if (volError) {
              setError(`Volume error: ${volError}`);
            }
          }
        } else {
          const { error: volError } = await setGroupVolume(groupId, newVolume);
          if (volError) {
            setError(`Volume error: ${volError}`);
          }
        }
      }
    }, 300);
  }

  async function init() {
    setLoading(true);
    setError(null);

    try {
      // Get settings
      const storage = (await chrome.storage.sync.get(['sonosMode', 'speakerIp'])) as {
        sonosMode?: SonosMode;
        speakerIp?: string;
      };
      const mode = storage.sonosMode || 'cloud';
      const configuredSpeakerIp = storage.speakerIp || '';
      setSonosMode(mode);

      // Get current cast status from background
      const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
      if (response?.status) {
        setCastStatus(response.status as CastStatus);
      }

      // Check auth status using Better Auth client
      const { data: session, error: sessionError } = await getSession();

      if (sessionError) {
        setIsLoggedIn(false);
        setLoading(false);
        return;
      }

      if (!session?.user) {
        setIsLoggedIn(false);
        setLoading(false);
        return;
      }

      setIsLoggedIn(true);

      if (mode === 'local') {
        // Local mode: fetch groups via UPnP
        await initLocalMode(configuredSpeakerIp);
      } else {
        // Cloud mode: check OAuth and fetch groups via Sonos API
        await initCloudMode();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  async function initCloudMode() {
    // Check Sonos link status
    const { data: sonosStatus, error: sonosError } = await getSonosStatus();
    if (sonosError) {
      setError(sonosError);
      return;
    }

    setSonosLinked(sonosStatus?.linked ?? false);

    if (sonosStatus?.linked) {
      // Fetch Sonos groups via cloud API
      const { data: groupsData, error: groupsError } = await getSonosGroups();
      if (groupsError) {
        setError(groupsError);
      } else if (groupsData) {
        const displayGroups: DisplayGroup[] = groupsData.groups.map((g) => ({
          id: g.id,
          name: g.name,
        }));
        setGroups(displayGroups);
        if (displayGroups.length > 0 && !selectedGroup) {
          setSelectedGroup(displayGroups[0]?.id || '');
        }
      }
    }
  }

  async function initLocalMode(speakerIp?: string) {
    // For local mode, we don't need Sonos OAuth
    setSonosLinked(true);
    setGroupsLoading(true);

    // Fetch groups via local UPnP (pass speaker IP if configured)
    const { data: groupsData, error: groupsError } = await getLocalGroups(speakerIp || undefined);
    setGroupsLoading(false);

    if (groupsError) {
      setError(groupsError);
    } else if (groupsData) {
      const displayGroups: DisplayGroup[] = groupsData.groups.map((g) => ({
        id: g.id,
        name: g.name,
        coordinatorIp: g.coordinatorIp,
      }));
      setGroups(displayGroups);
      if (displayGroups.length > 0 && !selectedGroup) {
        setSelectedGroup(displayGroups[0]?.id || '');
      }
    }
  }

  async function handleCast() {
    if (!selectedGroup) return;

    setCasting(true);
    setCastingPhase('Preparing...');
    setError(null);
    setWarning(null);

    try {
      // Determine which tab to capture
      let targetTabId: number;

      if (selectedSourceTabId !== null) {
        // Cast from selected media source
        targetTabId = selectedSourceTabId;
      } else {
        // Fall back to active tab
        setCastingPhase('Getting tab...');
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          setError('No active tab');
          return;
        }
        targetTabId = tab.id;
      }

      // Get media stream ID for tab capture
      setCastingPhase('Capturing audio...');
      const mediaStreamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId,
      });

      const group = groups.find((g) => g.id === selectedGroup);

      // Send to background with mode info
      setCastingPhase('Starting stream...');
      const response = await chrome.runtime.sendMessage({
        type: 'START_CAST',
        tabId: targetTabId,
        groupId: selectedGroup,
        groupName: group?.name || 'Unknown',
        quality,
        mediaStreamId,
        mode: sonosMode,
        coordinatorIp: group?.coordinatorIp, // Only for local mode
      });

      if (response?.error) {
        setError(response.error);
      } else {
        // Check for warning from background (e.g., speaker may not be playing)
        if (response?.warning) {
          setWarning(response.warning);
        }

        setCastStatus({
          isActive: true,
          streamId: response.streamId,
          tabId: targetTabId,
          groupId: selectedGroup,
          groupName: group?.name,
          quality,
          mode: sonosMode,
          coordinatorIp: group?.coordinatorIp,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start cast');
    } finally {
      setCasting(false);
      setCastingPhase('');
    }
  }

  async function handleStop() {
    try {
      await chrome.runtime.sendMessage({
        type: 'STOP_CAST',
        streamId: castStatus.streamId,
        mode: castStatus.mode,
        coordinatorIp: castStatus.coordinatorIp,
      });
      setCastStatus({ isActive: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop cast');
    }
  }

  function openOptions() {
    chrome.runtime.openOptionsPage();
  }

  async function openServerLogin() {
    const result = (await chrome.storage.sync.get('serverUrl')) as { serverUrl?: string };
    const serverUrl = result.serverUrl || 'http://localhost:3000';
    chrome.tabs.create({ url: `${serverUrl}/login` });
  }

  async function openSonosLink() {
    const result = (await chrome.storage.sync.get('serverUrl')) as { serverUrl?: string };
    const serverUrl = result.serverUrl || 'http://localhost:3000';
    chrome.tabs.create({ url: `${serverUrl}/sonos/link` });
  }

  if (loading) {
    return (
      <div>
        <Header onSettings={openOptions} />
        <p class="status-message">Loading...</p>
      </div>
    );
  }

  if (!isLoggedIn) {
    return (
      <div>
        <Header onSettings={openOptions} />
        <div class="login-prompt">
          <p>Sign in to start casting</p>
          <button class="btn btn-primary" onClick={openServerLogin}>
            Sign In
          </button>
        </div>
      </div>
    );
  }

  // For cloud mode, show Sonos link prompt if not linked
  if (sonosMode === 'cloud' && !sonosLinked) {
    return (
      <div>
        <Header onSettings={openOptions} />
        <div class="login-prompt">
          <p>Connect your Sonos account</p>
          <button class="btn btn-primary" onClick={openSonosLink}>
            Connect Sonos
          </button>
        </div>
      </div>
    );
  }

  // For local mode, show message if no speakers found
  if (sonosMode === 'local' && groups.length === 0 && !groupsLoading) {
    return (
      <div>
        <Header onSettings={openOptions} />
        {error && (
          <p class="error-message" role="alert">
            {error}
          </p>
        )}
        <div class="login-prompt">
          <p>No Sonos speakers found on network</p>
          <button class="btn btn-secondary" onClick={init} disabled={groupsLoading}>
            {groupsLoading ? 'Scanning...' : 'Retry'}
          </button>
          <p class="hint" style={{ marginTop: '8px', fontSize: '12px', opacity: 0.7 }}>
            Make sure the server is on the same network as your speakers
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <Header onSettings={openOptions} />

      {error && (
        <p class="error-message" role="alert">
          {error}
          <button class="dismiss-btn" onClick={() => setError(null)} aria-label="Dismiss error">
            ×
          </button>
        </p>
      )}

      {warning && (
        <p class="warning-message" role="alert">
          {warning}
          <button class="dismiss-btn" onClick={() => setWarning(null)} aria-label="Dismiss warning">
            ×
          </button>
        </p>
      )}

      {sonosMode === 'local' && <div class="mode-badge">Local Mode</div>}

      {groupsLoading && <p class="status-message">Finding speakers...</p>}

      {/* Media Sources Section */}
      <div class="media-sources">
        <div class="media-sources-header">Cast Source</div>
        <div class="media-source-list">
          {/* Current Tab Card - always shown first */}
          {activeTab && (
            <CurrentTabCard
              tab={activeTab}
              mediaInfo={currentTabMedia}
              isSelected={isCurrentTabSelected}
              onClick={() => {
                if (activeTab.id) {
                  setSelectedSourceTabId(activeTab.id);
                }
              }}
            />
          )}
          {/* Other media sources from different tabs */}
          {(showAllSources
            ? otherMediaSources
            : otherMediaSources.slice(0, MAX_VISIBLE_SOURCES - 1)
          ).map((source) => (
            <MediaSourceCard
              key={source.tabId}
              source={source}
              isSelected={source.tabId === selectedSourceTabId}
              onClick={() => setSelectedSourceTabId(source.tabId)}
            />
          ))}
        </div>
        {otherMediaSources.length > MAX_VISIBLE_SOURCES - 1 && (
          <button class="see-all-btn" onClick={() => setShowAllSources(!showAllSources)}>
            {showAllSources ? 'Show less' : `See all sources (${otherMediaSources.length + 1})`}
          </button>
        )}
        {selectedSource && (
          <PlaybackControls
            isPlaying={selectedSource.isPlaying}
            onPrevious={() => handleMediaControl('previoustrack')}
            onPlayPause={() => handleMediaControl(selectedSource.isPlaying ? 'pause' : 'play')}
            onNext={() => handleMediaControl('nexttrack')}
          />
        )}
      </div>

      {castStatus.isActive ? (
        <>
          <div class="casting-status">
            <div class="label">
              <span class="casting-indicator" aria-hidden="true" />
              Casting to
            </div>
            <div class="value">{castStatus.groupName}</div>
          </div>
          <div class="form-group">
            <label htmlFor="volume-casting">Volume: {volume}%</label>
            <input
              id="volume-casting"
              type="range"
              min="0"
              max="100"
              value={volume}
              disabled={volumeLoading}
              onInput={(e) =>
                handleVolumeChange(parseInt((e.target as HTMLInputElement).value, 10))
              }
            />
          </div>
          <button class="btn btn-stop" onClick={handleStop}>
            Stop Casting
          </button>
        </>
      ) : (
        <>
          <div class="form-group">
            <label htmlFor="group">Speaker Group</label>
            <select
              id="group"
              value={selectedGroup}
              onChange={(e) => setSelectedGroup((e.target as HTMLSelectElement).value)}
            >
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </div>

          <div class="form-group">
            <label htmlFor="quality">Quality</label>
            <select
              id="quality"
              value={quality}
              onChange={(e) => setQuality((e.target as HTMLSelectElement).value as QualityPreset)}
            >
              <option value="low">Low (128 kbps)</option>
              <option value="medium">Medium (192 kbps)</option>
              <option value="high">High (320 kbps)</option>
            </select>
          </div>

          <div class="form-group">
            <label htmlFor="volume">Volume: {volume}%</label>
            <input
              id="volume"
              type="range"
              min="0"
              max="100"
              value={volume}
              disabled={volumeLoading || !selectedGroup}
              onInput={(e) =>
                handleVolumeChange(parseInt((e.target as HTMLInputElement).value, 10))
              }
            />
          </div>

          <button
            class="btn btn-primary"
            onClick={handleCast}
            disabled={casting || !selectedGroup || groupsLoading}
          >
            {casting
              ? castingPhase || 'Starting...'
              : (() => {
                  // Determine cast button label based on selection
                  if (isCurrentTabSelected) {
                    const label = currentTabMedia?.title || activeTab?.title || 'Current Tab';
                    const truncated = label.slice(0, 20) + (label.length > 20 ? '...' : '');
                    return `Cast: ${truncated}`;
                  } else if (selectedSource?.title) {
                    const truncated =
                      selectedSource.title.slice(0, 20) +
                      (selectedSource.title.length > 20 ? '...' : '');
                    return `Cast: ${truncated}`;
                  }
                  return 'Cast';
                })()}
          </button>
        </>
      )}
    </div>
  );
}

function Header({ onSettings }: { onSettings: () => void }) {
  return (
    <div class="header">
      <h1>Thaumic Cast</h1>
      <button class="settings-btn" onClick={onSettings} aria-label="Settings" title="Settings">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M12 1v4M12 19v4M4.2 4.2l2.8 2.8M17 17l2.8 2.8M1 12h4M19 12h4M4.2 19.8l2.8-2.8M17 7l2.8-2.8" />
        </svg>
      </button>
    </div>
  );
}

interface CurrentTabCardProps {
  tab: chrome.tabs.Tab;
  mediaInfo: MediaInfo | null | undefined;
  isSelected: boolean;
  onClick: () => void;
}

function CurrentTabCard({ tab, mediaInfo, isSelected, onClick }: CurrentTabCardProps) {
  // If current tab has detected media, show media info; otherwise show tab info
  const hasMedia = mediaInfo && (mediaInfo.hasMetadata || mediaInfo.isPlaying);
  const title = hasMedia
    ? mediaInfo.title || tab.title || 'Current Tab'
    : tab.title || 'Current Tab';
  const subtitle = hasMedia ? mediaInfo.artist || 'Audio playing' : 'No media detected';
  const artwork = hasMedia ? mediaInfo.artwork : null;

  return (
    <button
      class={`media-source-card ${isSelected ? 'selected' : ''}`}
      onClick={onClick}
      type="button"
    >
      <div class="media-artwork">
        {artwork ? (
          <img src={artwork} alt="" />
        ) : tab.favIconUrl ? (
          <img src={tab.favIconUrl} alt="" />
        ) : (
          <div class="media-artwork-placeholder">
            {/* Browser tab icon */}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V7h14v12z" />
            </svg>
          </div>
        )}
      </div>
      <div class="media-info">
        <div class="media-title">{title}</div>
        <div class="media-artist">{subtitle}</div>
      </div>
      <div class={`media-select-indicator ${isSelected ? 'selected' : ''}`}>
        {isSelected ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="12" r="8" />
          </svg>
        ) : (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <circle cx="12" cy="12" r="8" />
          </svg>
        )}
      </div>
    </button>
  );
}

interface MediaSourceCardProps {
  source: MediaInfo;
  isSelected: boolean;
  onClick: () => void;
}

function MediaSourceCard({ source, isSelected, onClick }: MediaSourceCardProps) {
  return (
    <button
      class={`media-source-card ${isSelected ? 'selected' : ''}`}
      onClick={onClick}
      type="button"
    >
      <div class="media-artwork">
        {source.artwork ? (
          <img src={source.artwork} alt="" />
        ) : source.tabFavicon ? (
          <img src={source.tabFavicon} alt="" />
        ) : (
          <div class="media-artwork-placeholder">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
            </svg>
          </div>
        )}
      </div>
      <div class="media-info">
        <div class="media-title">{source.title || source.tabTitle}</div>
        <div class="media-artist">{source.hasMetadata ? source.artist : 'Audio playing'}</div>
      </div>
      <div class={`media-select-indicator ${isSelected ? 'selected' : ''}`}>
        {isSelected ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="12" r="8" />
          </svg>
        ) : (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <circle cx="12" cy="12" r="8" />
          </svg>
        )}
      </div>
    </button>
  );
}

interface PlaybackControlsProps {
  isPlaying: boolean;
  onPrevious: () => void;
  onPlayPause: () => void;
  onNext: () => void;
}

function PlaybackControls({ isPlaying, onPrevious, onPlayPause, onNext }: PlaybackControlsProps) {
  return (
    <div class="playback-controls">
      <button
        class="playback-btn"
        onClick={onPrevious}
        aria-label="Previous track"
        title="Previous"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
        </svg>
      </button>
      <button
        class="playback-btn playback-btn-main"
        onClick={onPlayPause}
        aria-label={isPlaying ? 'Pause' : 'Play'}
        title={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
          </svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
      <button class="playback-btn" onClick={onNext} aria-label="Next track" title="Next">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
        </svg>
      </button>
    </div>
  );
}
