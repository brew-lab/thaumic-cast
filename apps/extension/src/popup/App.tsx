import type { JSX } from 'preact';
import { useState, useEffect, useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { getSpeakerStatus } from '@thaumic-cast/protocol';
import { Settings } from 'lucide-preact';
import styles from './App.module.css';
import { ExtensionResponse, StartCastMessage } from '../lib/messages';
import type { ZoneGroup } from '@thaumic-cast/protocol';
import { CurrentTabCard } from './components/CurrentTabCard';
import { ActiveCastsList } from './components/ActiveCastsList';
import { useCurrentTabState } from './hooks/useCurrentTabState';
import { useActiveCasts } from './hooks/useActiveCasts';
import { useSonosState } from './hooks/useSonosState';
import { useAutoStopNotification } from './hooks/useAutoStopNotification';
import { useConnectionStatus } from './hooks/useConnectionStatus';

/**
 * Main Extension Popup UI.
 * @returns The rendered popup application
 */
export function App(): JSX.Element {
  const { t } = useTranslation();
  const [selectedIp, setSelectedIp] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  // Connection status with instant cached display
  const {
    connected: wsConnected,
    checking: connectionChecking,
    error: connectionError,
    desktopAppUrl: baseUrl,
  } = useConnectionStatus();

  // Media metadata hooks
  const { state: currentTabState } = useCurrentTabState();
  const { casts: activeCasts, stopCast } = useActiveCasts();

  // Derive isCasting from activeCasts - automatically updates when sessions change
  const isCasting = currentTabState
    ? activeCasts.some((cast) => cast.tabId === currentTabState.tabId)
    : false;

  // Sonos state hook - handles real-time updates
  const {
    state: sonosState,
    groups,
    loading: sonosLoading,
    getVolume,
    getMuted: isMuted,
    getTransportState,
    setVolume: handleVolumeChange,
    setMuted,
  } = useSonosState();

  // Auto-stop notification hook
  const { notification: autoStopNotification } = useAutoStopNotification();

  // Show auto-stop notification as error
  useEffect(() => {
    if (autoStopNotification) {
      setError(autoStopNotification.message);
    }
  }, [autoStopNotification]);

  // Show connection errors (only when not checking)
  useEffect(() => {
    if (!connectionChecking && connectionError) {
      setError(connectionError);
    }
  }, [connectionChecking, connectionError]);

  // Update selected IP when groups change and none is selected
  useEffect(() => {
    if (groups.length > 0 && !selectedIp) {
      setSelectedIp(groups[0]!.coordinatorIp);
    }
  }, [groups, selectedIp]);

  /**
   * Opens the extension settings page.
   */
  const openSettings = useCallback(() => {
    chrome.runtime.openOptionsPage();
  }, []);

  /**
   * Triggers the start of a cast session for the current tab.
   * Uses global audio settings from extension settings (auto-selected by background).
   */
  const handleStart = useCallback(async () => {
    if (!selectedIp || isStarting) return;
    setError(null);
    setIsStarting(true);
    try {
      // Don't pass encoderConfig - background will use extension settings
      const msg: StartCastMessage = {
        type: 'START_CAST',
        payload: { speakerIp: selectedIp },
      };
      const response: ExtensionResponse = await chrome.runtime.sendMessage(msg);

      if (!response.success) {
        setError(response.error || 'Failed to start');
      }
      // isCasting is derived from activeCasts - will auto-update via ACTIVE_CASTS_CHANGED
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setIsStarting(false);
    }
  }, [selectedIp, isStarting]);

  /**
   * Handles mute toggle for a speaker.
   * @param speakerIp - The speaker IP to toggle mute for
   */
  const handleMuteToggle = useCallback(
    async (speakerIp: string) => {
      const currentMuted = isMuted(speakerIp);
      await setMuted(speakerIp, !currentMuted);
    },
    [isMuted, setMuted],
  );

  /**
   * Resolves the CSS class for the status indicator based on current app state.
   * @returns The appropriate CSS class name
   */
  const getStatusClass = useCallback(() => {
    if (connectionChecking) return styles.statusChecking;
    if (connectionError || !wsConnected) return styles.statusDisconnected;
    return styles.statusConnected;
  }, [connectionChecking, connectionError, wsConnected]);

  /**
   * Gets display name for a group with transport status.
   * @param group - The zone group
   * @returns Display name with optional status
   */
  const getGroupDisplayName = useCallback(
    (group: ZoneGroup) => {
      const memberCount = group.members?.length ?? 0;
      const baseName = `${group.name}${memberCount > 1 ? ` (+${memberCount - 1})` : ''}`;
      const status = getSpeakerStatus(group.coordinatorIp, sonosState);
      return status ? `${baseName} • ${status}` : baseName;
    },
    [sonosState],
  );

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>{t('app_name')}</h1>
        <button
          type="button"
          className={styles.settingsButton}
          onClick={openSettings}
          title={t('settings')}
          aria-label={t('settings')}
        >
          <Settings size={18} />
        </button>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {/* Active Casts List with Volume Controls */}
      <ActiveCastsList
        casts={activeCasts}
        getTransportState={getTransportState}
        getVolume={getVolume}
        isMuted={isMuted}
        onVolumeChange={handleVolumeChange}
        onMuteToggle={handleMuteToggle}
        onStopCast={stopCast}
        showDivider={!!currentTabState && !isCasting}
      />

      {/* Current Tab Media Info with Cast Controls - hidden when already casting */}
      {currentTabState && !isCasting && (
        <CurrentTabCard
          state={currentTabState}
          groups={groups}
          selectedIp={selectedIp}
          onSelectSpeaker={setSelectedIp}
          onStartCast={handleStart}
          isStarting={isStarting}
          disabled={connectionChecking || sonosLoading || !baseUrl}
          speakersLoading={sonosLoading || connectionChecking}
          volume={getVolume(selectedIp)}
          muted={isMuted(selectedIp)}
          onVolumeChange={(vol) => handleVolumeChange(selectedIp, vol)}
          onMuteToggle={() => handleMuteToggle(selectedIp)}
          showVolumeControls={wsConnected && !!selectedIp}
          getGroupDisplayName={getGroupDisplayName}
        />
      )}

      <p className={styles.footer}>
        {t('desktop_app_status')}:{' '}
        <span className={`${styles.status} ${getStatusClass()}`}>
          {connectionChecking
            ? t('status_checking')
            : wsConnected
              ? t('status_connected')
              : t('status_disconnected')}
        </span>
      </p>
    </div>
  );
}
