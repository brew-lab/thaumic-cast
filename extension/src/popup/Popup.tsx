import { useState, useEffect, useRef } from 'preact/hooks';
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
import type { CastStatus, QualityPreset, SonosMode } from '@thaumic-cast/shared';

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
      // Get current tab
      setCastingPhase('Getting tab...');
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setError('No active tab');
        return;
      }

      // Get media stream ID for tab capture
      setCastingPhase('Capturing audio...');
      const mediaStreamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: tab.id,
      });

      const group = groups.find((g) => g.id === selectedGroup);

      // Send to background with mode info
      setCastingPhase('Starting stream...');
      const response = await chrome.runtime.sendMessage({
        type: 'START_CAST',
        tabId: tab.id,
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
          tabId: tab.id,
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
            {casting ? castingPhase || 'Starting...' : 'Cast This Tab'}
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
