import { WizardStep, Alert } from '@thaumic-cast/ui';
import { Shield } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import styles from './FirewallStep.module.css';

/**
 * Pre-emptive firewall warning step.
 * Explains that Windows will prompt for network access permission.
 *
 * @returns The rendered FirewallStep component
 */
export function FirewallStep(): preact.JSX.Element {
  const { t } = useTranslation();

  return (
    <WizardStep
      title={t('onboarding.firewall.title')}
      subtitle={t('onboarding.firewall.subtitle')}
      icon={Shield}
    >
      <Alert variant="warning">{t('onboarding.firewall.warning_text')}</Alert>

      <ul className={styles.reasonList}>
        <li>{t('onboarding.firewall.reason_1')}</li>
        <li>{t('onboarding.firewall.reason_2')}</li>
        <li>{t('onboarding.firewall.reason_3')}</li>
      </ul>

      <p className={styles.reassurance}>{t('onboarding.firewall.reassurance')}</p>
    </WizardStep>
  );
}
