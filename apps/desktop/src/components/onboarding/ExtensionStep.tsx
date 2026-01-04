import { useEffect, useRef } from 'preact/hooks';
import { WizardStep, Alert, Button } from '@thaumic-cast/ui';
import { Puzzle, ExternalLink } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import { stats, fetchStats } from '../../state/store';
import styles from './ExtensionStep.module.css';

/**
 * Extension installation guide step.
 * Provides link to Chrome Web Store and shows connection status.
 * Polls for connection changes while the step is active.
 *
 * @returns The rendered ExtensionStep component
 */
export function ExtensionStep(): preact.JSX.Element {
  const { t } = useTranslation();
  const connectionCount = stats.value?.connectionCount ?? 0;
  const isConnected = connectionCount > 0;
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Initial fetch
    fetchStats();

    // Poll for connection status changes every 2 seconds
    pollRef.current = setInterval(() => {
      fetchStats();
    }, 2000);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    };
  }, []);

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
      <Alert variant={isConnected ? 'success' : 'info'}>
        {isConnected ? t('onboarding.extension.connected') : t('onboarding.extension.checking')}
      </Alert>

      <p className={styles.body}>{t('onboarding.extension.body')}</p>

      <Button variant="primary" onClick={handleOpenStore} className={styles.storeButton}>
        <ExternalLink size={16} />
        {t('onboarding.extension.chrome_link')}
      </Button>

      <p className={styles.skipHint}>{t('onboarding.extension.skip_hint')}</p>
    </WizardStep>
  );
}
