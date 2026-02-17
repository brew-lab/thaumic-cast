import { type JSX, type CSSProperties } from 'preact';
import { flushSync } from 'preact/compat';
import { useCallback, useState, useRef, useEffect, useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { ActiveCast, TransportState, MediaAction } from '@thaumic-cast/protocol';
import { getDisplayTitle, getDisplayImage, getDisplaySubtitle } from '@thaumic-cast/protocol';
import { X, Play, Pause, SkipBack, SkipForward, RefreshCw } from 'lucide-preact';
import { IconButton, SpeakerVolumeRow, ToggleSwitch, StatusChip, Card } from '@thaumic-cast/ui';
import { TransportIcon } from './TransportIcon';
import { useDominantColor } from '../hooks/useDominantColor';
import { useVideoSyncState } from '../hooks/useVideoSyncState';
import { useOptimisticOverlay } from '../hooks/useOptimisticOverlay';
import styles from './ActiveCastCard.module.css';

/** Debounce interval for playback control buttons (ms) */
const CONTROL_DEBOUNCE_MS = 300;

interface ActiveCastCardProps {
  /** The active cast session */
  cast: ActiveCast;
  /** Function to get transport state for a speaker IP */
  getTransportState?: (speakerIp: string) => TransportState | undefined;
  /** Function to get volume for a speaker IP */
  getVolume: (speakerIp: string) => number;
  /** Function to check if a speaker is muted */
  isMuted: (speakerIp: string) => boolean;
  /** Function to check if a speaker has fixed volume (line-level output) */
  getVolumeFixed?: (speakerIp: string) => boolean;
  /** Callback when volume changes for a speaker */
  onVolumeChange: (speakerIp: string, volume: number) => void;
  /** Callback when mute is toggled for a speaker */
  onMuteToggle: (speakerIp: string) => void;
  /** Callback when stop button is clicked */
  onStop: () => void;
  /** Callback when playback control is triggered */
  onControl?: (action: MediaAction) => void;
  /** Callback when a speaker remove button is clicked */
  onRemoveSpeaker?: (speakerIp: string) => void;
  /** Whether video sync controls should be shown (from global settings) */
  videoSyncEnabled?: boolean;
  /** Callback when sync group volume changes (all speakers at once) */
  onSyncGroupVolumeChange: (speakerIps: string[], volume: number) => void;
  /** Callback when sync group mute is toggled (all speakers at once) */
  onSyncGroupMuteToggle: (speakerIps: string[], muted: boolean) => void;
}

/**
 * Displays an active cast session with volume controls and stop button.
 * @param props - Component props
 * @param props.cast
 * @param props.getTransportState
 * @param props.getVolume
 * @param props.isMuted
 * @param props.getVolumeFixed
 * @param props.onVolumeChange
 * @param props.onMuteToggle
 * @param props.onStop
 * @param props.onControl
 * @param props.onRemoveSpeaker
 * @param props.videoSyncEnabled
 * @param props.onSyncGroupVolumeChange
 * @param props.onSyncGroupMuteToggle
 * @returns The rendered ActiveCastCard component
 */
export function ActiveCastCard({
  cast,
  getTransportState,
  getVolume,
  isMuted,
  getVolumeFixed,
  onVolumeChange,
  onMuteToggle,
  onStop,
  onControl,
  onRemoveSpeaker,
  videoSyncEnabled: showVideoSync = false,
  onSyncGroupVolumeChange,
  onSyncGroupMuteToggle,
}: ActiveCastCardProps): JSX.Element {
  const { t } = useTranslation();

  const title = getDisplayTitle(cast.mediaState);
  const image = getDisplayImage(cast.mediaState);
  const subtitle = getDisplaySubtitle(cast.mediaState);
  const favicon = cast.mediaState.tabFavicon;
  const supportedActions = cast.mediaState.supportedActions ?? [];

  // Stage image updates to enable view transitions on track changes
  const [stagedImage, setStagedImage] = useState(image);

  useEffect(() => {
    if (image !== stagedImage) {
      // Trigger view transition when image changes (skip initial render)
      if (stagedImage !== undefined && document.startViewTransition) {
        document.startViewTransition(() => {
          flushSync(() => setStagedImage(image));
        });
      } else {
        setStagedImage(image);
      }
    }
  }, [image, stagedImage]);

  // Determine which playback controls to show
  const canPrev = supportedActions.includes('previoustrack');
  const canNext = supportedActions.includes('nexttrack');
  const canPlay = supportedActions.includes('play');
  const canPause = supportedActions.includes('pause');

  // Get playback state from MediaSession (via background cache)
  const playbackState = cast.mediaState.playbackState ?? 'none';
  const isPlaying = playbackState === 'playing';

  // Optimistic UI for immediate feedback before site confirms
  const [displayIsPlaying, setOptimisticPlaying] = useOptimisticOverlay(isPlaying);

  // Debounce ref to prevent rapid clicking
  const lastControlTime = useRef<Record<string, number>>({});

  // Extract dominant color from artwork for backdrop tinting
  const dominantColor = useDominantColor(stagedImage);

  // Video sync state and controls
  const videoSync = useVideoSyncState(showVideoSync ? cast.tabId : undefined);

  // Sync group volume: show group control when sync is active with multiple speakers
  const showGroupVolume = cast.syncSpeakers && cast.speakerIps.length > 1;
  const groupVolume = useMemo(() => {
    if (!showGroupVolume) return 0;
    const sum = cast.speakerIps.reduce((acc, ip) => acc + getVolume(ip), 0);
    return Math.round(sum / cast.speakerIps.length);
  }, [showGroupVolume, cast.speakerIps, getVolume]);
  const groupMuted = useMemo(() => {
    if (!showGroupVolume) return false;
    return cast.speakerIps.every((ip) => isMuted(ip));
  }, [showGroupVolume, cast.speakerIps, isMuted]);
  const groupName = cast.speakerNames.join(' + ');

  /**
   * Navigates to the tab associated with this cast session.
   */
  const goToTab = useCallback(() => {
    chrome.tabs.update(cast.tabId, { active: true });
  }, [cast.tabId]);

  /**
   * Handles playback control with debounce to prevent rapid clicks.
   * @param action - The media action to perform
   */
  const handleControl = useCallback(
    (action: MediaAction) => {
      if (!onControl) return;

      const now = Date.now();
      const lastTime = lastControlTime.current[action] ?? 0;

      // Skip if clicked too recently
      if (now - lastTime < CONTROL_DEBOUNCE_MS) return;
      lastControlTime.current[action] = now;

      // Optimistic update for immediate UI feedback
      if (action === 'play') {
        setOptimisticPlaying(true);
      } else if (action === 'pause') {
        setOptimisticPlaying(false);
      }
      // For prev/next, we'll get the real state from playbackState update

      onControl(action);
    },
    [onControl],
  );

  /**
   * Handles play/pause toggle with optimistic state update.
   */
  const handlePlayPause = useCallback(() => {
    const action = displayIsPlaying ? 'pause' : 'play';
    handleControl(action);
  }, [displayIsPlaying, handleControl]);

  // Build style object with artwork and color CSS custom properties
  const cardStyle: Record<string, string> = {
    // Unique view-transition-name per card to avoid spec violation with duplicates.
    // Uses kebab-case for consistency with CSS custom idents.
    // The shared view-transition-class (in CSS) uses lowercase due to stylelint rules.
    viewTransitionName: `active-cast-card-${cast.tabId}`,
  };
  if (stagedImage) {
    cardStyle['--artwork'] = `url(${stagedImage})`;
  }
  if (dominantColor) {
    const [l, c, h] = dominantColor.oklch;
    cardStyle['--dominant-l'] = l.toFixed(3);
    cardStyle['--dominant-c'] = c.toFixed(3);
    cardStyle['--dominant-h'] = h.toFixed(1);
    cardStyle['--safe-l'] = dominantColor.safeL.toFixed(3);
  }

  return (
    <Card
      noPadding
      className={`${styles.card} ${stagedImage ? styles.hasArtwork : ''}`}
      style={cardStyle as CSSProperties}
    >
      <div className={styles.cardInner}>
        <div className={styles.header}>
          {favicon && <img src={favicon} alt="" className={styles.favicon} loading="lazy" />}
          <span className={styles.headerSpacer} />
          <IconButton
            className={styles.skipBtn}
            size="sm"
            onClick={onStop}
            aria-label={t('stop_cast')}
            title={t('stop_cast')}
          >
            <X size={12} />
          </IconButton>
        </div>

        <div className={styles.mainRow}>
          {canPrev && onControl && (
            <IconButton
              className={styles.skipBtn}
              onClick={() => handleControl('previoustrack')}
              aria-label={t('previous_track')}
              title={t('previous_track')}
            >
              <SkipBack size={14} />
            </IconButton>
          )}

          <div className={styles.info}>
            <button
              type="button"
              className={styles.title}
              onClick={goToTab}
              title={t('go_to_tab')}
              aria-label={`${t('go_to_tab')}: ${title}`}
            >
              {title}
            </button>
            {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          </div>

          {(canPlay || canPause) && onControl && (
            <IconButton
              variant="solid"
              onClick={handlePlayPause}
              aria-label={displayIsPlaying ? t('pause') : t('play')}
              title={displayIsPlaying ? t('pause') : t('play')}
            >
              {displayIsPlaying ? <Pause size={14} /> : <Play size={14} />}
            </IconButton>
          )}

          {canNext && onControl && (
            <IconButton
              className={styles.skipBtn}
              onClick={() => handleControl('nexttrack')}
              aria-label={t('next_track')}
              title={t('next_track')}
            >
              <SkipForward size={14} />
            </IconButton>
          )}
        </div>

        {/* Sync group volume control (all speakers at once) */}
        {showGroupVolume && (
          <div className={styles.speakerRows}>
            <SpeakerVolumeRow
              speakerName={groupName}
              speakerIp={cast.speakerIps[0]}
              volume={groupVolume}
              muted={groupMuted}
              onVolumeChange={(vol) => onSyncGroupVolumeChange(cast.speakerIps, vol)}
              onMuteToggle={() => onSyncGroupMuteToggle(cast.speakerIps, !groupMuted)}
              muteLabel={t('mute_speaker', { name: groupName })}
              unmuteLabel={t('unmute_speaker', { name: groupName })}
              volumeLabel={t('volume_speaker', { name: groupName })}
            />
          </div>
        )}

        {/* Per-speaker volume controls */}
        <div className={styles.speakerRows}>
          {cast.speakerIps.map((ip, idx) => {
            const name = cast.speakerNames[idx] ?? ip;
            const transportState = getTransportState?.(ip);
            return (
              <SpeakerVolumeRow
                key={ip}
                speakerName={name}
                speakerIp={ip}
                volume={getVolume(ip)}
                muted={isMuted(ip)}
                disabled={getVolumeFixed?.(ip)}
                onVolumeChange={(vol) => onVolumeChange(ip, vol)}
                onMuteToggle={() => onMuteToggle(ip)}
                muteLabel={t('mute_speaker', { name })}
                unmuteLabel={t('unmute_speaker', { name })}
                volumeLabel={t('volume_speaker', { name })}
                statusIndicator={
                  transportState ? <TransportIcon state={transportState} size={10} /> : undefined
                }
                onRemove={
                  cast.speakerIps.length > 1 && onRemoveSpeaker
                    ? () => onRemoveSpeaker(ip)
                    : undefined
                }
                removeLabel={t('remove_speaker', { name })}
              />
            );
          })}
        </div>

        {/* Video sync controls (conditional on global setting) */}
        {showVideoSync && (
          <div className={styles.videoSyncSection}>
            <div className={styles.videoSyncHeader}>
              <span className={styles.videoSyncLabel}>{t('video_sync')}</span>
              <ToggleSwitch
                checked={videoSync.enabled}
                onChange={videoSync.setEnabled}
                aria-label={t('video_sync_toggle')}
              />
              {videoSync.enabled && (
                <StatusChip
                  variant={
                    videoSync.state === 'locked'
                      ? 'synced'
                      : videoSync.state === 'acquiring'
                        ? 'acquiring'
                        : videoSync.state === 'stale'
                          ? 'lost'
                          : 'waiting'
                  }
                  className={
                    videoSync.state === 'locked'
                      ? styles.synced
                      : videoSync.state === 'acquiring'
                        ? styles.acquiring
                        : videoSync.state === 'stale'
                          ? styles.lost
                          : undefined
                  }
                >
                  {videoSync.state === 'locked'
                    ? t('video_sync_status_synced')
                    : videoSync.state === 'acquiring'
                      ? t('video_sync_status_acquiring')
                      : videoSync.state === 'stale'
                        ? t('video_sync_status_lost')
                        : t('video_sync_status_waiting')}
                </StatusChip>
              )}{' '}
            </div>

            {videoSync.enabled && (
              <div className={styles.videoSyncControls}>
                <div className={styles.videoSyncTrim}>
                  <label htmlFor="trim-slider" className={styles.videoSyncTrimLabel}>
                    {t('video_sync_trim')}
                  </label>
                  <input
                    id="trim-slider"
                    type="range"
                    min={-500}
                    max={500}
                    step={10}
                    value={videoSync.trimMs}
                    onChange={(e) =>
                      videoSync.setTrim(Number((e.target as HTMLInputElement).value))
                    }
                    className={styles.videoSyncTrimSlider}
                    aria-valuetext={t('video_sync_delay_ms', { delay: videoSync.trimMs })}
                  />
                  <span className={styles.videoSyncTrimValue}>
                    {videoSync.trimMs > 0 ? '+' : ''}
                    {videoSync.trimMs}ms
                  </span>
                </div>
                {videoSync.state === 'stale' && (
                  <IconButton
                    onClick={videoSync.resync}
                    aria-label={t('video_sync_resync')}
                    title={t('video_sync_resync')}
                    size="sm"
                  >
                    <RefreshCw size={12} />
                  </IconButton>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
