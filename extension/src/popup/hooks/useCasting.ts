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
import { getExtensionSettings } from '../../lib/settings';
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
  const [sonosMode, setSonosMode] = useState<SonosMode>('cloud');
  const [sonosLinked, setSonosLinked] = useState(false);
  const [groups, setGroups] = useState<DisplayGroup[]>([]);
  const [castStatus, setCastStatus] = useState<CastStatus>({ isActive: false });
  const [casting, setCasting] = useState(false);
  const [castingPhase, setCastingPhase] = useState<string>('');
  const [volume, setVolume] = useState<number>(50);
  const [volumeLoading, setVolumeLoading] = useState(false);
  const volumeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
          setWarning('Speaker group may have changed. Consider stopping and restarting the cast.');
        } else if (activeGroup.coordinatorIp !== castStatus.coordinatorIp) {
          setWarning('Speaker coordinator changed. Audio may not be playing correctly.');
        }
      }
    }, 30000);

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

  function handleVolumeChange(newVolume: number) {
    setVolume(newVolume);
    const groupId = castStatus.isActive ? castStatus.groupId : selectedGroup;

    if (volumeTimeoutRef.current) {
      clearTimeout(volumeTimeoutRef.current);
    }

    volumeTimeoutRef.current = setTimeout(async () => {
      if (groupId) {
        if (sonosMode === 'local') {
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
      const settings = await getExtensionSettings();
      const mode = settings.sonosMode || 'cloud';
      const configuredSpeakerIp = settings.speakerIp || '';
      setSonosMode(mode);

      const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
      if (response?.status) {
        setCastStatus(response.status as CastStatus);
      }

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
        await initLocalMode(configuredSpeakerIp);
      } else {
        await initCloudMode();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  async function initCloudMode() {
    const { data: sonosStatus, error: sonosError } = await getSonosStatus();
    if (sonosError) {
      setError(sonosError);
      return;
    }

    setSonosLinked(sonosStatus?.linked ?? false);

    if (sonosStatus?.linked) {
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
    setSonosLinked(true);
    setGroupsLoading(true);

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
      let targetTabId: number;

      if (selectedSourceTabId !== null) {
        targetTabId = selectedSourceTabId;
      } else {
        setCastingPhase('Getting tab...');
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          setError('No active tab');
          return;
        }
        targetTabId = tab.id;
      }

      setCastingPhase('Capturing audio...');
      const mediaStreamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId,
      });

      const group = groups.find((g) => g.id === selectedGroup);

      setCastingPhase('Starting stream...');
      const response = await chrome.runtime.sendMessage({
        type: 'START_CAST',
        tabId: targetTabId,
        groupId: selectedGroup,
        groupName: group?.name || 'Unknown',
        quality,
        mediaStreamId,
        mode: sonosMode,
        coordinatorIp: group?.coordinatorIp,
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

  function getCastButtonLabel() {
    if (isCurrentTabSelected) {
      const label = selectedSource?.title || activeTab?.title || 'Current Tab';
      const truncated = label.slice(0, 20) + (label.length > 20 ? '...' : '');
      return `Cast: ${truncated}`;
    } else if (selectedSource?.title) {
      const truncated =
        selectedSource.title.slice(0, 20) + (selectedSource.title.length > 20 ? '...' : '');
      return `Cast: ${truncated}`;
    }
    return 'Cast';
  }

  return {
    loading,
    groupsLoading,
    error,
    setError,
    warning,
    setWarning,
    isLoggedIn,
    sonosMode,
    sonosLinked,
    groups,
    castStatus,
    casting,
    castingPhase,
    volume,
    volumeLoading,
    handleVolumeChange,
    handleCast,
    handleStop,
    getCastButtonLabel,
    reload: init,
  };
}
