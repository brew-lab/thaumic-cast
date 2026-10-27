import { useEffect, useRef } from 'preact/hooks';
import { open } from '@tauri-apps/plugin-shell';
import { WizardStep, Button, Cluster, DescriptionList } from '@thaumic-cast/ui';
import { useTranslation } from 'react-i18next';
import { DOWNLOAD_URL } from '@thaumic-cast/shared';
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

  const handleOpenManual = () => {
    open(`${DOWNLOAD_URL}#step-ext`);
  };

  return (
    <WizardStep
      title={t('onboarding.extension.title')}
      subtitle={t('onboarding.extension.subtitle')}
      glyph="puzzle"
    >
      <DescriptionList
        kind="checklist"
        rows={[
          {
            key: 'status',
            state: isConnected ? 'connected' : 'checking',
            text: isConnected
              ? t('onboarding.extension.connected')
              : t('onboarding.extension.checking'),
          },
        ]}
      />

      <p className={styles.body}>{t('onboarding.extension.body')}</p>

      {/* Carry on is the step's one filled action; the store is the usual way, so tonal. */}
      <Cluster>
        <Button size="md" icon="external" onClick={handleOpenStore}>
          {t('onboarding.extension.chrome_link')}
        </Button>
        <Button size="md" kind="outline" icon="external" onClick={handleOpenManual}>
          {t('onboarding.extension.manual_link')}
        </Button>
      </Cluster>

      <p className={styles.skipHint}>{t('onboarding.extension.skip_hint')}</p>
    </WizardStep>
  );
}
