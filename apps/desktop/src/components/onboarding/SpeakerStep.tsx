import { useEffect, useState } from 'preact/hooks';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  WizardStep,
  AddressField,
  Button,
  DescriptionList,
  Disclosure,
  EmptyState,
  Icon,
  Notice,
  type AddressResult,
} from '@thaumic-cast/ui';
import { createLogger } from '@thaumic-cast/shared';
import { useTranslation } from 'react-i18next';
import { groups, fetchGroups, refreshTopology, networkHealth } from '../../state/store';
import {
  listenOnce,
  type DiscoveryCompletePayload,
  type NetworkHealthPayload,
} from '../../lib/events';
import { addManualSpeaker, getSpeakerErrorMessage } from '../../lib/manual-speaker';

import styles from './SpeakerStep.module.css';

const log = createLogger('SpeakerStep');

/** Delay before running health check after discovery completes (ms). */
const HEALTH_CHECK_DELAY_MS = 3000;
/** Fallback timeout if discovery-complete event never fires (ms). */
const DISCOVERY_FALLBACK_TIMEOUT_MS = 10000;

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
  const [speakerIp, setSpeakerIp] = useState('');

  const handleAddSpeaker = async (ip: string): Promise<AddressResult> => {
    const outcome = await addManualSpeaker(ip);
    if (!outcome.ok) return { ok: false, error: getSpeakerErrorMessage(outcome.code, t) };
    return { ok: true, said: t('settings.manual_added', { address: outcome.ip }) };
  };
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
      }, HEALTH_CHECK_DELAY_MS);
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
    }, DISCOVERY_FALLBACK_TIMEOUT_MS);

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
    const waitPromise = listenOnce<DiscoveryCompletePayload>(
      'discovery-complete',
      DISCOVERY_FALLBACK_TIMEOUT_MS,
    );

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
      glyph="speaker"
    >
      {networkHealth.value.health === 'degraded' && (
        <Notice
          tone="warning"
          text={t(`network.${networkHealth.value.reason}`, {
            defaultValue: t('network.speakers_not_responding'),
          })}
        />
      )}

      {isSearching ? (
        <EmptyState kind="searching" body={t('onboarding.speakers.searching')} />
      ) : speakerCount > 0 ? (
        <DescriptionList
          kind="checklist"
          rows={[
            {
              key: 'status',
              state: 'connected',
              text: t('onboarding.speakers.found', { count: speakerCount }),
            },
          ]}
        />
      ) : (
        <EmptyState
          title={t('onboarding.speakers.none_found')}
          body={t('onboarding.speakers.none_found_hint')}
        />
      )}

      {/* Manual IP entry - shown when no speakers found */}
      {speakerCount === 0 && !isSearching && (
        <Disclosure label={t('onboarding.speakers.manual_toggle')}>
          <AddressField
            size="md"
            kind="speaker"
            label={t('settings.add_speaker')}
            placeholder={t('onboarding.speakers.manual_ip_placeholder')}
            value={speakerIp}
            onChange={setSpeakerIp}
            onTest={handleAddSpeaker}
            action={{
              idle: t('onboarding.speakers.manual_add'),
              busy: t('onboarding.speakers.manual_testing'),
              failed: t('settings.try_again'),
            }}
            help={t('onboarding.speakers.manual_hint')}
          />
        </Disclosure>
      )}

      <div className={styles.speakerList}>
        {groups.value.map((group) => {
          const coordinator = group.members.find((m) => m.uuid === group.coordinatorUuid);
          if (!coordinator) return null;
          return (
            <div key={group.coordinatorUuid} className={styles.speakerItem}>
              <Icon glyph="speaker" />
              <span>{coordinator.zoneName}</span>
              {group.members.length > 1 && (
                <span className={`${styles.memberCount} num`}>+{group.members.length - 1}</span>
              )}
            </div>
          );
        })}
      </div>

      <Button size="md" icon="refresh" onAction={handleScan}>
        {t('onboarding.speakers.scan_button')}
      </Button>
    </WizardStep>
  );
}
