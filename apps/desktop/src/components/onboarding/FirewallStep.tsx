import { useEffect, useState } from 'preact/hooks';
import { WizardStep, Alert } from '@thaumic-cast/ui';
import { Shield } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import { getPlatform, type Platform } from '../../state/store';
import styles from './FirewallStep.module.css';

/**
 * Pre-emptive firewall warning step.
 * Explains that the OS will prompt for network access permission.
 * Content adapts based on the current platform.
 *
 * @returns The rendered FirewallStep component
 */
export function FirewallStep(): preact.JSX.Element {
  const { t } = useTranslation();
  const [platform, setPlatform] = useState<Platform | null>(null);

  useEffect(() => {
    getPlatform().then(setPlatform);
  }, []);

  // Platform-specific translations, with windows for unknown. Null until the
  // platform is known, so another platform's copy never flashes first.
  const platformKey = platform === 'unknown' ? 'windows' : platform;

  return (
    <WizardStep
      title={t('onboarding.firewall.title')}
      subtitle={platformKey ? t(`onboarding.firewall.subtitle_${platformKey}`) : undefined}
      icon={Shield}
    >
      {platformKey && (
        <Alert variant="info">{t(`onboarding.firewall.prompt_${platformKey}`)}</Alert>
      )}

      <ul className={styles.reasonList}>
        <li>{t('onboarding.firewall.reason_1')}</li>
        <li>{t('onboarding.firewall.reason_2')}</li>
        <li>{t('onboarding.firewall.reason_3')}</li>
      </ul>
    </WizardStep>
  );
}
