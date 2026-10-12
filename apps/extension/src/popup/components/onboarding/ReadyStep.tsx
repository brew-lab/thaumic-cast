import { DEFAULT_MAX_CONCURRENT_STREAMS } from '@thaumic-cast/protocol';
import { WizardStep, Notice } from '@thaumic-cast/ui';
import { useTranslation } from 'react-i18next';
import { useConnectionStatus } from '../../hooks/useConnectionStatus';

/**
 * Final onboarding step confirming setup is complete.
 * Shows intro with stream limits, performance note, and battery warning.
 *
 * @returns The rendered ReadyStep component
 */
export function ReadyStep(): preact.JSX.Element {
  const { t } = useTranslation();
  const { maxStreams } = useConnectionStatus();

  return (
    <WizardStep
      title={t('onboarding.ready.title')}
      subtitle={t('onboarding.ready.subtitle')}
      glyph="check"
    >
      <p>
        {t('onboarding.ready.intro', { maxStreams: maxStreams ?? DEFAULT_MAX_CONCURRENT_STREAMS })}
      </p>

      <p>{t('onboarding.ready.performance_body')}</p>

      <Notice tone="warning" text={t('onboarding.ready.battery_warning')} />
    </WizardStep>
  );
}
