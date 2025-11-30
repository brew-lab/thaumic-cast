import { useEffect, useRef, useState } from 'preact/hooks';
import type { CastStatus, MediaInfo, QualityPreset, SonosMode } from '@thaumic-cast/shared';
import {
  getGroupVolume,
  getLocalGroups,
  getLocalVolume,
  getSonosGroups,
  getSonosStatus,
  setGroupVolume,
  setLocalVolume,
} from '../../api/client';
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
  const [sonosMode, setSonosMode] = useState<SonosMode>('cloud');
  const [sonosLinked, setSonosLinked] = useState(false);
  const [groups, setGroups] = useState<DisplayGroup[]>([]);
  const [castStatus, setCastStatus] = useState<CastStatus>({ isActive: false });
  const [casting, setCasting] = useState(false);
  const [castingPhase, setCastingPhase] = useState<string>('');
  const [volume, setVolume] = useState<number>(50);
  const [volumeLoading, setVolumeLoading] = useState(false);
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

  // Periodic group refresh during active casting to detect stale state
  useEffect(() => {
    if (!castStatus.isActive || sonosMode !== 'local') return;

    const interval = setInterval(async () => {
      const settings = await getExtensionSettings();
      const { data: groupsData } = await getLocalGroups(settings.speakerIp || undefined);

      if (groupsData) {
        const activeGroup = groupsData.groups.find((g) => g.id === castStatus.groupId);

        if (!activeGroup) {
          setWarning(t('warnings.speakerGroupChanged'));
        } else if (activeGroup.coordinatorIp !== castStatus.coordinatorIp) {
          setWarning(t('warnings.coordinatorChanged'));
        }
      }
    }, 30000);

    return () => clearInterval(interval);
  }, [castStatus.isActive, castStatus.groupId, castStatus.coordinatorIp, sonosMode]);

  // Fetch volume when group is selected or casting starts
  useEffect(() => {
    const groupId = castStatus.isActive ? castStatus.groupId : selectedGroup;
    if (groupId && (sonosLinked || sonosMode === 'local')) {
      fetchVolumeForGroup(groupId);
    }
  }, [selectedGroup, sonosLinked, sonosMode, castStatus.isActive, castStatus.groupId, groups]);

  async function fetchVolumeForGroup(groupId: string) {
    setVolumeLoading(true);

    const group = groups.find((g) => g.id === groupId);
    const volResponse =
      sonosMode === 'local' && group?.coordinatorIp
        ? await getLocalVolume(group.coordinatorIp)
        : await getGroupVolume(groupId);

    if (volResponse.data && !volResponse.error) {
      setVolume(volResponse.data.volume);
    }

    setVolumeLoading(false);
  }

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

        const { error: volError } =
          sonosMode === 'local' && ip
            ? await setLocalVolume(ip, newVolume)
            : await setGroupVolume(groupId, newVolume);

        if (volError) {
          setError(`Volume error: ${volError}`);
        }
      }
    }, 300);
  }

  async function init() {
    if (initInFlight.current) return;
    initInFlight.current = true;
    setLoading(true);
    setError(null);

    try {
      const settings = await getExtensionSettings();
      const mode = settings.sonosMode || 'cloud';
      const configuredSpeakerIp = settings.speakerIp || '';
      setSonosMode(mode);

      const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
      if (response?.status) {
        setCastStatus(response.status as CastStatus);
      }

      // Check session but don't block on it
      const { data: session } = await getSession();
      const loggedIn = !!session?.user;
      setIsLoggedIn(loggedIn);

      // Auto-detect desktop app if not signed in and mode is cloud
      if (!loggedIn && mode === 'cloud') {
        const desktopAvailable = await detectDesktopApp();
        if (desktopAvailable) {
          setDesktopDetected(true);
        }
      }

      // Initialize based on mode and auth state
      if (mode === 'local') {
        // Local mode works without auth
        await initMode(mode, configuredSpeakerIp);
      } else if (loggedIn) {
        // Cloud mode requires auth
        await initMode(mode, configuredSpeakerIp);
      }
      // If cloud mode and not logged in, show disabled state (handled in Popup.tsx)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.unknownError'));
    } finally {
      setLoading(false);
      initInFlight.current = false;
    }
  }

  async function initMode(mode: SonosMode, speakerIp: string) {
    if (mode === 'local') {
      // Step 1: Try to load from cache first (instant)
      const cached = await getCachedGroups();
      if (cached && cached.groups.length > 0) {
        const displayGroups: DisplayGroup[] = cached.groups.map((g) => ({
          id: g.id,
          name: g.name,
          coordinatorIp: g.coordinatorIp,
        }));
        setGroups(displayGroups);
        if (!selectedGroup) {
          setSelectedGroup(displayGroups[0]?.id || '');
        }
        setSonosLinked(true);
        // No loading state needed - cache is instant
        return;
      }

      // Step 2: No cache - fetch from server (show loading state)
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
    // Update settings to use local mode with default server URL
    await saveExtensionSettings({
      sonosMode: 'local',
      serverUrl: DEFAULT_SERVER_URL,
    });
    setSonosMode('local');
    setDesktopDetected(false);
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
    sonosMode,
    sonosLinked,
    groups,
    castStatus,
    casting,
    castingPhase,
    volume,
    volumeLoading,
    handleVolumeChange,
    stopping,
    handleCast,
    handleStop,
    getCastButtonLabel,
    switchToLocalMode,
    reload: init,
  };
}
