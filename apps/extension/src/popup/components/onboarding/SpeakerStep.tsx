import { useEffect } from 'preact/hooks';
import { WizardStep, DescriptionList, Icon, Notice } from '@thaumic-cast/ui';
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
      glyph="speaker"
    >
      {loading ? (
        <DescriptionList
          kind="checklist"
          rows={[{ key: 'status', state: 'checking', text: t('onboarding.speakers.loading') }]}
        />
      ) : !speakerGroups.isEmpty ? (
        <>
          <DescriptionList
            kind="checklist"
            rows={[
              {
                key: 'status',
                state: 'connected',
                text: t('onboarding.speakers.found', { count: speakerGroups.size }),
              },
            ]}
          />

          <div className={styles.speakerList}>
            {[...speakerGroups].map((group) => (
              <div key={group.id} className={styles.speakerItem}>
                <Icon glyph="speaker" />
                <span>{group.name}</span>
                {group.isMultiSpeaker && (
                  <span className={`${styles.memberCount} num`}>+{group.size - 1}</span>
                )}
              </div>
            ))}
          </div>
        </>
      ) : (
        <Notice tone="warning" text={t('onboarding.speakers.none_found')} />
      )}
    </WizardStep>
  );
}
