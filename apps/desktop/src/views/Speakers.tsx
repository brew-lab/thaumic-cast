import { useEffect } from 'preact/hooks';
import { groups, fetchGroups, refreshTopology, stopAll, stats } from '../state/store';
import { DeviceCard } from '../components/DeviceCard';
import { ActionButton } from '../components/ActionButton';
import { RefreshCw, Square } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import styles from './Speakers.module.css';

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

  const speakerCount = groups.value.length;
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

      {groups.value.length === 0 ? (
        <div className={styles.emptyState}>
          <p className={styles.emptyTitle}>{t('speakers.none')}</p>
          <p className={styles.emptyDescription}>{t('speakers.scan_hint')}</p>
        </div>
      ) : (
        <div className={styles.grid}>
          {groups.value.map((group) => (
            <DeviceCard
              key={group.coordinator.uuid}
              speaker={group.coordinator}
              isCoordinator={true}
              memberCount={group.members.length}
            />
          ))}
        </div>
      )}
    </div>
  );
}
