import { WizardStep } from '@thaumic-cast/ui';
import { useTranslation } from 'react-i18next';

/**
 * Welcome step introducing the extension concept.
 * Explains how browser-to-Sonos streaming works.
 *
 * @returns The rendered WelcomeStep component
 */
export function WelcomeStep(): preact.JSX.Element {
  const { t } = useTranslation();

  return (
    <WizardStep
      title={t('onboarding.welcome.title')}
      subtitle={t('onboarding.welcome.subtitle')}
      glyph="cast"
      note={t('onboarding.welcome.footnote')}
    >
      <p>{t('onboarding.welcome.body')}</p>
    </WizardStep>
  );
}
