import { useEffect } from 'preact/hooks';
import { WizardStep, DescriptionList, EmptyState, Notice } from '@thaumic-cast/ui';
import { useTranslation } from 'react-i18next';
import { useSonosState } from '../../hooks/useSonosState';
import { useRooms } from '../../hooks/useRooms';

interface SpeakerStepProps {
  /** Callback when speakers are found */
  onSpeakersFound: (found: boolean) => void;
}

/**
 * Speaker discovery confirmation step.
 * Lists the rooms the companion found, one line each, as the room picker
 * names them: a Sonos group's rooms are not folded into its name.
 *
 * @param props - Component props
 * @param props.onSpeakersFound
 * @returns The rendered SpeakerStep component
 */
export function SpeakerStep({ onSpeakersFound }: SpeakerStepProps): preact.JSX.Element {
  const { t } = useTranslation();
  const { state, loading } = useSonosState();
  const rooms = useRooms(state);

  useEffect(() => {
    onSpeakersFound(rooms.length > 0);
  }, [rooms.length, onSpeakersFound]);

  return (
    <WizardStep
      title={t('onboarding.speakers.title')}
      subtitle={t('onboarding.speakers.subtitle')}
      glyph="speaker"
    >
      {loading ? (
        <EmptyState kind="searching" body={t('onboarding.speakers.loading')} />
      ) : rooms.length > 0 ? (
        // The found rooms are checklist lines under the count, as on the desktop.
        <DescriptionList
          kind="checklist"
          rows={[
            {
              key: 'status',
              state: 'connected',
              text: t('onboarding.speakers.found', { count: rooms.length }),
            },
            ...rooms.map((room) => ({
              key: room.id,
              state: 'connected' as const,
              text: room.name,
            })),
          ]}
        />
      ) : (
        <Notice tone="warning" text={t('onboarding.speakers.none_found')} />
      )}
    </WizardStep>
  );
}
