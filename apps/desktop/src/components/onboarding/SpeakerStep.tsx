import { useEffect, useState } from 'preact/hooks';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { WizardStep, Alert, Button } from '@thaumic-cast/ui';
import { Speaker, RefreshCw } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import { groups, fetchGroups, refreshTopology, networkHealth } from '../../state/store';
import styles from './SpeakerStep.module.css';

interface SpeakerStepProps {
  /** Whether speakers have been found (controls next button) */
  onSpeakersFound: (found: boolean) => void;
}

/** Payload from the discovery-complete Tauri event. */
interface DiscoveryCompletePayload {
  groupCount: number;
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
    let unlisten: UnlistenFn | null = null;
    let healthCheckTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    // Listen for discovery-complete event from the backend
    listen<DiscoveryCompletePayload>('discovery-complete', async (event) => {
      console.log('[SpeakerStep] Discovery complete event:', event.payload);
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
      unlisten = fn;
    });

    // Fallback timeout in case event doesn't fire (shouldn't happen, but safety net)
    timeoutTimer = setTimeout(async () => {
      if (isSearching) {
        console.log('[SpeakerStep] Fallback timeout reached, fetching groups');
        await fetchGroups();
        setIsSearching(false);
      }
    }, 10000);

    return () => {
      if (unlisten) unlisten();
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (healthCheckTimer) clearTimeout(healthCheckTimer);
    };
  }, []);

  useEffect(() => {
    onSpeakersFound(speakerCount > 0);
  }, [speakerCount, onSpeakersFound]);

  const handleScan = async () => {
    setIsSearching(true);
    await refreshTopology();
    // Give discovery time to complete
    setTimeout(async () => {
      await fetchGroups();
      setIsSearching(false);
    }, 1500);
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
