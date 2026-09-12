import type { JSX } from 'preact';
import { useState, useCallback, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { Card, Button } from '@thaumic-cast/ui';
import type { ExtensionSettings } from '../../lib/settings';
import {
  connectToServer,
  getServerTestErrorKey,
  type ServerTestResult,
} from '../../lib/serverTest';
import { releaseHostPermission } from '../../lib/hostPermission';
import styles from '../Options.module.css';

interface ServerSectionProps {
  settings: ExtensionSettings;
  onUpdate: (partial: Partial<ExtensionSettings>) => Promise<void>;
}

/**
 * Server configuration section.
 * Allows user to configure auto-discover or manual server URL. Connect is the
 * only action that changes the configured server, since reaching a server on
 * another machine needs a permission prompt that only a click can open.
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
   * Handles auto-discover toggle. Leaving manual mode gives the manual
   * server's permission back.
   */
  const handleAutoDiscoverChange = useCallback(
    async (useAutoDiscover: boolean) => {
      await onUpdate({ useAutoDiscover });
      setTestResult(null);
      if (useAutoDiscover && settings.serverUrl) {
        await releaseHostPermission(settings.serverUrl);
      }
    },
    [onUpdate, settings.serverUrl],
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
   * Clearing the field forgets the manual server; anything else waits for Connect.
   */
  const handleUrlBlur = useCallback(async () => {
    if (urlInput.trim() || !settings.serverUrl) return;
    const previous = settings.serverUrl;
    await onUpdate({ serverUrl: null });
    await releaseHostPermission(previous);
  }, [urlInput, settings.serverUrl, onUpdate]);

  /**
   * Connects to the entered URL and saves it on success.
   */
  const handleConnect = useCallback(async () => {
    const url = urlInput.trim();
    if (!url) return;
    setTesting(true);
    setTestResult(null);
    setTestResult(await connectToServer(url));
    setTesting(false);
  }, [urlInput]);

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
            <span className={styles.radioDesc}>{t('server_custom_url_hint')}</span>
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
                onClick={handleConnect}
                disabled={testing || !urlInput.trim()}
                aria-busy={testing}
              >
                {testing ? t('server_testing') : t('server_test_connection')}
              </Button>
            </div>
            <span className={styles.hint}>{t('server_url_hint')}</span>

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
