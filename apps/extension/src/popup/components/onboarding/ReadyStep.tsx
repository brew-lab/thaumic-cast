import { DEFAULT_MAX_CONCURRENT_STREAMS } from '@thaumic-cast/protocol';
import { WizardStep, Alert } from '@thaumic-cast/ui';
import { Zap } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import { useConnectionStatus } from '../../hooks/useConnectionStatus';
import styles from './ReadyStep.module.css';

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
      icon={Zap}
    >
      <p className={styles.introText}>
        {t('onboarding.ready.intro', { maxStreams: maxStreams ?? DEFAULT_MAX_CONCURRENT_STREAMS })}
      </p>

      <p className={styles.performanceText}>{t('onboarding.ready.performance_body')}</p>

      <Alert variant="warning">{t('onboarding.ready.battery_warning')}</Alert>
    </WizardStep>
  );
}
