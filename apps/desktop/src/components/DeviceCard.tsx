import { Speaker, startPlayback } from '../state/store';
import { ActionButton } from './ActionButton';
import { Play, Speaker as SpeakerIcon } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import styles from './DeviceCard.module.css';

interface DeviceCardProps {
  /** Speaker to display */
  speaker: Speaker;
  /** Whether this speaker is a group coordinator */
  isCoordinator: boolean;
  /** Number of members in the group */
  memberCount: number;
}

/**
 * Card component for a Sonos speaker/group.
 *
 * Displays speaker info and provides cast/stop controls.
 * @param props - Component props
 * @param props.speaker - The speaker/zone data
 * @param props.isCoordinator - Whether this speaker is a group coordinator
 * @param props.memberCount - Number of members in the group
 * @returns The rendered DeviceCard component
 */
export function DeviceCard({ speaker, isCoordinator, memberCount }: DeviceCardProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.deviceCard}>
      <div className={styles.header}>
        <div className={styles.iconWrapper}>
          <SpeakerIcon size={20} />
        </div>
        <div className={styles.info}>
          <h3 className={styles.name}>{speaker.name}</h3>
          <p className={styles.model}>
            {speaker.model} {isCoordinator ? `• ${t('device.coordinator')}` : ''}
            {memberCount > 1 && ` • ${t('device.others', { count: memberCount - 1 })}`}
          </p>
        </div>
      </div>

      <div className={styles.actions}>
        <ActionButton
          action={() => startPlayback(speaker.ip)}
          label={t('device.cast')}
          loadingLabel={t('device.casting')}
          successLabel={t('device.streaming')}
          icon={Play}
          variant="primary"
          successDuration={3000}
        />
      </div>
    </div>
  );
}
