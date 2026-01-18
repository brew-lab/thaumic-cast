import { useEffect, useState, useCallback } from 'preact/hooks';
import { WizardStep, Alert, Button, Disclosure, Input } from '@thaumic-cast/ui';
import { Monitor, Download, RefreshCw } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import { useConnectionStatus } from '../../hooks/useConnectionStatus';
import {
  testServerConnection,
  getServerTestErrorKey,
  type ServerTestResult,
} from '../../../lib/serverTest';
import { saveExtensionSettings } from '../../../lib/settings';
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
  const { connected, checking } = useConnectionStatus();
  const [isRetrying, setIsRetrying] = useState(false);

  // Manual configuration state
  const [urlInput, setUrlInput] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ServerTestResult | null>(null);

  const handleRetry = useCallback(async () => {
    setIsRetrying(true);
    try {
      await chrome.runtime.sendMessage({ type: 'ENSURE_CONNECTION' });
    } finally {
      setIsRetrying(false);
    }
  }, []);

  useEffect(() => {
    onConnectionChange(connected);
  }, [connected, onConnectionChange]);

  const handleDownload = () => {
    // Open releases page in new tab
    chrome.tabs.create({ url: 'https://github.com/brew-lab/thaumic-cast/releases/latest' });
  };

  /**
   * Handles URL input changes.
   */
  const handleUrlChange = useCallback((e: Event) => {
    const target = e.target as HTMLInputElement;
    setUrlInput(target.value);
    setTestResult(null);
  }, []);

  /**
   * Tests connection and saves settings on success.
   * Uses a minimum delay to prevent the loading state from flashing.
   */
  const handleTestConnection = useCallback(async () => {
    const url = urlInput.trim();
    if (!url) return;

    setTesting(true);
    setTestResult(null);

    // Ensure loading state shows for at least 400ms to avoid flashing
    const [result] = await Promise.all([
      testServerConnection(url),
      new Promise((resolve) => setTimeout(resolve, 400)),
    ]);
    setTestResult(result);

    if (result.success) {
      // Save settings and trigger reconnection
      await saveExtensionSettings({ serverUrl: url, useAutoDiscover: false });
      await chrome.runtime.sendMessage({ type: 'ENSURE_CONNECTION' });
    }

    setTesting(false);
  }, [urlInput]);

  const isChecking = checking || isRetrying;

  return (
    <WizardStep
      title={t('onboarding.desktop.title')}
      subtitle={t('onboarding.desktop.subtitle')}
      icon={Monitor}
    >
      {isChecking ? (
        <Alert variant="info">{t('onboarding.desktop.checking')}</Alert>
      ) : connected ? (
        <Alert variant="success">{t('onboarding.desktop.found')}</Alert>
      ) : testResult?.success ? (
        <Alert variant="success">{t('onboarding.desktop.manual_connected')}</Alert>
      ) : (
        <>
          <Alert variant="warning">{t('onboarding.desktop.not_found')}</Alert>

          <p className={styles.downloadPrompt}>{t('onboarding.desktop.download_prompt')}</p>

          <div className={styles.actions}>
            <Button variant="primary" onClick={handleDownload}>
              <Download size={16} />
              {t('onboarding.desktop.download_button')}
            </Button>

            <Button variant="secondary" onClick={handleRetry} disabled={isRetrying}>
              <RefreshCw size={16} />
              {t('onboarding.desktop.retry_button')}
            </Button>
          </div>

          {/* Manual configuration section */}
          <Disclosure
            label={t('onboarding.desktop.manual_toggle')}
            hint={t('onboarding.desktop.manual_hint')}
          >
            <div className={styles.manualForm}>
              <Input
                type="url"
                placeholder={t('server_url_placeholder')}
                value={urlInput}
                onInput={handleUrlChange}
                autoComplete="url"
              />
              <Button
                variant="secondary"
                onClick={handleTestConnection}
                disabled={testing || !urlInput.trim()}
                aria-busy={testing}
                fullWidth
              >
                {testing ? t('server_testing') : t('server_test_connection')}
              </Button>
            </div>

            {testResult && !testResult.success && (
              <div className={styles.testError}>
                <span className={styles.errorDot} />
                <span>{t(getServerTestErrorKey(testResult) ?? 'server_test_failed')}</span>
              </div>
            )}
          </Disclosure>
        </>
      )}
    </WizardStep>
  );
}
