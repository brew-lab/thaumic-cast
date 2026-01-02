import type { JSX } from 'preact';
import { useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { ActiveCast, TransportState } from '@thaumic-cast/protocol';
import { getDisplayTitle, getDisplayImage, getDisplaySubtitle } from '@thaumic-cast/protocol';
import { X } from 'lucide-preact';
import { IconButton, VolumeControl } from '@thaumic-cast/ui';
import { TransportIcon } from './TransportIcon';
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

  /**
   * Navigates to the tab associated with this cast session.
   */
  const goToTab = useCallback(() => {
    chrome.tabs.update(cast.tabId, { active: true });
  }, [cast.tabId]);

  // Build style object with artwork CSS custom property
  const cardStyle = image ? { '--artwork': `url(${image})` } : undefined;

  return (
    <div
      className={`${styles.card} ${image ? styles.hasArtwork : ''}`}
      style={cardStyle as JSX.CSSProperties}
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
