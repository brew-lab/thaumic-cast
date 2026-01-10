import { WizardStep, Alert } from '@thaumic-cast/ui';
import { Zap } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import styles from './ReadyStep.module.css';

/** Maximum concurrent streams allowed (matches backend constant) */
const MAX_STREAMS = 10;

/**
 * Final onboarding step confirming setup is complete.
 * Shows intro with stream limits, performance note, and battery warning.
 *
 * @returns The rendered ReadyStep component
 */
export function ReadyStep(): preact.JSX.Element {
  const { t } = useTranslation();

  return (
    <WizardStep
      title={t('onboarding.ready.title')}
      subtitle={t('onboarding.ready.subtitle')}
      icon={Zap}
    >
      <p className={styles.introText}>{t('onboarding.ready.intro', { maxStreams: MAX_STREAMS })}</p>

      <p className={styles.performanceText}>{t('onboarding.ready.performance_body')}</p>

      <Alert variant="warning">{t('onboarding.ready.battery_warning')}</Alert>
    </WizardStep>
  );
}
