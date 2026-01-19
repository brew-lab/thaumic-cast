import type { JSX } from 'preact';
import { useState, useCallback, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { Card, Button } from '@thaumic-cast/ui';
import type { ExtensionSettings } from '../../lib/settings';
import {
  testServerConnection,
  getServerTestErrorKey,
  type ServerTestResult,
} from '../../lib/serverTest';
import styles from '../Options.module.css';

interface ServerSectionProps {
  settings: ExtensionSettings;
  onUpdate: (partial: Partial<ExtensionSettings>) => Promise<void>;
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
  const [testResult, setTestResult] = useState<ServerTestResult | null>(null);

  // Sync urlInput with settings.serverUrl when settings change externally
  useEffect(() => {
    setUrlInput(settings.serverUrl ?? '');
  }, [settings.serverUrl]);

  /**
   * Tests connection to the specified server URL.
   * Uses a minimum delay to prevent the loading state from flashing.
   */
  const handleTestConnection = useCallback(async (url: string) => {
    setTesting(true);
    setTestResult(null);

    // Ensure loading state shows for at least 400ms to avoid flashing
    const [result] = await Promise.all([
      testServerConnection(url),
      new Promise((resolve) => setTimeout(resolve, 400)),
    ]);
    setTestResult(result);

    setTesting(false);
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
   * Saves the URL if changed and optionally tests the connection.
   * @param forceTest - If true, tests even if URL hasn't changed
   */
  const saveAndTest = useCallback(
    async (forceTest = false) => {
      const url = urlInput.trim() || null;
      const urlChanged = url !== settings.serverUrl;

      if (urlChanged) {
        await onUpdate({ serverUrl: url });
      }

      if (url && (urlChanged || forceTest)) {
        await handleTestConnection(url);
      }
    },
    [urlInput, settings.serverUrl, onUpdate, handleTestConnection],
  );

  const handleUrlBlur = useCallback(
    (e: FocusEvent) => {
      // Don't save on blur if focus moved to the test button
      const relatedTarget = e.relatedTarget as HTMLElement | null;
      if (relatedTarget?.dataset.serverTest) return;

      void saveAndTest(false);
    },
    [saveAndTest],
  );

  const handleSaveAndTest = useCallback(() => {
    void saveAndTest(true);
  }, [saveAndTest]);

  return (
    <Card title={t('server_section_title')}>
      <div className={styles.cardContent} role="radiogroup" aria-label={t('server_section_title')}>
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
            <label htmlFor="server-url" className={styles.label}>
              {t('server_url_label')}
            </label>
            <div className={styles.inlineRow}>
              <input
                id="server-url"
                type="url"
                className={styles.input}
                style={{ flex: 1 }}
                placeholder={t('server_url_placeholder')}
                value={urlInput}
                onInput={handleUrlChange}
                onBlur={handleUrlBlur}
                autoComplete="url"
              />
              <Button
                variant="secondary"
                onClick={handleSaveAndTest}
                disabled={testing || !urlInput.trim()}
                aria-busy={testing}
                data-server-test="true"
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
                  <span>{t(getServerTestErrorKey(testResult) ?? 'server_test_failed')}</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
