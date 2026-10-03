import type { Speaker } from '../state/store';
import { Speaker as SpeakerIcon } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import { Card } from '@thaumic-cast/ui';
import { speakerBadge, type SpeakerBadgeTone } from '../lib/speaker-badge';
import styles from './DeviceCard.module.css';

/** The badge class for each tone; an idle badge keeps the plain style. */
const TONE_CLASS: Record<SpeakerBadgeTone, string> = {
  casting: styles.statusCasting,
  busy: styles.statusBusy,
  idle: '',
};

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

  const badge = speakerBadge(transportState, isCasting ?? false);

  return (
    <Card noPadding className={styles.container}>
      <div className={styles.content}>
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
          {badge && (
            <span className={`${styles.status} ${TONE_CLASS[badge.tone]}`}>
              {t(badge.key, { defaultValue: badge.defaultValue })}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}
