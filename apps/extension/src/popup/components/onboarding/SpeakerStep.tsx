import { useEffect } from 'preact/hooks';
import { WizardStep } from '@thaumic-cast/ui';
import { Speaker, Check } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import { useSonosState } from '../../hooks/useSonosState';
import styles from './SpeakerStep.module.css';

interface SpeakerStepProps {
  /** Callback when speakers are found */
  onSpeakersFound: (found: boolean) => void;
}

/**
 * Speaker discovery confirmation step.
 * Shows speakers discovered via the desktop app.
 *
 * @param props - Component props
 * @param props.onSpeakersFound
 * @returns The rendered SpeakerStep component
 */
export function SpeakerStep({ onSpeakersFound }: SpeakerStepProps): preact.JSX.Element {
  const { t } = useTranslation();
  const { groups, loading } = useSonosState();
  const speakerCount = groups.length;

  useEffect(() => {
    onSpeakersFound(speakerCount > 0);
  }, [speakerCount, onSpeakersFound]);

  return (
    <WizardStep
      title={t('onboarding.speakers.title')}
      subtitle={t('onboarding.speakers.subtitle')}
      icon={Speaker}
    >
      {loading ? (
        <div className={styles.loadingBox}>
          <p className={styles.loadingText}>{t('onboarding.speakers.loading')}</p>
        </div>
      ) : speakerCount > 0 ? (
        <>
          <div className={styles.successBox}>
            <Check size={20} className={styles.successIcon} />
            <p className={styles.successText}>
              {t('onboarding.speakers.found', { count: speakerCount })}
            </p>
          </div>

          <div className={styles.speakerList}>
            {groups.map((group) => (
              <div key={group.coordinatorUuid} className={styles.speakerItem}>
                <Speaker size={16} />
                <span>{group.name}</span>
                {group.members.length > 1 && (
                  <span className={styles.memberCount}>+{group.members.length - 1}</span>
                )}
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className={styles.emptyState}>
          <p className={styles.emptyTitle}>{t('onboarding.speakers.none_found')}</p>
          <p className={styles.emptyHint}>{t('onboarding.speakers.hint')}</p>
        </div>
      )}
    </WizardStep>
  );
}
