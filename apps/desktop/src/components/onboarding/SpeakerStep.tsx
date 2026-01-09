import { useEffect, useState } from 'preact/hooks';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { WizardStep, Alert, Button } from '@thaumic-cast/ui';
import { createLogger } from '@thaumic-cast/shared';
import { Speaker, RefreshCw } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import { groups, fetchGroups, refreshTopology, networkHealth } from '../../state/store';
import {
  listenOnce,
  type DiscoveryCompletePayload,
  type NetworkHealthPayload,
} from '../../lib/events';

import styles from './SpeakerStep.module.css';

const log = createLogger('SpeakerStep');

interface SpeakerStepProps {
  /** Whether speakers have been found (controls next button) */
  onSpeakersFound: (found: boolean) => void;
}

/**
 * Speaker discovery step.
 * Shows found Sonos speakers and provides rescan option.
 *
 * @param props - Component props
 * @param props.onSpeakersFound
 * @returns The rendered SpeakerStep component
 */
export function SpeakerStep({ onSpeakersFound }: SpeakerStepProps): preact.JSX.Element {
  const { t } = useTranslation();
  const [isSearching, setIsSearching] = useState(true);
  const speakerCount = groups.value.length;

  useEffect(() => {
    let unlistenDiscovery: UnlistenFn | null = null;
    let unlistenHealth: UnlistenFn | null = null;
    let healthCheckTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    // Immediately fetch any already-discovered speakers.
    // Discovery may have completed before this component mounted (race condition
    // between startNetworkServices() in previous step and listener registration).
    fetchGroups().then(() => {
      if (groups.value.length > 0) {
        log.debug('Found already-discovered speakers on mount');
        setIsSearching(false);
      }
    });

    // Listen for discovery-complete event from the backend
    listen<DiscoveryCompletePayload>('discovery-complete', async (event) => {
      log.debug('Discovery complete event:', event.payload);
      await fetchGroups();
      setIsSearching(false);

      // Schedule network health check after discovery completes
      // The first discovery doesn't evaluate health (gives GENA time to connect),
      // so this second pass will properly detect "discovered but unreachable" scenarios
      if (healthCheckTimer) clearTimeout(healthCheckTimer);
      healthCheckTimer = setTimeout(async () => {
        await refreshTopology();
        await fetchGroups();
      }, 3000);
    }).then((fn) => {
      unlistenDiscovery = fn;
    });

    // Listen for network health changes from the backend
    listen<NetworkHealthPayload>('network-health-changed', (event) => {
      log.debug('Network health changed:', event.payload);
      networkHealth.value = {
        health: event.payload.health,
        reason: event.payload.reason,
      };
    }).then((fn) => {
      unlistenHealth = fn;
    });

    // Fallback timeout in case event doesn't fire (shouldn't happen, but safety net)
    timeoutTimer = setTimeout(async () => {
      if (isSearching) {
        log.debug('Fallback timeout reached, fetching groups');
        await fetchGroups();
        setIsSearching(false);
      }
    }, 10000);

    return () => {
      if (unlistenDiscovery) unlistenDiscovery();
      if (unlistenHealth) unlistenHealth();
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (healthCheckTimer) clearTimeout(healthCheckTimer);
    };
  }, []);

  useEffect(() => {
    onSpeakersFound(speakerCount > 0);
  }, [speakerCount, onSpeakersFound]);

  const handleScan = async () => {
    setIsSearching(true);

    // Set up one-time listener BEFORE triggering scan to avoid race conditions.
    // The permanent useEffect listener handles fetchGroups() when the event fires.
    // This listenOnce only provides timeout behavior for the manual scan.
    const waitPromise = listenOnce<DiscoveryCompletePayload>('discovery-complete', 10000);

    await refreshTopology();
    const { timedOut } = await waitPromise;

    if (timedOut) {
      // Event didn't fire within timeout - fetch groups as fallback
      log.debug('Manual scan fallback timeout reached');
      await fetchGroups();
    }
    // If not timed out, the permanent listener already called fetchGroups()

    setIsSearching(false);
  };

  return (
    <WizardStep
      title={t('onboarding.speakers.title')}
      subtitle={t('onboarding.speakers.subtitle')}
      icon={Speaker}
    >
      {networkHealth.value.health === 'degraded' && (
        <Alert variant="warning">
          {t(`network.${networkHealth.value.reason}`, {
            defaultValue: t('network.speakers_unreachable'),
          })}
        </Alert>
      )}

      {isSearching ? (
        <Alert variant="info">{t('onboarding.speakers.searching')}</Alert>
      ) : speakerCount > 0 ? (
        <Alert variant="success">{t('onboarding.speakers.found', { count: speakerCount })}</Alert>
      ) : (
        <div className={styles.emptyState}>
          <p className={styles.emptyTitle}>{t('onboarding.speakers.none_found')}</p>
          <p className={styles.emptyHint}>{t('onboarding.speakers.none_found_hint')}</p>
        </div>
      )}

      <div className={styles.speakerList}>
        {groups.value.map((group) => {
          const coordinator = group.members.find((m) => m.uuid === group.coordinatorUuid);
          if (!coordinator) return null;
          return (
            <div key={group.coordinatorUuid} className={styles.speakerItem}>
              <Speaker size={16} />
              <span>{coordinator.zoneName}</span>
              {group.members.length > 1 && (
                <span className={styles.memberCount}>+{group.members.length - 1}</span>
              )}
            </div>
          );
        })}
      </div>

      <Button variant="secondary" onClick={handleScan} className={styles.scanButton}>
        <RefreshCw size={16} />
        {t('onboarding.speakers.scan_button')}
      </Button>
    </WizardStep>
  );
}
