import { useEffect } from 'preact/hooks';
import { WizardStep, Alert } from '@thaumic-cast/ui';
import { Speaker } from 'lucide-preact';
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
  const { speakerGroups, loading } = useSonosState();

  useEffect(() => {
    onSpeakersFound(!speakerGroups.isEmpty);
  }, [speakerGroups.size, onSpeakersFound]);

  return (
    <WizardStep
      title={t('onboarding.speakers.title')}
      subtitle={t('onboarding.speakers.subtitle')}
      icon={Speaker}
    >
      {loading ? (
        <Alert variant="info">{t('onboarding.speakers.loading')}</Alert>
      ) : !speakerGroups.isEmpty ? (
        <>
          <Alert variant="success">
            {t('onboarding.speakers.found', { count: speakerGroups.size })}
          </Alert>

          <div className={styles['speaker-list']}>
            {[...speakerGroups].map((group) => (
              <div key={group.id} className={styles['speaker-item']}>
                <Speaker size={16} />
                <span>{group.name}</span>
                {group.isMultiSpeaker && (
                  <span className={styles['member-count']}>+{group.size - 1}</span>
                )}
              </div>
            ))}
          </div>
        </>
      ) : (
        <Alert variant="warning">{t('onboarding.speakers.none_found')}</Alert>
      )}
    </WizardStep>
  );
}
