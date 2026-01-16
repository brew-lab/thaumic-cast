import { useEffect } from 'preact/hooks';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  groups,
  transportStates,
  castingSpeakers,
  networkHealth,
  fetchGroups,
  debouncedFetchGroups,
  refreshTopology,
  stopAll,
  stats,
  updateTransportState,
  updateNetworkHealth,
  type ZoneGroup,
  type Speaker,
} from '../state/store';
import { type NetworkHealthPayload, type TransportStatePayload } from '../lib/events';
import { DeviceCard } from '../components/DeviceCard';
import { ActionButton, Alert } from '@thaumic-cast/ui';
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
    const unlisteners: UnlistenFn[] = [];

    // Initial fetch (immediate, no debounce)
    fetchGroups();

    // Listen for discovery-complete event (topology changes)
    // Uses debounced fetch since discovery may trigger multiple events
    listen('discovery-complete', () => {
      debouncedFetchGroups();
    }).then((fn) => unlisteners.push(fn));

    // Listen for network health changes (direct state update, no fetch needed)
    listen<NetworkHealthPayload>('network-health-changed', (event) => {
      updateNetworkHealth(event.payload.health, event.payload.reason);
    }).then((fn) => unlisteners.push(fn));

    // Listen for stream/playback events (casting status changes)
    // Uses debounced fetch to coalesce rapid bursts (e.g., multi-speaker start/stop)
    listen('stream-created', debouncedFetchGroups).then((fn) => unlisteners.push(fn));
    listen('stream-ended', debouncedFetchGroups).then((fn) => unlisteners.push(fn));
    listen('playback-started', debouncedFetchGroups).then((fn) => unlisteners.push(fn));
    listen('playback-stopped', debouncedFetchGroups).then((fn) => unlisteners.push(fn));

    // Listen for transport state changes (direct state update, no fetch needed)
    listen<TransportStatePayload>('transport-state-changed', (event) => {
      updateTransportState(event.payload.speakerIp, event.payload.state);
    }).then((fn) => unlisteners.push(fn));

    // Fallback polling at longer interval (30s) for any missed events
    const interval = setInterval(fetchGroups, 30000);

    return () => {
      unlisteners.forEach((unlisten) => unlisten());
      clearInterval(interval);
    };
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
          <h2 className={styles.pageTitle}>{t('nav.speakers')}</h2>
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
            variant="primary"
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
