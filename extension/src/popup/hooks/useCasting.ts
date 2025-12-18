import { useEffect, useRef, useState } from 'preact/hooks';
import type {
  CastStatus,
  MediaInfo,
  QualityPreset,
  SonosMode,
  SonosStateSnapshot,
  LocalGroup,
} from '@thaumic-cast/shared';
import { getLocalGroups, getSonosGroups, getSonosStatus } from '../../api/client';
import {
  getExtensionSettings,
  saveExtensionSettings,
  detectDesktopApp,
  DEFAULT_SERVER_URL,
  getCachedGroups,
  setCachedGroups,
} from '../../lib/settings';
import { t, type LocaleKey } from '../../lib/i18n';
import { getSession } from '../../lib/auth-client';

export interface DisplayGroup {
  id: string;
  name: string;
  coordinatorIp?: string;
}

interface UseCastingArgs {
  selectedSourceTabId: number | null;
  selectedGroup: string;
  setSelectedGroup: (groupId: string) => void;
  quality: QualityPreset;
  selectedSource?: MediaInfo;
  isCurrentTabSelected: boolean;
  activeTab: chrome.tabs.Tab | null;
}

export function useCasting({
  selectedSourceTabId,
  selectedGroup,
  setSelectedGroup,
  quality,
  selectedSource,
  isCurrentTabSelected,
  activeTab,
}: UseCastingArgs) {
  const [loading, setLoading] = useState(true);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [desktopDetected, setDesktopDetected] = useState(false);
  const [discoveredDesktopUrl, setDiscoveredDesktopUrl] = useState<string | null>(null);
  const [needsAuthForLocalMode, setNeedsAuthForLocalMode] = useState(false);
  const [sonosMode, setSonosMode] = useState<SonosMode>('cloud');
  const [backendType, setBackendType] = useState<'desktop' | 'server' | 'unknown'>('unknown');
  const [sonosLinked, setSonosLinked] = useState(false);
  const [groups, setGroups] = useState<DisplayGroup[]>([]);
  const [castStatus, setCastStatus] = useState<CastStatus>({ isActive: false });
  const [casting, setCasting] = useState(false);
  const [castingPhase, setCastingPhase] = useState<string>('');
  const [volume, setVolume] = useState<number>(50);
  const [isMuted, setIsMuted] = useState(false);
  const [muteLoading, setMuteLoading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const volumeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initInFlight = useRef(false);

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

  // Listen for status and volume/mute updates from background
  useEffect(() => {
    function handleMessage(
      message: {
        type: string;
        status?: CastStatus;
        volume?: number;
        mute?: boolean;
        speakerIp?: string;
        state?: SonosStateSnapshot;
      },
      _sender: chrome.runtime.MessageSender,
      _sendResponse: (response?: unknown) => void
    ) {
      if (message.type === 'STATUS_UPDATE' && message.status) {
        setCastStatus(message.status);
      } else if (message.type === 'VOLUME_UPDATE' && message.volume !== undefined) {
        // Only update if this is for our active speaker
        const activeIp = castStatus.coordinatorIp;
        if (!activeIp || message.speakerIp === activeIp) {
          setVolume(message.volume);
        }
      } else if (message.type === 'MUTE_UPDATE' && message.mute !== undefined) {
        // Only update if this is for our active speaker
        const activeIp = castStatus.coordinatorIp;
        if (!activeIp || message.speakerIp === activeIp) {
          setIsMuted(message.mute);
        }
      } else if (message.type === 'WS_STATE_CHANGED' && message.state) {
        // Update groups from WebSocket state
        handleSonosStateUpdate(message.state);
      }
    }

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage);
    };
  }, [castStatus.coordinatorIp]);

  // Note: Periodic group refresh is no longer needed when using WebSocket.
  // The server pushes zoneChange events when groups change, and the
  // handleSonosStateUpdate function updates groups in real-time.

  // Note: Volume/mute fetching on init is no longer needed - we get it from
  // stored WebSocket state via GET_SONOS_STATE in init().

  function handleVolumeChange(newVolume: number) {
    setVolume(newVolume);
    const groupId = castStatus.isActive ? castStatus.groupId : selectedGroup;

    if (volumeTimeoutRef.current) {
      clearTimeout(volumeTimeoutRef.current);
    }

    volumeTimeoutRef.current = setTimeout(async () => {
      if (groupId) {
        const group = groups.find((g) => g.id === groupId);
        const ip = castStatus.isActive ? castStatus.coordinatorIp : group?.coordinatorIp;

        if (!ip) {
          setError('Volume error: No speaker IP available');
          return;
        }

        try {
          const response = await chrome.runtime.sendMessage({
            type: 'SET_VOLUME',
            speakerIp: ip,
            volume: newVolume,
          });

          if (response?.error) {
            setError(`Volume error: ${response.error}`);
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to set volume');
        }
      }
    }, 300);
  }

  async function handleMuteToggle() {
    const groupId = castStatus.isActive ? castStatus.groupId : selectedGroup;
    if (!groupId) return;

    const group = groups.find((g) => g.id === groupId);
    const ip = castStatus.isActive ? castStatus.coordinatorIp : group?.coordinatorIp;
    if (!ip) return;

    const newMuteState = !isMuted;

    // Optimistic update
    setIsMuted(newMuteState);
    setMuteLoading(true);

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SET_MUTE',
        speakerIp: ip,
        mute: newMuteState,
      });

      if (response?.error) {
        // Revert on error
        setIsMuted(!newMuteState);
        setError(`Mute error: ${response.error}`);
      }
    } catch (err) {
      // Revert on error
      setIsMuted(!newMuteState);
      setError(err instanceof Error ? err.message : 'Failed to toggle mute');
    } finally {
      setMuteLoading(false);
    }
  }

  /**
   * Handle Sonos state updates from WebSocket.
   * Updates groups and volume from the snapshot.
   */
  function handleSonosStateUpdate(state: SonosStateSnapshot) {
    console.log('[useCasting] Received Sonos state update:', state);

    let effectiveGroupId = castStatus.isActive ? castStatus.groupId : selectedGroup;

    // Update groups
    if (state.groups && state.groups.length > 0) {
      const displayGroups: DisplayGroup[] = state.groups.map((g: LocalGroup) => ({
        id: g.id,
        name: g.name,
        coordinatorIp: g.coordinatorIp,
      }));
      setGroups(displayGroups);
      setSonosLinked(true);

      // Select first group if none selected
      if (!selectedGroup && displayGroups.length > 0 && displayGroups[0]) {
        setSelectedGroup(displayGroups[0].id);
        // Use the newly selected group for status lookup below
        effectiveGroupId = displayGroups[0].id;
      }

      // Cache the groups
      setCachedGroups(state.groups);
    }

    // Update volume and mute state from group status if we have an active/selected group
    if (effectiveGroupId && state.group_statuses) {
      const group = state.groups?.find((g: LocalGroup) => g.id === effectiveGroupId);
      if (group) {
        const status = state.group_statuses.find(
          (s: { coordinatorIp: string }) => s.coordinatorIp === group.coordinatorIp
        );
        if (status) {
          if (typeof status.volume === 'number') {
            setVolume(status.volume);
          }
          if (typeof status.isMuted === 'boolean') {
            setIsMuted(status.isMuted);
          }
        }
      }
    }
  }

  async function init() {
    if (initInFlight.current) return;
    initInFlight.current = true;
    setError(null);

    try {
      // STEP 1: Load cached/fast state IMMEDIATELY (unblock UI quickly)
      const [settings, statusResponse, cached, sonosStateResponse] = await Promise.all([
        getExtensionSettings(),
        chrome.runtime.sendMessage({ type: 'GET_STATUS' }),
        getCachedGroups(),
        chrome.runtime.sendMessage({ type: 'GET_SONOS_STATE' }),
      ]);

      const mode = settings.sonosMode || 'cloud';
      const configuredSpeakerIp = settings.speakerIp || '';
      setSonosMode(mode);
      setBackendType(settings.backendType);

      if (statusResponse?.status) {
        setCastStatus(statusResponse.status as CastStatus);
      }

      // Apply cached groups immediately if available (instant display)
      if (cached && cached.groups.length > 0) {
        const displayGroups: DisplayGroup[] = cached.groups.map((g) => ({
          id: g.id,
          name: g.name,
          coordinatorIp: g.coordinatorIp,
        }));
        setGroups(displayGroups);
        setSonosLinked(true);
        if (!selectedGroup && displayGroups[0]) {
          setSelectedGroup(displayGroups[0].id);
        }
      }

      // Apply stored WebSocket state (includes volume/mute from background)
      if (sonosStateResponse?.state && sonosStateResponse.connected) {
        handleSonosStateUpdate(sonosStateResponse.state);
      }

      // UNBLOCK UI - we have enough to render (cache or empty state)
      setLoading(false);

      // STEP 2: Background fetches (update state as they complete)
      // These run concurrently and don't block the UI

      // Check session in background
      getSession().then(({ data: session }) => {
        const loggedIn = !!session?.user;
        setIsLoggedIn(loggedIn);

        // If cloud mode without login, check for desktop app
        if (!loggedIn && mode === 'cloud') {
          detectDesktopApp().then(({ found, url }) => {
            if (found && url) {
              setDesktopDetected(true);
              setDiscoveredDesktopUrl(url);
              chrome.runtime.sendMessage({ type: 'CONNECT_WS', serverUrl: url });
            }
          });
        }

        // Handle auth-dependent initialization
        if (mode === 'local') {
          if (settings.backendType === 'desktop') {
            const serverUrl = settings.serverUrl || DEFAULT_SERVER_URL;
            chrome.runtime.sendMessage({ type: 'CONNECT_WS', serverUrl });
            // Refresh groups in background if we don't have cache
            if (!cached || cached.groups.length === 0) {
              initMode(mode, configuredSpeakerIp);
            }
          } else if (loggedIn) {
            if (!cached || cached.groups.length === 0) {
              initMode(mode, configuredSpeakerIp);
            }
          } else {
            setNeedsAuthForLocalMode(true);
          }
        } else if (loggedIn) {
          // Cloud mode - always refresh from server (no local cache for cloud)
          initMode(mode, configuredSpeakerIp);
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.unknownError'));
      setLoading(false);
    } finally {
      initInFlight.current = false;
    }
  }

  async function initMode(mode: SonosMode, speakerIp: string) {
    if (mode === 'local') {
      // Fetch fresh groups from server (cache already applied in init)
      setGroupsLoading(true);
      const { data: groupsData, error: groupsError } = await getLocalGroups(speakerIp || undefined);
      setSonosLinked(true);
      setGroupsLoading(false);

      if (groupsError) {
        setError(groupsError);
        return;
      }

      if (groupsData) {
        const displayGroups: DisplayGroup[] = groupsData.groups.map((g) => ({
          id: g.id,
          name: g.name,
          coordinatorIp: g.coordinatorIp,
        }));
        setGroups(displayGroups);
        // Cache for next time
        await setCachedGroups(displayGroups);
        if (displayGroups.length > 0 && !selectedGroup) {
          setSelectedGroup(displayGroups[0]?.id || '');
        }
      }
    } else {
      const { data: sonosStatus, error: sonosError } = await getSonosStatus();
      if (sonosError) {
        setGroupsLoading(false);
        setError(sonosError);
        return;
      }

      setSonosLinked(sonosStatus?.linked ?? false);

      if (sonosStatus?.linked) {
        const { data: groupsData, error: groupsError } = await getSonosGroups();
        setGroupsLoading(false);

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
      } else {
        setGroupsLoading(false);
      }
    }
  }

  async function handleCast() {
    if (!selectedGroup) return;

    setCasting(true);
    setCastingPhase(t('casting.preparing'));
    setError(null);
    setWarning(null);

    try {
      let targetTabId: number;

      if (selectedSourceTabId !== null) {
        targetTabId = selectedSourceTabId;
      } else {
        setCastingPhase(t('casting.gettingTab'));
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          setError(t('errors.noActiveTab'));
          return;
        }
        targetTabId = tab.id;
      }

      setCastingPhase(t('casting.capturingAudio'));
      const mediaStreamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId,
      });

      const group = groups.find((g) => g.id === selectedGroup);

      setCastingPhase(t('casting.startingStream'));

      // Build metadata from selected source or active tab
      const metadata = {
        title: selectedSource?.title || activeTab?.title || t('media.browserAudio'),
        artist: selectedSource?.artist,
        album: selectedSource?.album,
        artwork: selectedSource?.artwork,
      };

      const response = await chrome.runtime.sendMessage({
        type: 'START_CAST',
        tabId: targetTabId,
        groupId: selectedGroup,
        groupName: group?.name || t('media.unknownGroup'),
        quality,
        mediaStreamId,
        mode: sonosMode,
        coordinatorIp: group?.coordinatorIp,
        metadata,
      });

      if (response?.error) {
        setError(response.error);
      } else {
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
      setError(err instanceof Error ? err.message : t('errors.failedToStartCast'));
    } finally {
      setCasting(false);
      setCastingPhase('');
    }
  }

  async function handleStop() {
    if (stopping) return;
    setStopping(true);
    try {
      await chrome.runtime.sendMessage({
        type: 'STOP_CAST',
        streamId: castStatus.streamId,
        mode: castStatus.mode,
        coordinatorIp: castStatus.coordinatorIp,
      });
      setCastStatus({ isActive: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.failedToStopCast'));
    } finally {
      setStopping(false);
    }
  }

  function getCastButtonLabel(translate: (key: LocaleKey) => string) {
    if (isCurrentTabSelected) {
      const label = selectedSource?.title || activeTab?.title || translate('media.currentTab');
      const truncated = label.slice(0, 20) + (label.length > 20 ? '...' : '');
      return `${translate('actions.cast')}: ${truncated}`;
    } else if (selectedSource?.title) {
      const truncated =
        selectedSource.title.slice(0, 20) + (selectedSource.title.length > 20 ? '...' : '');
      return `${translate('actions.cast')}: ${truncated}`;
    }
    return translate('actions.cast');
  }

  async function switchToLocalMode() {
    // Update settings to use local mode with discovered or default server URL
    await saveExtensionSettings({
      sonosMode: 'local',
      serverUrl: discoveredDesktopUrl || DEFAULT_SERVER_URL,
      backendType: 'desktop',
    });
    setSonosMode('local');
    setDesktopDetected(false);
    setDiscoveredDesktopUrl(null);
    // Re-initialize with local mode
    const settings = await getExtensionSettings();
    await initMode('local', settings.speakerIp || '');
  }

  return {
    loading,
    groupsLoading,
    error,
    setError,
    warning,
    setWarning,
    isLoggedIn,
    desktopDetected,
    needsAuthForLocalMode,
    sonosMode,
    backendType,
    sonosLinked,
    groups,
    castStatus,
    casting,
    castingPhase,
    volume,
    handleVolumeChange,
    isMuted,
    muteLoading,
    handleMuteToggle,
    stopping,
    handleCast,
    handleStop,
    getCastButtonLabel,
    switchToLocalMode,
    reload: init,
  };
}
