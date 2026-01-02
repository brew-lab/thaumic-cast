import type { JSX } from 'preact';
import { useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { ActiveCast, TransportState } from '@thaumic-cast/protocol';
import { getDisplayTitle, getDisplayImage, getDisplaySubtitle } from '@thaumic-cast/protocol';
import { X } from 'lucide-preact';
import { IconButton, VolumeControl } from '@thaumic-cast/ui';
import { TransportIcon } from './TransportIcon';
import { useDominantColor } from '../hooks/useDominantColor';
import styles from './ActiveCastCard.module.css';

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
}: ActiveCastCardProps): JSX.Element {
  const { t } = useTranslation();

  const title = getDisplayTitle(cast.mediaState);
  const image = getDisplayImage(cast.mediaState);
  const subtitle = getDisplaySubtitle(cast.mediaState);
  const favicon = cast.mediaState.tabFavicon;

  // Extract dominant color from artwork for backdrop tinting
  const dominantColor = useDominantColor(image);

  /**
   * Navigates to the tab associated with this cast session.
   */
  const goToTab = useCallback(() => {
    chrome.tabs.update(cast.tabId, { active: true });
  }, [cast.tabId]);

  // Build style object with artwork and color CSS custom properties
  const cardStyle: Record<string, string> = {};
  if (image) {
    cardStyle['--artwork'] = `url(${image})`;
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
      className={`${styles.card} ${image ? styles.hasArtwork : ''}`}
      style={Object.keys(cardStyle).length > 0 ? (cardStyle as JSX.CSSProperties) : undefined}
    >
      <div className={styles.row}>
        {favicon && <img src={favicon} alt="" className={styles.favicon} loading="lazy" />}
        <p className={styles.speaker}>
          {cast.speakerName || cast.speakerIp}
          {transportState && <TransportIcon state={transportState} size={10} />}
        </p>
      </div>

      <div className={styles.row}>
        <div className={styles.info}>
          <button type="button" className={styles.title} onClick={goToTab} title={t('go_to_tab')}>
            {title}
          </button>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </div>

        <IconButton
          variant="danger"
          onClick={onStop}
          aria-label={t('stop_cast')}
          title={t('stop_cast')}
        >
          <X size={14} />
        </IconButton>
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
