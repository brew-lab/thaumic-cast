import { useEffect, useState } from 'preact/hooks';
import { WizardStep, Alert, Button } from '@thaumic-cast/ui';
import { Speaker, RefreshCw } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import { groups, fetchGroups, refreshTopology, networkHealth } from '../../state/store';
import styles from './SpeakerStep.module.css';

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
    // Wait briefly for network services to start discovering
    const timer = setTimeout(async () => {
      await fetchGroups();
      setIsSearching(false);
    }, 1500);
    return () => clearTimeout(timer);
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
