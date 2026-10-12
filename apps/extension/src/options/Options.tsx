import type { JSX } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { EmptyState, Notice, OptionsShell, Toast } from '@thaumic-cast/ui';
import { ServerSection } from './components/ServerSection';
import { AudioSection } from './components/AudioSection';
import { AppearanceSection } from './components/AppearanceSection';
import { LanguageSection } from './components/LanguageSection';
import { AdvancedSection } from './components/AdvancedSection';
import { AboutSection } from './components/AboutSection';
import { SetsSection } from './components/SetsSection';
import { useSavedSets } from './hooks/useSavedSets';
import type { RemovedSet } from '../lib/room-sets';
import { useExtensionSettings } from './hooks/useExtensionSettings';
import { useCodecSupport } from './hooks/useCodecSupport';
import { useConnectionStatus } from '../popup/hooks/useConnectionStatus';
import { companionCapability } from '../lib/capture-capability';
import { hasLanguageChoice } from '../lib/i18n';

/**
 * The options page (DESIGN.md L-page): the OptionsShell with its sections in the drawing's
 * order (Appearance, Language while there is a choice, Companion, Audio, Finer points, Saved
 * sets, About). A failed load or save is one danger Notice for the page, said once and
 * cleared by the next good save; loading shows its words in place of the sections. The bar
 * at the page's end holds the Toast after a removed set.
 * @returns The options page element
 */
export function Options(): JSX.Element {
  const { t } = useTranslation();
  const { settings, updateSettings, loading: settingsLoading, error } = useExtensionSettings();
  const { codecSupport, loading: codecLoading } = useCodecSupport();
  const saved = useSavedSets();
  // The Toast after a removed set (M-toast): one at a time, never timed; Undo puts it back.
  const [removed, setRemoved] = useState<RemovedSet | null>(null);
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

  return (
    <OptionsShell
      title={t('settings_title')}
      busy={settingsLoading}
      notice={error && <Notice kind="banner" tone="danger" text={error} />}
      toast={
        removed && (
          <Toast
            text={t('set_removed', { name: removed.set.name })}
            action={{
              label: t('undo'),
              onAction: async () => {
                await saved.restore(removed);
                setRemoved(null);
              },
            }}
            onDismiss={() => setRemoved(null)}
            dismissLabel={t('dismiss')}
          />
        )
      }
    >
      {settingsLoading ? (
        <EmptyState kind="searching" body={t('loading_settings')} />
      ) : (
        <>
          <AppearanceSection settings={settings} onUpdate={updateSettings} />

          {hasLanguageChoice() && <LanguageSection settings={settings} onUpdate={updateSettings} />}

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

          <SetsSection saved={saved} onRemoved={setRemoved} onChange={() => setRemoved(null)} />

          <AboutSection connection={connection} />
        </>
      )}
    </OptionsShell>
  );
}
