import type { JSX } from 'preact';
import { useState, useEffect, useCallback, useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { MediaAction } from '@thaumic-cast/protocol';
import { getSpeakerAvailability } from '@thaumic-cast/protocol';
import { GITHUB_RELEASES_URL } from '@thaumic-cast/shared';
import {
  BrandBlock,
  Button,
  IconButton,
  Notice,
  StatusDot,
  type StatusDotState,
} from '@thaumic-cast/ui';
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
import { useSpeakerSelection } from './hooks/useSpeakerSelection';
import { useStartLimit } from './hooks/useStartLimit';
import { pendingStartsFor, withPendingStart } from '../lib/start-level';
import { useCompanionVersion } from './hooks/useCompanionVersion';
import { useCaptureHealth } from './hooks/useCaptureHealth';
import { useSpeakerNotices } from './hooks/useSpeakerNotices';
import { useIngestGaps } from './hooks/useIngestGaps';
import type { NoticeLine } from '../lib/speaker-notices';
import { captureHealthAlert, retryLabelKey } from '../lib/popup-copy';
import { isWindowsPlatform } from '../lib/settings';
import { companionTypeLabelKey, versionMismatchActionKey } from '../lib/versionCheck';
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

  // Connection status with instant cached display
  const connection = useConnectionStatus();
  const {
    phase: connectionPhase,
    error: connectionError,
    canRetry: connectionCanRetry,
    desktopAppUrl: baseUrl,
    networkHealth,
    networkHealthReason,
    retry: handleRetryConnection,
  } = connection;

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
    getVolumeFixed,
    getTransportState,
    setVolume: handleVolumeChange,
    setMuted,
    setSyncGroupVolume,
    setSyncGroupMuted,
  } = useSonosState();

  // Speaker selection with auto-select behavior
  const { selectedIps, setSelectedIps, selectedAvailability } = useSpeakerSelection(
    speakerGroups,
    sonosState,
    castingSpeakerIps,
  );

  // Start levels: the limit from the settings, and any level set by hand
  // before Cast. These stay in the popup until Cast; no speaker is touched.
  const startLimit = useStartLimit();
  const [pendingStarts, setPendingStarts] = useState<Record<string, number>>({});
  const handleStartLevelChange = useCallback((speakerIp: string, level: number) => {
    setPendingStarts((prev) => withPendingStart(prev, speakerIp, level));
  }, []);

  // Auto-stop notification hook
  const { notification: autoStopNotification, message: autoStopMessage } = useAutoStopNotification(
    (ip) => speakerGroups.getGroupName(ip) || ip,
  );

  // Companion version mismatch warning
  const { companion, hasMismatch, showMismatchWarning, dismissMismatchWarning } =
    useCompanionVersion(connection);

  // Capture-health alert (LoopbackStream frame drops on low-core Windows)
  const { showAlert: showCaptureHealthAlert, dismiss: dismissCaptureHealthAlert } =
    useCaptureHealth();

  const frameDropAlert = captureHealthAlert(isWindowsPlatform());

  // Speaker notices (the companion decided a casting speaker cut out, came
  // close, or is running low, and says what would help)
  const { notices: speakerNotices, dismiss: dismissSpeakerNotice } = useSpeakerNotices(
    activeCasts,
    speakerGroups,
    { companionAudio: connection.companionAudio, appType: connection.appType },
  );

  // Ingest-gap notices (audio from this browser reached the companion late,
  // so every speaker had a gap)
  const { notices: ingestGapsNotices, dismiss: dismissIngestGapsNotice } = useIngestGaps(
    activeCasts,
    connection.appType,
  );

  const handleOpenReleases = useCallback(() => {
    chrome.tabs.create({ url: GITHUB_RELEASES_URL });
  }, []);

  const mismatchActionKey = versionMismatchActionKey(companion?.appType);
  const mismatchAppTypeLabel = t(companionTypeLabelKey(companion?.appType));

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
   * Opens the extension settings at the audio section's advanced options,
   * where smoothing is set.
   */
  const openAudioAdvancedSettings = useCallback(() => {
    const page = chrome.runtime.getManifest().options_page ?? 'src/options/index.html';
    chrome.tabs.create({ url: chrome.runtime.getURL(`${page}#audio-advanced`) });
  }, []);

  /**
   * Translates the sentences of a notice and joins them into one message.
   * @param lines - The sentences, in order
   * @returns The message to show
   */
  const noticeText = useCallback(
    (lines: NoticeLine[]) => lines.map((line) => t(line.key, line.params)).join(' '),
    [t],
  );

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
        payload: {
          speakerIps: selectedIps,
          startLevels: pendingStartsFor(selectedIps, pendingStarts),
        },
      };
      const response: ExtensionResponse = await chrome.runtime.sendMessage(msg);

      if (!response.success) {
        const msg = response.error
          ? t(response.error, response.errorParams ?? {})
          : t('error_cast_failed');
        setError(msg);
        throw new Error(msg);
      }
      // Hand-set levels are for this cast only.
      setPendingStarts({});
      // isCasting is derived from activeCasts - will auto-update via ACTIVE_CASTS_CHANGED
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    }
  }, [selectedIps, pendingStarts, t]);

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
   * Handles sync group volume change for all speakers in a cast.
   * @param speakerIps - All speaker IPs in the sync group
   * @param volume - The volume level (0-100)
   */
  const handleSyncGroupVolumeChange = useCallback(
    async (speakerIps: string[], volume: number) => {
      await setSyncGroupVolume(speakerIps[0], volume);
    },
    [setSyncGroupVolume],
  );

  /**
   * Handles sync group mute toggle for all speakers in a cast.
   * @param speakerIps - All speaker IPs in the sync group
   */
  const handleSyncGroupMuteToggle = useCallback(
    async (speakerIps: string[], muted: boolean) => {
      await setSyncGroupMuted(speakerIps[0], muted, speakerIps);
    },
    [setSyncGroupMuted],
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
   * The footer's status mark: checking while seeking, failed when disconnected.
   * @returns The StatusDot state
   */
  const statusDot = useCallback((): StatusDotState => {
    if (isSeeking) return 'checking';
    if (connectionPhase === 'error' || !wsConnected) return 'failed';
    return 'connected';
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
      const label = t(`speaker_availability_${availability}`);
      return `${group.name} • ${label}`;
    },
    [sonosState, castingSpeakerIps, t],
  );

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <BrandBlock name={t('app_name')} heading lit={activeCasts.length > 0} />
        <IconButton glyph="settings" kind="tonal" label={t('settings')} onPress={openSettings} />
      </div>

      {/* Notices stay where they were; Phase 3 places them at their source (NoticeSlot). */}
      <div className={styles.notices}>
        {error && (
          <Notice
            tone="danger"
            text={error}
            onDismiss={() => setError(null)}
            dismissLabel={t('dismiss')}
          />
        )}

        {connectionPhase === 'reconnecting' && (
          <Notice tone="warning" text={t('warning_reconnecting')} />
        )}

        {showMismatchWarning && companion && (
          <Notice
            tone="warning"
            text={
              companion.appVersion
                ? t('version_mismatch_message', {
                    appTypeLabel: mismatchAppTypeLabel,
                    appVersion: companion.appVersion,
                  })
                : t('version_mismatch_unknown_message')
            }
            action={{ label: t(mismatchActionKey), onClick: handleOpenReleases }}
            onDismiss={dismissMismatchWarning}
            dismissLabel={t('dismiss')}
          />
        )}

        {connectionPhase === 'error' && connectionError && (
          <Notice
            tone="danger"
            text={t(connectionError, { defaultValue: connectionError })}
            action={
              connectionCanRetry
                ? { label: t(retryLabelKey(connectionError)), onClick: handleRetryConnection }
                : undefined
            }
          />
        )}

        {wsConnected && !sonosLoading && speakerGroups.isEmpty && (
          <Notice tone="warning" text={t('no_speakers_found')} />
        )}

        {wsConnected && networkHealth === 'degraded' && !speakerGroups.isEmpty && (
          <Notice
            tone="warning"
            text={t(`network.${networkHealthReason}`, {
              defaultValue: t('network.speakers_not_responding'),
            })}
          />
        )}

        {wsConnected && showCaptureHealthAlert && (
          <Notice
            tone="warning"
            text={t(frameDropAlert.key)}
            action={
              frameDropAlert.hasAction
                ? { label: t('capture_health_action_open_settings'), onClick: openSettings }
                : undefined
            }
            onDismiss={dismissCaptureHealthAlert}
            dismissLabel={t('dismiss')}
          />
        )}

        {wsConnected &&
          speakerNotices.map((view) => (
            <Notice
              key={`notice-${view.speakerIp}`}
              tone="warning"
              text={noticeText(view.lines)}
              onDismiss={() => dismissSpeakerNotice(view.speakerIp)}
              dismissLabel={t('speaker_notice_dismiss')}
            />
          ))}

        {/* A capture-health notice already explains late audio from this browser. */}
        {wsConnected &&
          !showCaptureHealthAlert &&
          ingestGapsNotices.map((view) => (
            <Notice
              key={`ingest-${view.streamId}`}
              tone="warning"
              text={noticeText([view.line])}
              action={
                view.hasRemedy
                  ? {
                      label: t('ingest_gaps_action_open_settings'),
                      onClick: openAudioAdvancedSettings,
                    }
                  : undefined
              }
              onDismiss={() => dismissIngestGapsNotice(view.streamId)}
              dismissLabel={t('speaker_notice_dismiss')}
            />
          ))}
      </div>

      {/* Active Casts List with Volume Controls */}
      <ActiveCastsList
        casts={activeCasts}
        getTransportState={getTransportState}
        getVolume={getVolume}
        isMuted={isMuted}
        getVolumeFixed={getVolumeFixed}
        onVolumeChange={handleVolumeChange}
        onMuteToggle={handleMuteToggle}
        onStopCast={stopCast}
        onControl={handleControl}
        onRemoveSpeaker={removeSpeaker}
        showDivider={!!currentTabState && !isCasting}
        onSyncGroupVolumeChange={handleSyncGroupVolumeChange}
        onSyncGroupMuteToggle={handleSyncGroupMuteToggle}
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
          getVolumeFixed={getVolumeFixed}
          startLimit={startLimit}
          pendingStarts={pendingStarts}
          onStartLevelChange={handleStartLevelChange}
          showVolumeControls={wsConnected && selectedIps.length > 0}
          getGroupDisplayName={getGroupDisplayName}
          getSpeakerName={(ip) => speakerGroups.getGroupName(ip)}
          selectedAvailability={selectedAvailability}
        />
      )}

      <p className={styles.footer}>
        <span className={styles.status}>
          <StatusDot state={statusDot()} />
          {isSeeking && t('connection_status_checking')}
          {connectionPhase === 'connected' &&
            t(
              connection.appType === 'desktop'
                ? 'connection_status_connected_desktop'
                : connection.appType === 'server'
                  ? 'connection_status_connected_server'
                  : 'connection_status_connected',
            )}
          {connectionPhase === 'error' && t('connection_status_disconnected')}
        </span>
        {hasMismatch && wsConnected && (
          <>
            {' · '}
            <Button kind="link" icon="external" onClick={handleOpenReleases}>
              {t('update_available')}
            </Button>
          </>
        )}
      </p>
    </div>
  );
}
