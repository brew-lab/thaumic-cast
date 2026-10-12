import type { JSX } from 'preact';
import { useState, useCallback, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { Button, Card, Radio, StatusDot, TextInput, useAnnouncer } from '@thaumic-cast/ui';
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

  // Manual mode with nothing saved is not a setting that works: discovery has
  // no address to use and goes on scanning this machine. Say so, unless a
  // connection attempt is already saying something.
  const addressMissing =
    !settings.useAutoDiscover && !settings.serverUrl && !testing && !testResult;

  // Say the missing address once when it appears (it replaces a live region).
  const { say } = useAnnouncer();
  useEffect(() => {
    if (addressMissing) say(t('server_url_missing'), { key: 'server-url-missing' });
  }, [addressMissing, say, t]);

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
  const handleUrlChange = useCallback((value: string) => {
    setUrlInput(value);
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
        <Radio
          name="serverMode"
          value="auto"
          label={t('server_auto_discover')}
          description={t('server_auto_discover_hint')}
          checked={settings.useAutoDiscover}
          onChange={() => handleAutoDiscoverChange(true)}
        />
        <Radio
          name="serverMode"
          value="manual"
          label={t('server_custom_url')}
          description={t('server_custom_url_hint')}
          checked={!settings.useAutoDiscover}
          onChange={() => handleAutoDiscoverChange(false)}
        />

        {/* URL input (shown when custom mode) */}
        {!settings.useAutoDiscover && (
          <div className={styles.field}>
            <label htmlFor="server-url" className={styles.label}>
              {t('server_url_label')}
            </label>
            <div className={styles.inlineRow}>
              <div className={styles.grow}>
                <TextInput
                  id="server-url"
                  kind="address"
                  inputMode="url"
                  placeholder={t('server_url_placeholder')}
                  value={urlInput}
                  onInput={handleUrlChange}
                  onBlur={handleUrlBlur}
                  autoComplete="url"
                  invalid={addressMissing}
                  aria-describedby={addressMissing ? 'server-url-missing' : undefined}
                />
              </div>
              <Button
                onAction={handleConnect}
                labels={{ busy: t('server_testing') }}
                disabled={!urlInput.trim()}
              >
                {t('server_test_connection')}
              </Button>
            </div>
            <span className={styles.hint}>{t('server_url_hint')}</span>

            {/* Manual mode with no saved address */}
            {addressMissing && (
              <div id="server-url-missing" className={styles.status}>
                <StatusDot state="failed" />
                <span>{t('server_url_missing')}</span>
              </div>
            )}

            {/* Test result */}
            {testResult && (
              <div className={styles.status}>
                <StatusDot state={testResult.success ? 'connected' : 'failed'} />
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
