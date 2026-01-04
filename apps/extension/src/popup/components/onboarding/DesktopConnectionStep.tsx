import { useEffect, useState, useCallback } from 'preact/hooks';
import { WizardStep, Alert, Button } from '@thaumic-cast/ui';
import { Monitor, Download, RefreshCw } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import { useConnectionStatus } from '../../hooks/useConnectionStatus';
import { discoverDesktopApp } from '../../../lib/discovery';
import styles from './DesktopConnectionStep.module.css';

interface DesktopConnectionStepProps {
  /** Callback when connection status changes */
  onConnectionChange: (connected: boolean) => void;
}

/**
 * Desktop app connection detection step.
 * Shows connection status and provides download link if not found.
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

  const handleRetry = useCallback(async () => {
    setIsRetrying(true);
    try {
      const app = await discoverDesktopApp();
      if (app) {
        await chrome.runtime.sendMessage({
          type: 'WS_CONNECT',
          url: app.url,
          maxStreams: app.maxStreams,
        });
      }
    } finally {
      setIsRetrying(false);
    }
  }, []);

  useEffect(() => {
    onConnectionChange(connected);
  }, [connected, onConnectionChange]);

  const handleDownload = () => {
    // Open releases page in new tab
    chrome.tabs.create({ url: 'https://github.com/thaumic-cast/releases' });
  };

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
        </>
      )}
    </WizardStep>
  );
}
