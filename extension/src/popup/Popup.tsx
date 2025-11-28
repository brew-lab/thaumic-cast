import { useState, useEffect, useRef } from 'preact/hooks';
import { getSession } from '../lib/auth-client';
import { getSonosStatus, getSonosGroups, getGroupVolume, setGroupVolume } from '../api/client';
import type { CastStatus, QualityPreset, SonosGroup } from '@thaumic-cast/shared';

export function Popup() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [sonosLinked, setSonosLinked] = useState(false);
  const [groups, setGroups] = useState<SonosGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string>('');
  const [quality, setQuality] = useState<QualityPreset>('medium');
  const [castStatus, setCastStatus] = useState<CastStatus>({ isActive: false });
  const [casting, setCasting] = useState(false);
  const [volume, setVolume] = useState<number>(50);
  const [volumeLoading, setVolumeLoading] = useState(false);
  const volumeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    init();
  }, []);

  // Fetch volume when group is selected or casting starts
  useEffect(() => {
    const groupId = castStatus.isActive ? castStatus.groupId : selectedGroup;
    if (groupId && sonosLinked) {
      fetchVolume(groupId);
    }
  }, [selectedGroup, sonosLinked, castStatus.isActive, castStatus.groupId]);

  async function fetchVolume(groupId: string) {
    setVolumeLoading(true);
    const { data, error: volError } = await getGroupVolume(groupId);
    if (data && !volError) {
      setVolume(data.volume);
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
        const { error: volError } = await setGroupVolume(groupId, newVolume);
        if (volError) {
          setError(`Volume error: ${volError}`);
        }
      }
    }, 300);
  }

  async function init() {
    setLoading(true);
    setError(null);

    try {
      // Get current cast status from background
      const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
      if (response?.status) {
        setCastStatus(response.status as CastStatus);
      }

      // Check auth status using Better Auth client
      const { data: session, error: sessionError } = await getSession();

      if (sessionError) {
        // Not logged in or error - show login prompt
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

      // Check Sonos link status
      const { data: sonosStatus, error: sonosError } = await getSonosStatus();
      if (sonosError) {
        setError(sonosError);
        setLoading(false);
        return;
      }

      setSonosLinked(sonosStatus?.linked ?? false);

      if (sonosStatus?.linked) {
        // Fetch Sonos groups
        const { data: groupsData, error: groupsError } = await getSonosGroups();
        if (groupsError) {
          setError(groupsError);
        } else if (groupsData) {
          setGroups(groupsData.groups);
          if (groupsData.groups.length > 0 && !selectedGroup) {
            setSelectedGroup(groupsData.groups[0]?.id || '');
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  async function handleCast() {
    if (!selectedGroup) return;

    setCasting(true);
    setError(null);

    try {
      // Get current tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setError('No active tab');
        return;
      }

      // Get media stream ID for tab capture
      const mediaStreamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: tab.id,
      });

      const group = groups.find((g) => g.id === selectedGroup);

      // Send to background
      const response = await chrome.runtime.sendMessage({
        type: 'START_CAST',
        tabId: tab.id,
        groupId: selectedGroup,
        groupName: group?.name || 'Unknown',
        quality,
        mediaStreamId,
      });

      if (response?.error) {
        setError(response.error);
      } else {
        setCastStatus({
          isActive: true,
          streamId: response.streamId,
          tabId: tab.id,
          groupId: selectedGroup,
          groupName: group?.name,
          quality,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start cast');
    } finally {
      setCasting(false);
    }
  }

  async function handleStop() {
    try {
      await chrome.runtime.sendMessage({
        type: 'STOP_CAST',
        streamId: castStatus.streamId,
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

  if (!sonosLinked) {
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

  return (
    <div>
      <Header onSettings={openOptions} />

      {error && (
        <p class="error-message" role="alert">
          {error}
        </p>
      )}

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

          <button class="btn btn-primary" onClick={handleCast} disabled={casting || !selectedGroup}>
            {casting ? 'Starting...' : 'Cast This Tab'}
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
