import { useEffect, useState } from 'preact/hooks';
import { WizardStep } from '@thaumic-cast/ui';
import { Radio } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import { getPlatform, type Platform } from '../../state/store';
import styles from './WelcomeStep.module.css';

/**
 * Welcome step introducing the desktop app.
 * Explains the app's role as the "anchor" for audio streaming.
 * Content adapts based on the current platform.
 *
 * @returns The rendered WelcomeStep component
 */
export function WelcomeStep(): preact.JSX.Element {
  const { t } = useTranslation();
  const [platform, setPlatform] = useState<Platform>('windows');

  useEffect(() => {
    getPlatform().then(setPlatform);
  }, []);

  // Use platform-specific translations, fallback to windows for unknown
  const platformKey = platform === 'unknown' ? 'windows' : platform;

  return (
    <WizardStep
      title={t('onboarding.welcome.title')}
      subtitle={t('onboarding.welcome.subtitle')}
      icon={Radio}
    >
      <p className={styles.body}>{t(`onboarding.welcome.body_${platformKey}`)}</p>
      <p className={styles.footnote}>{t('onboarding.welcome.footnote')}</p>
    </WizardStep>
  );
}
