import { useEffect, useRef } from 'preact/hooks';
import { open } from '@tauri-apps/plugin-shell';
import { WizardStep, Alert, Button, Cluster } from '@thaumic-cast/ui';
import { useTranslation } from 'react-i18next';
import { GITHUB_RELEASES_URL } from '@thaumic-cast/shared';
import { stats, fetchStats } from '../../state/store';
import styles from './ExtensionStep.module.css';

const CHROME_STORE_URL =
  'https://chromewebstore.google.com/detail/hpemmkbecklfacogdidaoncjmfadgedm';

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
      glyph="puzzle"
    >
      <Alert variant={isConnected ? 'success' : 'info'}>
        {isConnected ? t('onboarding.extension.connected') : t('onboarding.extension.checking')}
      </Alert>

      <p className={styles.body}>{t('onboarding.extension.body')}</p>

      <Cluster>
        <Button kind="filled" icon="external" onClick={handleOpenStore}>
          {t('onboarding.extension.chrome_link')}
        </Button>
        <Button icon="external" onClick={handleOpenGithub}>
          {t('onboarding.extension.github_link')}
        </Button>
      </Cluster>

      <p className={styles.skipHint}>{t('onboarding.extension.skip_hint')}</p>
    </WizardStep>
  );
}
