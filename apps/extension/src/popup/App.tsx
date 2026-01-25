import type { JSX } from 'preact';
import { useState, useEffect, useCallback, useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { SPEAKER_AVAILABILITY_LABELS, MediaAction } from '@thaumic-cast/protocol';
import { getSpeakerAvailability } from '@thaumic-cast/protocol';
import { Radio, Settings } from 'lucide-preact';
import { Alert, IconButton } from '@thaumic-cast/ui';
import styles from './App.module.css';
import type {
  ExtensionResponse,
  StartCastMessage,
  SpeakerStopFailedMessage,
} from '../lib/messages';
import { useChromeMessage } from './hooks/useChromeMessage';
import type { SpeakerGroup } from '../domain/speaker';
import { CurrentTabCard } from './components/CurrentTabCard';
import { ActiveCastsList } from './components/ActiveCastsList';
import { useCurrentTabState } from './hooks/useCurrentTabState';
import { useActiveCasts } from './hooks/useActiveCasts';
import { useSonosState } from './hooks/useSonosState';
import { useAutoStopNotification } from './hooks/useAutoStopNotification';
import { useConnectionStatus } from './hooks/useConnectionStatus';
import { useOnboarding } from './hooks/useOnboarding';
import { useExtensionSettingsListener } from './hooks/useExtensionSettingsListener';
import { useSpeakerSelection } from './hooks/useSpeakerSelection';
import { Onboarding } from './components/Onboarding';

/**
 * Main Extension Popup UI.
 * @returns The rendered popup application
 */
export function App(): JSX.Element {
  const {
    isLoading: onboardingLoading,
    isComplete: onboardingComplete,
    completeOnboarding,
    skipOnboarding,
  } = useOnboarding();

  // Show nothing while loading onboarding state
  if (onboardingLoading) {
    return <div className={styles.container} />;
  }

  // Show onboarding for first-time users
  if (!onboardingComplete) {
    return <Onboarding onComplete={completeOnboarding} onSkip={skipOnboarding} />;
  }

  return <MainPopup />;
}

/**
 * Main popup content after onboarding is complete.
 * @returns The rendered main popup
 */
function MainPopup(): JSX.Element {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);

  // Extension settings with live updates
  const { videoSyncEnabled } = useExtensionSettingsListener();

  // Connection status with instant cached display
  const {
    phase: connectionPhase,
    error: connectionError,
    canRetry: connectionCanRetry,
    desktopAppUrl: baseUrl,
    networkHealth,
    networkHealthReason,
    retry: handleRetryConnection,
  } = useConnectionStatus();

  // Derived states for convenience
  const wsConnected = connectionPhase === 'connected';
  const isSeeking = connectionPhase === 'checking' || connectionPhase === 'reconnecting';

  // Media metadata hooks
  const { state: currentTabState } = useCurrentTabState();
  const { casts: activeCasts, stopCast, removeSpeaker } = useActiveCasts();

  // Derive isCasting from activeCasts - automatically updates when sessions change
  const isCasting = currentTabState
    ? activeCasts.some((cast) => cast.tabId === currentTabState.tabId)
    : false;

  // Derive casting speaker IPs for availability status (flatten all speaker arrays)
  const castingSpeakerIps = useMemo(
    () => activeCasts.flatMap((cast) => cast.speakerIps),
    [activeCasts],
  );

  // Sonos state hook - handles real-time updates
  const {
    state: sonosState,
    speakerGroups,
    loading: sonosLoading,
    getVolume,
    getMuted: isMuted,
    getTransportState,
    setVolume: handleVolumeChange,
    setMuted,
  } = useSonosState();

  // Speaker selection with auto-select behavior
  const { selectedIps, setSelectedIps, selectedAvailability } = useSpeakerSelection(
    speakerGroups,
    sonosState,
    castingSpeakerIps,
  );

  // Auto-stop notification hook
  const { notification: autoStopNotification, message: autoStopMessage } =
    useAutoStopNotification();

  // Show auto-stop notification as error
  useEffect(() => {
    if (autoStopNotification && autoStopMessage) {
      setError(autoStopMessage);
    }
  }, [autoStopNotification, autoStopMessage]);

  // Handle speaker stop failure notifications
  useChromeMessage((message) => {
    const msg = message as { type: string };
    if (msg.type === 'SPEAKER_STOP_FAILED') {
      const failedMsg = message as SpeakerStopFailedMessage;
      const name = speakerGroups.getGroupName(failedMsg.speakerIp) || failedMsg.speakerIp;
      setError(t('error_speaker_stop_failed', { name }));
    }
  });

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
    if (selectedIps.length === 0) return;
    setError(null);
    try {
      const msg: StartCastMessage = {
        type: 'START_CAST',
        payload: { speakerIps: selectedIps },
      };
      const response: ExtensionResponse = await chrome.runtime.sendMessage(msg);

      if (!response.success) {
        const msg = response.error ? t(response.error) : t('error_cast_failed');
        setError(msg);
        throw new Error(msg);
      }
      // isCasting is derived from activeCasts - will auto-update via ACTIVE_CASTS_CHANGED
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    }
  }, [selectedIps, t]);

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
    if (isSeeking) return styles.statusChecking;
    if (connectionPhase === 'error' || !wsConnected) return styles.statusDisconnected;
    return styles.statusConnected;
  }, [isSeeking, connectionPhase, wsConnected]);

  /**
   * Gets display name for a group with availability status.
   * @param group - The speaker group
   * @returns Display name with availability status
   */
  const getGroupDisplayName = useCallback(
    (group: SpeakerGroup) => {
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
        <Alert variant="error" className={styles.alert} onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {connectionPhase === 'reconnecting' && (
        <Alert variant="warning" className={styles.alert}>
          {t('warning_reconnecting')}
        </Alert>
      )}

      {connectionPhase === 'error' && connectionError && (
        <Alert
          variant="error"
          className={styles.alert}
          action={connectionCanRetry ? t('retry_connection') : undefined}
          onAction={connectionCanRetry ? handleRetryConnection : undefined}
        >
          {t(connectionError, { defaultValue: connectionError })}
        </Alert>
      )}

      {wsConnected && !sonosLoading && speakerGroups.isEmpty && (
        <Alert variant="warning" className={styles.alert}>
          {t('no_speakers_found')}
        </Alert>
      )}

      {wsConnected && networkHealth === 'degraded' && !speakerGroups.isEmpty && (
        <Alert variant="warning" className={styles.alert}>
          {t(`network.${networkHealthReason}`, {
            defaultValue: t('network.speakers_not_responding'),
          })}
        </Alert>
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
        onRemoveSpeaker={removeSpeaker}
        showDivider={!!currentTabState && !isCasting}
        videoSyncEnabled={videoSyncEnabled}
      />

      {/* Current Tab Media Info with Cast Controls - hidden when already casting */}
      {currentTabState && !isCasting && (
        <CurrentTabCard
          state={currentTabState}
          groups={speakerGroups.groups}
          selectedIps={selectedIps}
          onSelectSpeakers={setSelectedIps}
          onStartCast={handleStart}
          disabled={isSeeking || sonosLoading || !baseUrl}
          speakersLoading={sonosLoading || isSeeking}
          getVolume={getVolume}
          isMuted={isMuted}
          onVolumeChange={handleVolumeChange}
          onMuteToggle={handleMuteToggle}
          showVolumeControls={wsConnected && selectedIps.length > 0}
          getGroupDisplayName={getGroupDisplayName}
          getSpeakerName={(ip) => speakerGroups.getGroupName(ip)}
          selectedAvailability={selectedAvailability}
        />
      )}

      <p className={styles.footer}>
        {t('desktop_app_status')}:{' '}
        <span className={`${styles.status} ${getStatusClass()}`}>
          {isSeeking && t('status_checking')}
          {connectionPhase === 'connected' && t('status_connected')}
          {connectionPhase === 'error' && t('status_disconnected')}
        </span>
      </p>
    </div>
  );
}
