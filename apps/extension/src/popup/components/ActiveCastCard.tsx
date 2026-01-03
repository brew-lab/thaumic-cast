import type { JSX } from 'preact';
import { flushSync } from 'preact/compat';
import { useCallback, useState, useRef, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { ActiveCast, TransportState, MediaAction } from '@thaumic-cast/protocol';
import { getDisplayTitle, getDisplayImage, getDisplaySubtitle } from '@thaumic-cast/protocol';
import { X, Play, Pause, SkipBack, SkipForward } from 'lucide-preact';
import { IconButton, VolumeControl } from '@thaumic-cast/ui';
import { TransportIcon } from './TransportIcon';
import { useDominantColor } from '../hooks/useDominantColor';
import styles from './ActiveCastCard.module.css';

/** Debounce interval for playback control buttons (ms) */
const CONTROL_DEBOUNCE_MS = 300;

interface ActiveCastCardProps {
  /** The active cast session */
  cast: ActiveCast;
  /** Transport state for the target speaker */
  transportState?: TransportState;
  /** Current volume (0-100) */
  volume: number;
  /** Whether speaker is muted */
  muted: boolean;
  /** Callback when volume changes */
  onVolumeChange: (volume: number) => void;
  /** Callback when mute is toggled */
  onMuteToggle: () => void;
  /** Callback when stop button is clicked */
  onStop: () => void;
  /** Callback when playback control is triggered */
  onControl?: (action: MediaAction) => void;
}

/**
 * Displays an active cast session with volume controls and stop button.
 * @param props - Component props
 * @param props.cast
 * @param props.transportState
 * @param props.volume
 * @param props.muted
 * @param props.onVolumeChange
 * @param props.onMuteToggle
 * @param props.onStop
 * @param props.onControl
 * @returns The rendered ActiveCastCard component
 */
export function ActiveCastCard({
  cast,
  transportState,
  volume,
  muted,
  onVolumeChange,
  onMuteToggle,
  onStop,
  onControl,
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

  // Local state for optimistic UI updates (immediate feedback before site confirms)
  const [optimisticPlaying, setOptimisticPlaying] = useState<boolean | null>(null);

  // Reset optimistic state when real playback state updates
  useEffect(() => {
    setOptimisticPlaying(null);
  }, [playbackState]);

  // Use optimistic state if set, otherwise use real state
  const displayIsPlaying = optimisticPlaying ?? isPlaying;

  // Debounce ref to prevent rapid clicking
  const lastControlTime = useRef<Record<string, number>>({});

  // Extract dominant color from artwork for backdrop tinting
  const dominantColor = useDominantColor(stagedImage);

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
  const cardStyle: Record<string, string> = {};
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
    <div
      className={`${styles.card} ${stagedImage ? styles.hasArtwork : ''}`}
      style={Object.keys(cardStyle).length > 0 ? (cardStyle as JSX.CSSProperties) : undefined}
    >
      <div className={styles.header}>
        {favicon && <img src={favicon} alt="" className={styles.favicon} loading="lazy" />}
        <p className={styles.speaker}>
          {cast.speakerName || cast.speakerIp}
          {transportState && <TransportIcon state={transportState} size={10} />}
        </p>
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
          <button type="button" className={styles.title} onClick={goToTab} title={t('go_to_tab')}>
            {title}
          </button>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </div>

        {(canPlay || canPause) && onControl && (
          <IconButton
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

      <VolumeControl
        volume={volume}
        muted={muted}
        onVolumeChange={onVolumeChange}
        onMuteToggle={onMuteToggle}
        muteLabel={t('mute')}
        unmuteLabel={t('unmute')}
      />
    </div>
  );
}
