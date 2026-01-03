import { WizardStep } from '@thaumic-cast/ui';
import { Sparkles } from 'lucide-preact';
import { useTranslation } from 'react-i18next';

/**
 * Welcome step introducing the desktop app.
 * Explains the app's role as the "anchor" for audio streaming.
 *
 * @returns The rendered WelcomeStep component
 */
export function WelcomeStep(): preact.JSX.Element {
  const { t } = useTranslation();

  return (
    <WizardStep
      title={t('onboarding.welcome.title')}
      subtitle={t('onboarding.welcome.subtitle')}
      icon={Sparkles}
    >
      <p style={{ lineHeight: '1.6', marginBlockEnd: 'var(--space-md)' }}>
        {t('onboarding.welcome.body')}
      </p>
      <p
        style={{
          fontSize: '0.85rem',
          color: 'var(--color-text-muted)',
          fontStyle: 'italic',
        }}
      >
        {t('onboarding.welcome.footnote')}
      </p>
    </WizardStep>
  );
}
