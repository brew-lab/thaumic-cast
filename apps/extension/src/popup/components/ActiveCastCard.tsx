import type { JSX } from 'preact';
import { useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { ActiveCast, TransportState } from '@thaumic-cast/protocol';
import { getDisplayTitle, getDisplayImage, getDisplaySubtitle } from '@thaumic-cast/protocol';
import { Music, Volume2, X } from 'lucide-preact';
import { VolumeControl } from '@thaumic-cast/ui';
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

  /**
   * Navigates to the tab associated with this cast session.
   */
  const goToTab = useCallback(() => {
    chrome.tabs.update(cast.tabId, { active: true });
  }, [cast.tabId]);

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <div className={styles.artwork}>
          {image ? (
            <img src={image} alt="" className={styles.image} loading="lazy" />
          ) : (
            <div className={styles.placeholder} aria-hidden="true">
              <Music size={20} />
            </div>
          )}
          {transportState && (
            <div className={styles.transportOverlay}>
              <TransportIcon state={transportState} size={14} />
            </div>
          )}
        </div>

        <div className={styles.info}>
          <button type="button" className={styles.title} onClick={goToTab} title={t('go_to_tab')}>
            {title}
          </button>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          <p className={styles.speaker}>
            <Volume2 size={10} className={styles.speakerIcon} />
            {cast.speakerName || cast.speakerIp}
          </p>
        </div>

        <button
          type="button"
          className={styles.stopButton}
          onClick={onStop}
          aria-label={t('stop_cast')}
          title={t('stop_cast')}
        >
          <X size={14} />
        </button>
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
