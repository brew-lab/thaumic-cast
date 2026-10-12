import { useEffect } from 'preact/hooks';
import { WizardStep, DescriptionList, EmptyState, Notice } from '@thaumic-cast/ui';
import { useTranslation } from 'react-i18next';
import { useSonosState } from '../../hooks/useSonosState';

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
        <EmptyState kind="searching" body={t('onboarding.speakers.loading')} />
      ) : !speakerGroups.isEmpty ? (
        // The found rooms are checklist lines under the count, as on the desktop.
        <DescriptionList
          kind="checklist"
          rows={[
            {
              key: 'status',
              state: 'connected',
              text: t('onboarding.speakers.found', { count: speakerGroups.size }),
            },
            ...[...speakerGroups].map((group) => ({
              key: group.id,
              state: 'connected' as const,
              text: group.isMultiSpeaker ? `${group.name} +${group.size - 1}` : group.name,
            })),
          ]}
        />
      ) : (
        <Notice tone="warning" text={t('onboarding.speakers.none_found')} />
      )}
    </WizardStep>
  );
}
