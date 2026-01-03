import { WizardStep } from '@thaumic-cast/ui';
import { Button } from '@thaumic-cast/ui';
import { Puzzle, ExternalLink } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import { stats } from '../../state/store';
import styles from './ExtensionStep.module.css';

/**
 * Extension installation guide step.
 * Provides link to Chrome Web Store and shows connection status.
 *
 * @returns The rendered ExtensionStep component
 */
export function ExtensionStep(): preact.JSX.Element {
  const { t } = useTranslation();
  const connectionCount = stats.value?.connectionCount ?? 0;
  const isConnected = connectionCount > 0;

  const handleOpenStore = () => {
    // Open Chrome Web Store in default browser
    // In Tauri, this would use shell.open
    window.open('https://chrome.google.com/webstore', '_blank');
  };

  return (
    <WizardStep
      title={t('onboarding.extension.title')}
      subtitle={t('onboarding.extension.subtitle')}
      icon={Puzzle}
    >
      <p style={{ lineHeight: '1.6', marginBlockEnd: 'var(--space-lg)' }}>
        {t('onboarding.extension.body')}
      </p>

      <Button variant="primary" onClick={handleOpenStore} className={styles.storeButton}>
        <ExternalLink size={16} />
        {t('onboarding.extension.chrome_link')}
      </Button>

      <div className={isConnected ? styles.connectedBox : styles.waitingBox}>
        <div className={styles.statusDot} data-connected={isConnected} />
        <p className={styles.statusText}>
          {isConnected ? t('onboarding.extension.connected') : t('onboarding.extension.checking')}
        </p>
      </div>

      <p className={styles.skipHint}>{t('onboarding.extension.skip_hint')}</p>
    </WizardStep>
  );
}
