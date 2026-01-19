import { useEffect, useRef } from 'preact/hooks';
import { open } from '@tauri-apps/plugin-shell';
import { WizardStep, Alert, Button } from '@thaumic-cast/ui';
import { Puzzle, ExternalLink, Download } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import { stats, fetchStats } from '../../state/store';
import styles from './ExtensionStep.module.css';

const CHROME_STORE_URL =
  'https://chromewebstore.google.com/detail/hpemmkbecklfacogdidaoncjmfadgedm';
const GITHUB_RELEASES_URL = 'https://github.com/brew-lab/thaumic-cast/releases/latest';

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
    open(CHROME_STORE_URL);
  };

  const handleOpenGithub = () => {
    open(GITHUB_RELEASES_URL);
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

      <div className={styles.buttonGroup}>
        <Button variant="primary" onClick={handleOpenStore}>
          <ExternalLink size={16} />
          {t('onboarding.extension.chrome_link')}
        </Button>

        <Button variant="secondary" onClick={handleOpenGithub}>
          <Download size={16} />
          {t('onboarding.extension.github_link')}
        </Button>
      </div>

      <p className={styles.skipHint}>{t('onboarding.extension.skip_hint')}</p>
    </WizardStep>
  );
}
