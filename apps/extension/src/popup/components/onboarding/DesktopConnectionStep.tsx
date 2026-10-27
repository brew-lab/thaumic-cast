import { useEffect, useState, useCallback } from 'preact/hooks';
import {
  WizardStep,
  AddressField,
  Button,
  Cluster,
  DescriptionList,
  Disclosure,
  Notice,
} from '@thaumic-cast/ui';
import { useTranslation } from 'react-i18next';
import { DOWNLOAD_URL } from '@thaumic-cast/shared';
import { useConnectionStatus } from '../../hooks/useConnectionStatus';
import { connectToServer, isServerUrl, serverAddressResult } from '../../../lib/serverTest';

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
  const [manualConnected, setManualConnected] = useState(false);

  useEffect(() => {
    onConnectionChange(connected);
  }, [connected, onConnectionChange]);

  const handleDownload = () => {
    // Open the download page in new tab
    chrome.tabs.create({ url: DOWNLOAD_URL });
  };

  /**
   * Connects to the entered URL; the shared flow saves it on success and the
   * background picks up the new settings.
   */
  const handleConnect = useCallback(
    async (url: string) => {
      const result = await connectToServer(url);
      if (result.success) setManualConnected(true);
      return serverAddressResult(result, t);
    },
    [t],
  );

  // The status is a line of words led by a StatusDot (success notices retire).
  const status = (state: 'connected' | 'checking', text: string) => (
    <DescriptionList kind="checklist" rows={[{ key: 'status', state, text }]} />
  );

  return (
    <WizardStep
      title={t('onboarding.desktop.title')}
      subtitle={t('onboarding.desktop.subtitle')}
      glyph="monitor"
    >
      {isSeeking ? (
        status('checking', t('onboarding.desktop.checking'))
      ) : connected ? (
        status('connected', t('onboarding.desktop.found'))
      ) : manualConnected ? (
        status('connected', t('onboarding.desktop.manual_connected'))
      ) : (
        <>
          <Notice tone="warning" text={t('onboarding.desktop.not_found')} />

          <p>{t('onboarding.desktop.download_prompt')}</p>

          <Cluster stack>
            <Button size="md" kind="filled" icon="external" onClick={handleDownload}>
              {t('download_companion')}
            </Button>
            <Button size="md" icon="refresh" onClick={handleRetry} disabled={isSeeking}>
              {t('onboarding.desktop.retry_button')}
            </Button>
          </Cluster>

          {/* Manual configuration section */}
          <Disclosure label={t('onboarding.desktop.manual_toggle')}>
            <AddressField
              size="md"
              kind="server"
              label={t('server_url_label')}
              placeholder={t('server_url_placeholder')}
              value={urlInput}
              onChange={setUrlInput}
              onTest={handleConnect}
              validate={(value) => (isServerUrl(value) ? undefined : t('server_url_invalid'))}
              action={{
                idle: t('server_test_connection'),
                busy: t('server_testing'),
                failed: t('try_again'),
              }}
              help={t('onboarding.desktop.manual_hint')}
            />
          </Disclosure>
        </>
      )}
    </WizardStep>
  );
}
