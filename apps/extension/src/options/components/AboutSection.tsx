import type { JSX } from 'preact';
import { useCallback, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { Button, DescriptionList, SettingsSection, type DescriptionRow } from '@thaumic-cast/ui';
import { GITHUB_RELEASES_URL } from '@thaumic-cast/shared';
import { companionTypeLabelKey, hasVersionMismatch } from '../../lib/versionCheck';
import type { ConnectionStatus } from '../../popup/hooks/useConnectionStatus';
import { UpdatesRow } from './UpdatesRow';

/** The About card's id, which the popup's marked Settings opens (`#about`). */
export const ABOUT_ID = 'about';
const ABOUT_HASH = `#${ABOUT_ID}`;

/**
 * About section showing extension information and — when the extension is
 * connected to a desktop app or server — that companion's reported version
 * metadata. Reads the options page's `useConnectionStatus` (backed by
 * `connectionState`), which is populated by `/health` at discovery and
 * `INITIAL_STATE` on WebSocket connect. Under the readout, Check for updates (UpdatesRow).
 * @param root0
 * @param root0.connection - The options page's connection status
 * @returns The about section element
 */
export function AboutSection({ connection }: { connection: ConnectionStatus }): JSX.Element {
  const { t } = useTranslation();
  const version = chrome.runtime.getManifest().version;

  const handleOpenReleases = useCallback(() => {
    chrome.tabs.create({ url: GITHUB_RELEASES_URL });
  }, []);

  // Opened from the popup's marked Settings (`#about`): the card is drawn after the settings
  // load, too late for the browser's own jump, so it is brought into view here.
  useEffect(() => {
    /** Brings About into view when the fragment names it. */
    const reveal = (): void => {
      if (location.hash === ABOUT_HASH) document.getElementById(ABOUT_ID)?.scrollIntoView();
    };
    reveal();
    window.addEventListener('hashchange', reveal);
    return () => window.removeEventListener('hashchange', reveal);
  }, []);

  const isConnected = connection.phase === 'connected';
  const companion = isConnected
    ? {
        appType: connection.appType,
        appVersion: connection.appVersion,
        protocolVersion: connection.protocolVersion,
      }
    : null;
  const mismatch = hasVersionMismatch(companion);

  const update = mismatch && (
    <>
      {' · '}
      <Button kind="link" icon="external" onClick={handleOpenReleases}>
        {t('update_available')}
      </Button>
    </>
  );

  // Nothing connected: whoever skipped the onboarding, or removed the companion, can still
  // find it from here.
  const companionValue = !companion ? (
    <>
      {t('about_companion_not_connected')}
      <br />
      <Button kind="link" icon="external" onClick={handleOpenReleases}>
        {t('download_companion')}
      </Button>
    </>
  ) : companion.appVersion && companion.protocolVersion ? (
    <>
      {t(companionTypeLabelKey(companion.appType))} ·{' '}
      {t('about_version', { version: companion.appVersion })}
      {update}
      <br />
      {t('about_companion_protocol', { version: companion.protocolVersion })}
    </>
  ) : (
    <>
      {t('about_companion_unknown_version')}
      {update}
    </>
  );

  const rows: readonly DescriptionRow[] = [
    {
      key: 'extension',
      term: t('about_extension_name'),
      value: t('about_version', { version }),
    },
    { key: 'companion', term: t('about_companion_heading'), value: companionValue },
  ];

  return (
    <SettingsSection id={ABOUT_ID} title={t('about_section_title')}>
      <DescriptionList kind="readout" rows={rows} />
      <UpdatesRow />
    </SettingsSection>
  );
}
