import type { Speaker } from '../state/store';
import { useTranslation } from 'react-i18next';
import { Artwork, Badge, Card, type BadgeTone } from '@thaumic-cast/ui';
import { speakerBadge, type SpeakerBadgeTone } from '../lib/speaker-badge';
import type { SpeakerCast } from '../lib/listen-url';
import { ListenUrl } from './ListenUrl';
import styles from './DeviceCard.module.css';

/** The Badge tone for each speaker state (DESIGN.md A-badge). */
const TONE: Record<SpeakerBadgeTone, BadgeTone> = {
  casting: 'casting',
  busy: 'warning',
  idle: 'neutral',
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
  /** The cast this speaker plays, while one runs; shows the "Copy URL" control */
  cast?: SpeakerCast;
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
 * @param props.cast - The cast this speaker plays, while one runs
 * @returns The rendered DeviceCard component
 */
export function DeviceCard({
  speaker,
  isCoordinator,
  memberCount,
  transportState,
  isCasting,
  cast,
}: DeviceCardProps) {
  const { t } = useTranslation();

  const badge = speakerBadge(transportState, isCasting ?? false);

  return (
    <Card noPadding>
      <div className={styles.content}>
        <div className={styles.header}>
          <Artwork kind="disc" size="md" glyph="speaker" />
          <div className={styles.info}>
            <h3 className={styles.name}>{speaker.name}</h3>
            <p className={styles.model}>
              {speaker.model} {isCoordinator ? `• ${t('device.coordinator')}` : ''}
              {memberCount > 1 && ` • ${t('device.others', { count: memberCount - 1 })}`}
            </p>
          </div>
          {badge && (
            <Badge
              tone={TONE[badge.tone]}
              label={t(badge.key, { defaultValue: badge.defaultValue })}
            />
          )}
        </div>
        {cast && <ListenUrl cast={cast} />}
      </div>
    </Card>
  );
}
