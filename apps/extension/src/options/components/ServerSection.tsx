import type { JSX } from 'preact';
import { useState, useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { Card, Button } from '@thaumic-cast/ui';
import type { ExtensionSettings } from '../../lib/settings';
import styles from '../Options.module.css';

interface ServerSectionProps {
  settings: ExtensionSettings;
  onUpdate: (partial: Partial<ExtensionSettings>) => Promise<void>;
}

interface TestResult {
  success: boolean;
  latency?: number;
  error?: string;
}

/**
 * Server configuration section.
 * Allows user to configure auto-discover or manual server URL.
 * @param root0
 * @param root0.settings
 * @param root0.onUpdate
 * @returns The server section element
 */
export function ServerSection({ settings, onUpdate }: ServerSectionProps): JSX.Element {
  const { t } = useTranslation();
  const [urlInput, setUrlInput] = useState(settings.serverUrl ?? '');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  /**
   * Tests connection to the specified server URL.
   */
  const testConnection = useCallback(async (url: string) => {
    setTesting(true);
    setTestResult(null);

    const start = performance.now();
    try {
      const res = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(3000),
      });

      if (!res.ok) {
        throw new Error('Server returned error');
      }

      const data = await res.json();
      if (data.service !== 'thaumic-cast-desktop') {
        throw new Error('Not a Thaumic Cast server');
      }

      setTestResult({
        success: true,
        latency: Math.round(performance.now() - start),
      });
    } catch (err) {
      setTestResult({
        success: false,
        error: err instanceof Error ? err.message : 'Connection failed',
      });
    } finally {
      setTesting(false);
    }
  }, []);

  /**
   * Handles auto-discover toggle.
   */
  const handleAutoDiscoverChange = useCallback(
    async (useAutoDiscover: boolean) => {
      await onUpdate({ useAutoDiscover });
      setTestResult(null);
    },
    [onUpdate],
  );

  /**
   * Handles URL input change.
   */
  const handleUrlChange = useCallback((e: Event) => {
    const target = e.target as HTMLInputElement;
    setUrlInput(target.value);
    setTestResult(null);
  }, []);

  /**
   * Saves the URL and triggers a test.
   */
  const handleSaveUrl = useCallback(async () => {
    const url = urlInput.trim();
    if (!url) return;

    await onUpdate({ serverUrl: url, useAutoDiscover: false });
    await testConnection(url);
  }, [urlInput, onUpdate, testConnection]);

  return (
    <Card title={t('server_section_title')}>
      <div className={styles.cardContent}>
        {/* Auto-discover option */}
        <label className={styles.radioOption}>
          <input
            type="radio"
            name="serverMode"
            className={styles.radioInput}
            checked={settings.useAutoDiscover}
            onChange={() => handleAutoDiscoverChange(true)}
          />
          <div className={styles.radioContent}>
            <span className={styles.radioLabel}>{t('server_auto_discover')}</span>
            <span className={styles.radioDesc}>{t('server_auto_discover_hint')}</span>
          </div>
        </label>

        {/* Custom URL option */}
        <label className={styles.radioOption}>
          <input
            type="radio"
            name="serverMode"
            className={styles.radioInput}
            checked={!settings.useAutoDiscover}
            onChange={() => handleAutoDiscoverChange(false)}
          />
          <div className={styles.radioContent}>
            <span className={styles.radioLabel}>{t('server_custom_url')}</span>
          </div>
        </label>

        {/* URL input (shown when custom mode) */}
        {!settings.useAutoDiscover && (
          <div className={styles.field}>
            <label className={styles.label}>{t('server_url_label')}</label>
            <div className={styles.inlineRow}>
              <input
                type="text"
                className={styles.input}
                style={{ flex: 1 }}
                placeholder={t('server_url_placeholder')}
                value={urlInput}
                onInput={handleUrlChange}
              />
              <Button
                variant="secondary"
                onClick={handleSaveUrl}
                disabled={testing || !urlInput.trim()}
              >
                {testing ? t('server_testing') : t('server_test_connection')}
              </Button>
            </div>

            {/* Test result */}
            {testResult && (
              <div className={styles.status}>
                <span
                  className={`${styles.statusDot} ${
                    testResult.success ? styles.statusDotConnected : styles.statusDotDisconnected
                  }`}
                />
                {testResult.success ? (
                  <span>
                    {t('server_test_success')} (
                    {t('server_status_latency', { latency: testResult.latency })})
                  </span>
                ) : (
                  <span>{testResult.error ?? t('server_test_failed')}</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
