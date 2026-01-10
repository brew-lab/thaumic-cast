import type { Speaker } from '../state/store';
import { Speaker as SpeakerIcon } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import { Card } from '@thaumic-cast/ui';
import styles from './DeviceCard.module.css';

interface DeviceCardProps {
  /** Speaker to display */
  speaker: Speaker;
  /** Whether this speaker is a group coordinator */
  isCoordinator: boolean;
  /** Number of members in the group */
  memberCount: number;
  /** Current transport state (Playing, Stopped, etc.) */
  transportState?: string;
  /** Whether this speaker is casting one of our streams */
  isCasting?: boolean;
}

/**
 * Card component for a Sonos speaker/group.
 *
 * Displays speaker info and current transport state.
 * @param props - Component props
 * @param props.speaker - The speaker/zone data
 * @param props.isCoordinator - Whether this speaker is a group coordinator
 * @param props.memberCount - Number of members in the group
 * @param props.transportState - Current transport state
 * @param props.isCasting - Whether this speaker is casting one of our streams
 * @returns The rendered DeviceCard component
 */
export function DeviceCard({
  speaker,
  isCoordinator,
  memberCount,
  transportState,
  isCasting,
}: DeviceCardProps) {
  const { t } = useTranslation();

  // Determine the display state: "Streaming" if casting, otherwise transport state
  const isPlaying = transportState === 'Playing';
  const displayState = isCasting && isPlaying ? t('device.streaming') : transportState;
  const statusClass =
    isCasting && isPlaying ? styles['status-casting'] : isPlaying ? styles['status-playing'] : '';

  return (
    <Card noPadding className={styles.container}>
      <div className={styles.content}>
        <div className={styles.header}>
          <div className={styles['icon-wrapper']}>
            <SpeakerIcon size={20} />
          </div>
          <div className={styles.info}>
            <h3 className={styles.name}>{speaker.name}</h3>
            <p className={styles.model}>
              {speaker.model} {isCoordinator ? `• ${t('device.coordinator')}` : ''}
              {memberCount > 1 && ` • ${t('device.others', { count: memberCount - 1 })}`}
            </p>
          </div>
          {displayState && (
            <span className={`${styles.status} ${statusClass}`}>
              {isCasting && isPlaying
                ? displayState
                : t(`transport.${transportState?.toLowerCase()}`, {
                    defaultValue: transportState,
                  })}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}
