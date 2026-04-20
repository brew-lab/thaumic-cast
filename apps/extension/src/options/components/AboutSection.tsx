import type { JSX } from 'preact';
import { useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { Button, Card } from '@thaumic-cast/ui';
import { GITHUB_RELEASES_URL } from '@thaumic-cast/shared';
import { companionTypeLabelKey, hasVersionMismatch } from '../../lib/versionCheck';
import { useConnectionStatus } from '../../popup/hooks/useConnectionStatus';
import styles from '../Options.module.css';

/**
 * About section showing extension information and — when the extension is
 * connected to a desktop app or server — that companion's reported version
 * metadata. Reads from `useConnectionStatus` (backed by `connectionState`),
 * which is populated by `/health` at discovery and `INITIAL_STATE` on
 * WebSocket connect.
 * @returns The about section element
 */
export function AboutSection(): JSX.Element {
  const { t } = useTranslation();
  const version = chrome.runtime.getManifest().version;
  const connection = useConnectionStatus();

  const handleOpenReleases = useCallback(() => {
    chrome.tabs.create({ url: GITHUB_RELEASES_URL });
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

  return (
    <Card title={t('about_section_title')}>
      <div className={styles.cardContent}>
        <div>
          <div style={{ fontWeight: 500 }}>{t('about_extension_name')}</div>
          <div className={styles.hint}>{t('about_version', { version })}</div>
        </div>

        <div>
          <div style={{ fontWeight: 500 }}>{t('about_companion_heading')}</div>
          {companion ? (
            companion.appVersion && companion.protocolVersion ? (
              <>
                <div className={styles.hint}>
                  {t(companionTypeLabelKey(companion.appType))} ·{' '}
                  {t('about_version', { version: companion.appVersion })}
                  {mismatch && (
                    <>
                      {' · '}
                      <Button variant="link" onClick={handleOpenReleases}>
                        {t('update_available')}
                      </Button>
                    </>
                  )}
                </div>
                <div className={styles.hint}>
                  {t('about_companion_protocol', { version: companion.protocolVersion })}
                </div>
              </>
            ) : (
              <div className={styles.hint}>
                {t('about_companion_unknown_version')}
                {mismatch && (
                  <>
                    {' · '}
                    <Button variant="link" onClick={handleOpenReleases}>
                      {t('update_available')}
                    </Button>
                  </>
                )}
              </div>
            )
          ) : (
            <div className={styles.hint}>{t('about_companion_not_connected')}</div>
          )}
        </div>
      </div>
    </Card>
  );
}
