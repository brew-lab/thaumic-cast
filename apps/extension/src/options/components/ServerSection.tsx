import type { JSX } from 'preact';
import { useState, useCallback, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { AddressField, Card, ChoiceGroup, Notice } from '@thaumic-cast/ui';
import type { ExtensionSettings } from '../../lib/settings';
import { connectToServer, isServerUrl, serverAddressResult } from '../../lib/serverTest';
import { releaseHostPermission } from '../../lib/hostPermission';

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

  // Manual mode with nothing saved is not a setting that works: discovery has
  // no address to use and goes on scanning this machine. The Notice says so,
  // and the Announcer says it once when it appears.
  const addressMissing = !settings.useAutoDiscover && !settings.serverUrl;

  // Sync urlInput with settings.serverUrl when settings change externally
  useEffect(() => {
    setUrlInput(settings.serverUrl ?? '');
  }, [settings.serverUrl]);

  /**
   * Handles auto-discover toggle. Leaving manual mode gives the manual
   * server's permission back.
   */
  const handleModeChange = useCallback(
    async (mode: 'auto' | 'manual') => {
      const useAutoDiscover = mode === 'auto';
      await onUpdate({ useAutoDiscover });
      if (useAutoDiscover && settings.serverUrl) {
        await releaseHostPermission(settings.serverUrl);
      }
    },
    [onUpdate, settings.serverUrl],
  );

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
   * Connects to the entered URL; the shared flow saves it on success.
   */
  const handleConnect = useCallback(
    async (url: string) => serverAddressResult(await connectToServer(url), t),
    [t],
  );

  return (
    <Card title={t('server_section_title')}>
      <ChoiceGroup
        legend={t('server_section_title')}
        legendHidden
        value={settings.useAutoDiscover ? 'auto' : 'manual'}
        onChange={handleModeChange}
        options={[
          {
            value: 'auto',
            label: t('server_auto_discover'),
            description: t('server_auto_discover_hint'),
          },
          {
            value: 'manual',
            label: t('server_custom_url'),
            description: t('server_custom_url_hint'),
          },
        ]}
      />

      {!settings.useAutoDiscover && (
        <>
          {addressMissing && <Notice tone="warning" text={t('server_url_missing')} />}
          <AddressField
            kind="server"
            label={t('server_url_label')}
            placeholder={t('server_url_placeholder')}
            value={urlInput}
            onChange={setUrlInput}
            onBlur={handleUrlBlur}
            onTest={handleConnect}
            validate={(value) => (isServerUrl(value) ? undefined : t('server_url_invalid'))}
            action={{
              idle: t('server_test_connection'),
              busy: t('server_testing'),
              failed: t('retry_connection_not_found'),
            }}
            help={t('server_url_hint')}
          />
        </>
      )}
    </Card>
  );
}
