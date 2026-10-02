import type { JSX } from 'preact';
import { useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { ServerSection } from './components/ServerSection';
import { AudioSection } from './components/AudioSection';
import { AppearanceSection } from './components/AppearanceSection';
import { LanguageSection } from './components/LanguageSection';
import { AdvancedSection } from './components/AdvancedSection';
import { AboutSection } from './components/AboutSection';
import { useExtensionSettings } from './hooks/useExtensionSettings';
import { useCodecSupport } from './hooks/useCodecSupport';
import { useConnectionStatus } from '../popup/hooks/useConnectionStatus';
import { companionCapability } from '../lib/capture-capability';
import styles from './Options.module.css';

/**
 * Main settings page component.
 * Displays all extension configuration options.
 * @returns The options page element
 */
export function Options(): JSX.Element {
  const { t } = useTranslation();
  const { settings, updateSettings, loading: settingsLoading } = useExtensionSettings();
  const { codecSupport, loading: codecLoading } = useCodecSupport();
  const connection = useConnectionStatus();
  const companion = useMemo(
    () => ({ companionAudio: connection.companionAudio, appType: connection.appType }),
    [connection.companionAudio, connection.appType],
  );
  // Nothing is known about a companion that is not connected, whatever the
  // last one said
  const connected = connection.phase === 'connected';
  const capability = useMemo(
    () =>
      companionCapability({
        connected,
        appType: connection.appType,
        browserCapture: connection.browserCapture,
      }),
    [connected, connection.appType, connection.browserCapture],
  );

  if (settingsLoading) {
    return (
      <div className={styles.container} aria-busy="true">
        <h1 className={styles.title}>{t('settings_title')}</h1>
        <div className={styles.loading} role="status">
          {t('loading_settings')}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>{t('settings_title')}</h1>

      <AppearanceSection settings={settings} onUpdate={updateSettings} />

      <LanguageSection settings={settings} onUpdate={updateSettings} />

      <ServerSection settings={settings} onUpdate={updateSettings} />

      <AudioSection
        settings={settings}
        onUpdate={updateSettings}
        codecSupport={codecSupport}
        codecLoading={codecLoading}
        companion={companion}
        capability={capability}
      />

      <AdvancedSection
        settings={settings}
        onUpdate={updateSettings}
        appType={connected ? connection.appType : null}
        capability={capability}
      />

      <AboutSection connection={connection} />
    </div>
  );
}
