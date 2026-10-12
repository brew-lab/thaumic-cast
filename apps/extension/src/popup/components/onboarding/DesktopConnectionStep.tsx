import { useEffect, useState, useCallback } from 'preact/hooks';
import {
  WizardStep,
  Alert,
  Button,
  Cluster,
  Disclosure,
  StatusDot,
  TextInput,
} from '@thaumic-cast/ui';
import { useTranslation } from 'react-i18next';
import { GITHUB_RELEASES_URL } from '@thaumic-cast/shared';
import { useConnectionStatus } from '../../hooks/useConnectionStatus';
import {
  connectToServer,
  getServerTestErrorKey,
  type ServerTestResult,
} from '../../../lib/serverTest';
import styles from './DesktopConnectionStep.module.css';

interface DesktopConnectionStepProps {
  /** Callback when connection status changes */
  onConnectionChange: (connected: boolean) => void;
}

/**
 * Desktop app connection detection step.
 * Shows connection status and provides download link if not found.
 * Includes a collapsible manual configuration section for advanced users.
 *
 * @param props - Component props
 * @param props.onConnectionChange
 * @returns The rendered DesktopConnectionStep component
 */
export function DesktopConnectionStep({
  onConnectionChange,
}: DesktopConnectionStepProps): preact.JSX.Element {
  const { t } = useTranslation();
  const { phase, retry: handleRetry } = useConnectionStatus();

  // Derived states
  const connected = phase === 'connected';
  const isSeeking = phase === 'checking' || phase === 'reconnecting';

  // Manual configuration state
  const [urlInput, setUrlInput] = useState('');
  const [testResult, setTestResult] = useState<ServerTestResult | null>(null);

  useEffect(() => {
    onConnectionChange(connected);
  }, [connected, onConnectionChange]);

  const handleDownload = () => {
    // Open releases page in new tab
    chrome.tabs.create({ url: GITHUB_RELEASES_URL });
  };

  /**
   * Handles URL input changes.
   */
  const handleUrlChange = useCallback((value: string) => {
    setUrlInput(value);
    setTestResult(null);
  }, []);

  /**
   * Connects to the entered URL; the shared flow saves it on success and the
   * background picks up the new settings.
   */
  const handleConnect = useCallback(async () => {
    const url = urlInput.trim();
    if (!url) return;
    setTestResult(null);
    setTestResult(await connectToServer(url));
  }, [urlInput]);

  return (
    <WizardStep
      title={t('onboarding.desktop.title')}
      subtitle={t('onboarding.desktop.subtitle')}
      glyph="monitor"
    >
      {isSeeking ? (
        <Alert variant="info">{t('onboarding.desktop.checking')}</Alert>
      ) : connected ? (
        <Alert variant="success">{t('onboarding.desktop.found')}</Alert>
      ) : testResult?.success ? (
        <Alert variant="success">{t('onboarding.desktop.manual_connected')}</Alert>
      ) : (
        <>
          <Alert variant="warning">{t('onboarding.desktop.not_found')}</Alert>

          <p className={styles.downloadPrompt}>{t('onboarding.desktop.download_prompt')}</p>

          <Cluster stack>
            <Button kind="filled" icon="external" onClick={handleDownload}>
              {t('onboarding.desktop.download_button')}
            </Button>
            <Button icon="refresh" onClick={handleRetry} disabled={isSeeking}>
              {t('onboarding.desktop.retry_button')}
            </Button>
          </Cluster>

          {/* Manual configuration section */}
          <Disclosure
            label={t('onboarding.desktop.manual_toggle')}
            hint={t('onboarding.desktop.manual_hint')}
          >
            <div className={styles.manualForm}>
              <TextInput
                kind="address"
                inputMode="url"
                aria-label={t('server_url_label')}
                placeholder={t('server_url_placeholder')}
                value={urlInput}
                onInput={handleUrlChange}
                autoComplete="url"
              />
              <Button
                onAction={handleConnect}
                labels={{ busy: t('server_testing') }}
                disabled={!urlInput.trim()}
                fullWidth
              >
                {t('server_test_connection')}
              </Button>
            </div>

            {testResult && !testResult.success && (
              <div className={styles.testError}>
                <StatusDot state="failed" />
                <span>{t(getServerTestErrorKey(testResult) ?? 'server_test_failed')}</span>
              </div>
            )}
          </Disclosure>
        </>
      )}
    </WizardStep>
  );
}
