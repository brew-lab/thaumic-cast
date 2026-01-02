import type { JSX } from 'preact';
import { useTranslation } from 'react-i18next';
import type { ActiveCast, TransportState } from '@thaumic-cast/protocol';
import { ActiveCastCard } from './ActiveCastCard';
import styles from './ActiveCastsList.module.css';

interface ActiveCastsListProps {
  /** Array of active cast sessions */
  casts: ActiveCast[];
  /** Function to get transport state for a speaker IP */
  getTransportState?: (speakerIp: string) => TransportState | undefined;
  /** Function to get volume for a speaker IP */
  getVolume: (speakerIp: string) => number;
  /** Function to check if a speaker is muted */
  isMuted: (speakerIp: string) => boolean;
  /** Callback when volume changes for a speaker */
  onVolumeChange: (speakerIp: string, volume: number) => void;
  /** Callback when mute is toggled for a speaker */
  onMuteToggle: (speakerIp: string) => void;
  /** Callback when a cast stop is requested */
  onStopCast: (tabId: number) => void;
  /** Whether to show bottom divider (when CurrentTabCard is visible below) */
  showDivider?: boolean;
}

/**
 * List of active cast sessions with volume controls.
 * @param props - Component props
 * @param props.casts
 * @param props.getTransportState
 * @param props.getVolume
 * @param props.isMuted
 * @param props.onVolumeChange
 * @param props.onMuteToggle
 * @param props.onStopCast
 * @param props.showDivider
 * @returns The rendered ActiveCastsList component or null if empty
 */
export function ActiveCastsList({
  casts,
  getTransportState,
  getVolume,
  isMuted,
  onVolumeChange,
  onMuteToggle,
  onStopCast,
  showDivider = false,
}: ActiveCastsListProps): JSX.Element | null {
  const { t } = useTranslation();

  if (casts.length === 0) return null;

  const sectionClass = showDivider ? `${styles.section} ${styles.withDivider}` : styles.section;

  return (
    <section className={sectionClass}>
      <h2 className={styles.heading}>{t('active_casts')}</h2>
      <ul className={styles.list}>
        {casts.map((cast) => (
          <li key={cast.tabId} className={styles.item}>
            <ActiveCastCard
              cast={cast}
              transportState={getTransportState?.(cast.speakerIp)}
              volume={getVolume(cast.speakerIp)}
              muted={isMuted(cast.speakerIp)}
              onVolumeChange={(vol) => onVolumeChange(cast.speakerIp, vol)}
              onMuteToggle={() => onMuteToggle(cast.speakerIp)}
              onStop={() => onStopCast(cast.tabId)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
