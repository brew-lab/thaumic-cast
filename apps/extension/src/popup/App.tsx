import { useState, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { Button, Card } from '@thaumic-cast/ui';
import { createEncoderConfig, getSpeakerStatus } from '@thaumic-cast/protocol';
import { Cast } from 'lucide-preact';
import styles from './App.module.css';
import { ExtensionResponse, StartCastMessage, StopCastMessage } from '../lib/messages';
import type { ZoneGroup } from '@thaumic-cast/protocol';
import { CodecSelector } from './components/CodecSelector';
import { BitrateSelector } from './components/BitrateSelector';
import { CurrentTabCard } from './components/CurrentTabCard';
import { ActiveCastsList } from './components/ActiveCastsList';
import { useAudioSettings } from './hooks/useAudioSettings';
import { useCurrentTabState } from './hooks/useCurrentTabState';
import { useActiveCasts } from './hooks/useActiveCasts';
import { useSonosState } from './hooks/useSonosState';
import { useAutoStopNotification } from './hooks/useAutoStopNotification';
import { useConnectionStatus } from './hooks/useConnectionStatus';

/**
 * Main Extension Popup UI.
 * @returns The rendered popup application
 */
export function App() {
  const { t } = useTranslation();
  const [selectedIp, setSelectedIp] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const { codec, bitrate, setCodec, setBitrate, loading: settingsLoading } = useAudioSettings();

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
   * Triggers the start of a cast session for the current tab.
   */
  const handleStart = async () => {
    if (!selectedIp) return;
    setError(null);
    try {
      const encoderConfig = createEncoderConfig(codec, bitrate);
      const msg: StartCastMessage = {
        type: 'START_CAST',
        payload: { speakerIp: selectedIp, encoderConfig },
      };
      const response: ExtensionResponse = await chrome.runtime.sendMessage(msg);

      if (!response.success) {
        setError(response.error || 'Failed to start');
      }
      // isCasting is derived from activeCasts - will auto-update via ACTIVE_CASTS_CHANGED
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    }
  };

  /**
   * Stops the active cast session for the current tab.
   */
  const handleStop = async () => {
    try {
      const msg: StopCastMessage = { type: 'STOP_CAST' };
      await chrome.runtime.sendMessage(msg);
      // isCasting is derived from activeCasts - will auto-update via ACTIVE_CASTS_CHANGED
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    }
  };

  /**
   * Handles mute toggle.
   * @param speakerIp - The speaker IP to toggle mute for
   */
  const handleMuteToggle = async (speakerIp: string) => {
    const currentMuted = isMuted(speakerIp);
    await setMuted(speakerIp, !currentMuted);
  };

  /**
   * Resolves the CSS class for the status indicator based on current app state.
   * @returns The appropriate CSS class name
   */
  const getStatusClass = () => {
    if (connectionChecking) return styles.statusChecking;
    if (connectionError || !wsConnected) return styles.statusDisconnected;
    return styles.statusConnected;
  };

  /**
   * Gets display name for a group with transport status.
   * @param group - The zone group
   * @returns Display name with optional status
   */
  const getGroupDisplayName = (group: ZoneGroup) => {
    const memberCount = group.members?.length ?? 0;
    const baseName = `${group.name}${memberCount > 1 ? ` (+${memberCount - 1})` : ''}`;
    const status = getSpeakerStatus(group.coordinatorIp, sonosState);
    return status ? `${baseName} • ${status}` : baseName;
  };

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>{t('app_name')}</h1>

      {error && <div className={styles.error}>{error}</div>}

      {/* Current Tab Media Info */}
      {currentTabState && <CurrentTabCard state={currentTabState} />}

      {!isCasting ? (
        <Card title={t('cast_settings')}>
          <div className={styles.field}>
            <label className={styles.label}>{t('target_speaker')}</label>
            <select
              value={selectedIp}
              onChange={(e) => setSelectedIp((e.target as HTMLSelectElement).value)}
              className={styles.select}
            >
              {sonosLoading || connectionChecking ? <option>{t('loading_speakers')}</option> : null}
              {groups.map((g) => (
                <option key={g.id} value={g.coordinatorIp}>
                  {getGroupDisplayName(g)}
                </option>
              ))}
              {!sonosLoading && !connectionChecking && groups.length === 0 && (
                <option value="">{t('no_speakers_found')}</option>
              )}
            </select>
          </div>

          <CodecSelector
            value={codec}
            onChange={setCodec}
            disabled={isCasting || settingsLoading}
          />

          <BitrateSelector
            codec={codec}
            value={bitrate}
            onChange={setBitrate}
            disabled={isCasting || settingsLoading}
          />

          <Button
            onClick={handleStart}
            disabled={connectionChecking || sonosLoading || groups.length === 0 || !baseUrl}
            className={styles.castButton}
          >
            <Cast size={16} />
            {t('start_casting')}
          </Button>

          {/* Volume Controls (available before casting when connected) */}
          {wsConnected && selectedIp && (
            <div className={styles.volumeControl}>
              <div className={styles.volumeHeader}>
                <label className={styles.label}>{t('volume')}</label>
                <button
                  type="button"
                  className={`${styles.muteButton} ${isMuted(selectedIp) ? styles.muted : ''}`}
                  onClick={() => handleMuteToggle(selectedIp)}
                  title={isMuted(selectedIp) ? t('unmute') : t('mute')}
                >
                  {isMuted(selectedIp) ? '🔇' : '🔊'}
                </button>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={getVolume(selectedIp)}
                onChange={(e) =>
                  handleVolumeChange(selectedIp, parseInt((e.target as HTMLInputElement).value, 10))
                }
                className={styles.volumeSlider}
                disabled={isMuted(selectedIp)}
              />
              <span className={styles.volumeValue}>{getVolume(selectedIp)}%</span>
            </div>
          )}
        </Card>
      ) : (
        <Card title={t('casting_active')}>
          <p className={styles.statusMsg}>{t('streaming_msg')}</p>

          {/* Volume Controls */}
          {selectedIp && (
            <div className={styles.volumeControl}>
              <div className={styles.volumeHeader}>
                <label className={styles.label}>{t('volume')}</label>
                <button
                  type="button"
                  className={`${styles.muteButton} ${isMuted(selectedIp) ? styles.muted : ''}`}
                  onClick={() => handleMuteToggle(selectedIp)}
                  title={isMuted(selectedIp) ? t('unmute') : t('mute')}
                >
                  {isMuted(selectedIp) ? '🔇' : '🔊'}
                </button>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={getVolume(selectedIp)}
                onChange={(e) =>
                  handleVolumeChange(selectedIp, parseInt((e.target as HTMLInputElement).value, 10))
                }
                className={styles.volumeSlider}
                disabled={isMuted(selectedIp)}
              />
              <span className={styles.volumeValue}>{getVolume(selectedIp)}%</span>
            </div>
          )}

          <Button variant="danger" onClick={handleStop}>
            {t('stop_casting')}
          </Button>
        </Card>
      )}

      {/* Active Casts List */}
      <ActiveCastsList
        casts={activeCasts}
        getTransportState={getTransportState}
        onStopCast={stopCast}
      />

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
