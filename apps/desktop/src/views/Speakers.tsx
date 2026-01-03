import { useEffect } from 'preact/hooks';
import {
  groups,
  transportStates,
  castingSpeakers,
  networkHealth,
  fetchGroups,
  refreshTopology,
  stopAll,
  stats,
  type ZoneGroup,
  type Speaker,
} from '../state/store';
import { DeviceCard } from '../components/DeviceCard';
import { ActionButton } from '../components/ActionButton';
import { Alert } from '@thaumic-cast/ui';
import { RefreshCw, Square } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import styles from './Speakers.module.css';

/**
 * Extracts the coordinator as a Speaker from a ZoneGroup.
 * @param group - The zone group
 * @returns The coordinator speaker, or undefined if not found
 */
function getCoordinator(group: ZoneGroup): Speaker | undefined {
  const member = group.members.find((m) => m.uuid === group.coordinatorUuid);
  if (!member) return undefined;
  return {
    uuid: member.uuid,
    name: member.zoneName,
    model: member.model,
    ip: member.ip,
  };
}

/**
 * Speakers page.
 *
 * Displays discovered Sonos devices and provides controls for:
 * - Scanning for new devices
 * - Casting audio to speakers
 * - Stopping all playback
 * @returns The rendered Speakers page
 */
export function Speakers() {
  const { t } = useTranslation();

  useEffect(() => {
    fetchGroups();
    const interval = setInterval(fetchGroups, 5000);
    return () => clearInterval(interval);
  }, []);

  const groupsWithCoordinators = groups.value
    .map((group) => ({ group, coordinator: getCoordinator(group) }))
    .filter((item): item is { group: ZoneGroup; coordinator: Speaker } => item.coordinator != null);
  const speakerCount = groupsWithCoordinators.length;
  const streamCount = stats.value?.streamCount ?? 0;

  return (
    <div className={styles.speakers}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h2 className={styles.title}>{t('nav.speakers')}</h2>
          <span className={styles.summary}>
            {t('speakers.summary', { speakers: speakerCount, streams: streamCount })}
          </span>
        </div>
        <div className={styles.controls}>
          <ActionButton
            action={refreshTopology}
            label={t('speakers.scan')}
            loadingLabel={t('speakers.scanning')}
            icon={RefreshCw}
            variant="secondary"
            className={styles.controlButton}
          />
          <ActionButton
            action={stopAll}
            label={t('speakers.stop_all')}
            loadingLabel={t('speakers.stopping')}
            icon={Square}
            variant="danger"
            className={styles.controlButton}
          />
        </div>
      </div>

      {networkHealth.value.health === 'degraded' && (
        <Alert variant="warning" className={styles.networkAlert}>
          {t(`network.${networkHealth.value.reason}`, {
            defaultValue: t('network.degraded_warning'),
          })}
        </Alert>
      )}

      {groupsWithCoordinators.length === 0 ? (
        <div className={styles.emptyState}>
          <p className={styles.emptyTitle}>{t('speakers.none')}</p>
          <p className={styles.emptyDescription}>{t('speakers.scan_hint')}</p>
        </div>
      ) : (
        <div className={styles.grid}>
          {groupsWithCoordinators.map(({ group, coordinator }) => (
            <DeviceCard
              key={coordinator.uuid}
              speaker={coordinator}
              isCoordinator={true}
              memberCount={group.members.length}
              transportState={transportStates.value[group.coordinatorIp]}
              isCasting={castingSpeakers.value.has(group.coordinatorIp)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
