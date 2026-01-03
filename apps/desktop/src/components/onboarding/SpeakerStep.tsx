import { useEffect } from 'preact/hooks';
import { WizardStep } from '@thaumic-cast/ui';
import { Button } from '@thaumic-cast/ui';
import { Speaker, RefreshCw, Check } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import { groups, fetchGroups, refreshTopology } from '../../state/store';
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
  const speakerCount = groups.value.length;

  useEffect(() => {
    fetchGroups();
  }, []);

  useEffect(() => {
    onSpeakersFound(speakerCount > 0);
  }, [speakerCount, onSpeakersFound]);

  const handleScan = async () => {
    await refreshTopology();
  };

  return (
    <WizardStep
      title={t('onboarding.speakers.title')}
      subtitle={t('onboarding.speakers.subtitle')}
      icon={Speaker}
    >
      {speakerCount > 0 ? (
        <div className={styles.successBox}>
          <Check size={20} className={styles.successIcon} />
          <p className={styles.successText}>
            {t('onboarding.speakers.found', { count: speakerCount })}
          </p>
        </div>
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
