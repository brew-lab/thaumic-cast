import type { JSX } from 'preact';
import { useState, useEffect, useCallback, useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  getSpeakerAvailability,
  SPEAKER_AVAILABILITY_LABELS,
  MediaAction,
} from '@thaumic-cast/protocol';
import { Radio, Settings } from 'lucide-preact';
import { Alert, IconButton } from '@thaumic-cast/ui';
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
import { useOnboarding } from './hooks/useOnboarding';
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
  const [selectedIps, setSelectedIps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  // Connection status with instant cached display
  const {
    connected: wsConnected,
    checking: connectionChecking,
    error: connectionError,
    desktopAppUrl: baseUrl,
    networkHealth,
    networkHealthReason,
  } = useConnectionStatus();

  // Media metadata hooks
  const { state: currentTabState } = useCurrentTabState();
  const { casts: activeCasts, stopCast } = useActiveCasts();

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

  // Update selected IPs when groups change
  useEffect(() => {
    if (groups.length > 0 && selectedIps.length === 0) {
      // Default to first group selected
      setSelectedIps([groups[0]!.coordinatorIp]);
    } else if (groups.length === 0 && selectedIps.length > 0) {
      setSelectedIps([]);
    }
  }, [groups, selectedIps.length]);

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
    if (selectedIps.length === 0 || isStarting) return;
    setError(null);
    setIsStarting(true);
    try {
      const msg: StartCastMessage = {
        type: 'START_CAST',
        payload: { speakerIps: selectedIps },
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
  }, [selectedIps, isStarting]);

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

  // Get primary selected speaker's availability for hint text
  const primarySelectedIp = selectedIps[0];
  const selectedAvailability = useMemo(
    () =>
      primarySelectedIp
        ? getSpeakerAvailability(primarySelectedIp, sonosState, castingSpeakerIps)
        : 'available',
    [primarySelectedIp, sonosState, castingSpeakerIps],
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

      {!connectionChecking && !wsConnected && (
        <Alert variant="error" className={styles.alert}>
          {connectionError || t('error_desktop_not_found')}
        </Alert>
      )}

      {!connectionChecking && wsConnected && !sonosLoading && groups.length === 0 && (
        <Alert variant="warning" className={styles.alert}>
          {t('no_speakers_found')}
        </Alert>
      )}

      {wsConnected && networkHealth === 'degraded' && groups.length > 0 && (
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
        showDivider={!!currentTabState && !isCasting}
      />

      {/* Current Tab Media Info with Cast Controls - hidden when already casting */}
      {currentTabState && !isCasting && (
        <CurrentTabCard
          state={currentTabState}
          groups={groups}
          selectedIps={selectedIps}
          onSelectSpeakers={setSelectedIps}
          onStartCast={handleStart}
          isStarting={isStarting}
          disabled={connectionChecking || sonosLoading || !baseUrl}
          speakersLoading={sonosLoading || connectionChecking}
          volume={primarySelectedIp ? getVolume(primarySelectedIp) : 50}
          muted={primarySelectedIp ? isMuted(primarySelectedIp) : false}
          onVolumeChange={(vol) => primarySelectedIp && handleVolumeChange(primarySelectedIp, vol)}
          onMuteToggle={() => primarySelectedIp && handleMuteToggle(primarySelectedIp)}
          showVolumeControls={wsConnected && selectedIps.length > 0}
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
