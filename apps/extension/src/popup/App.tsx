import type { JSX } from 'preact';
import { useState, useEffect, useCallback, useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  getSpeakerAvailability,
  SPEAKER_AVAILABILITY_LABELS,
  MediaAction,
} from '@thaumic-cast/protocol';
import { Radio, Settings, X } from 'lucide-preact';
import { IconButton } from '@thaumic-cast/ui';
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

  // Derive casting speaker IPs for availability status
  const castingSpeakerIps = useMemo(() => activeCasts.map((cast) => cast.speakerIp), [activeCasts]);

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
        setError(response.error || t('error_cast_failed'));
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
   * Handles playback control for a tab.
   * @param tabId - The tab ID to control
   * @param action - The media action to perform
   */
  const handleControl = useCallback((tabId: number, action: MediaAction) => {
    chrome.runtime.sendMessage({
      type: 'CONTROL_MEDIA',
      payload: { tabId, action },
    });
  }, []);

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
   * Gets display name for a group with availability status.
   * @param group - The zone group
   * @returns Display name with availability status
   */
  const getGroupDisplayName = useCallback(
    (group: ZoneGroup) => {
      const availability = getSpeakerAvailability(
        group.coordinatorIp,
        sonosState,
        castingSpeakerIps,
      );
      const label = SPEAKER_AVAILABILITY_LABELS[availability];
      return `${group.name} • ${label}`;
    },
    [sonosState, castingSpeakerIps],
  );

  // Get selected speaker's availability for hint text
  const selectedAvailability = useMemo(
    () =>
      selectedIp ? getSpeakerAvailability(selectedIp, sonosState, castingSpeakerIps) : 'available',
    [selectedIp, sonosState, castingSpeakerIps],
  );

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <Radio size={20} color="var(--color-primary)" />
          <h1 className={styles.title}>{t('app_name')}</h1>
        </div>
        <IconButton onClick={openSettings} title={t('settings')} aria-label={t('settings')}>
          <Settings size={18} />
        </IconButton>
      </div>

      {error && (
        <div className={styles.error}>
          <span className={styles.errorMessage}>{error}</span>
          <IconButton
            size="sm"
            className={styles.errorDismiss}
            onClick={() => setError(null)}
            aria-label={t('dismiss')}
          >
            <X size={14} />
          </IconButton>
        </div>
      )}

      {/* Active Casts List with Volume Controls */}
      <ActiveCastsList
        casts={activeCasts}
        getTransportState={getTransportState}
        getVolume={getVolume}
        isMuted={isMuted}
        onVolumeChange={handleVolumeChange}
        onMuteToggle={handleMuteToggle}
        onStopCast={stopCast}
        onControl={handleControl}
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
          selectedAvailability={selectedAvailability}
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
