import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { Card } from '@thaumic-cast/ui';
import {
  COMPANION_INFO_STORAGE_KEY,
  type CompanionInfo,
  getCompanionInfo,
} from '../../lib/versionCheck';
import styles from '../Options.module.css';

/**
 * About section showing extension information and — when the extension is
 * connected to a desktop app or server — that companion's reported version
 * metadata. Values are read from `chrome.storage.local`, populated by the
 * offscreen worker on each successful handshake.
 * @returns The about section element
 */
export function AboutSection(): JSX.Element {
  const { t } = useTranslation();
  const version = chrome.runtime.getManifest().version;
  const [companion, setCompanion] = useState<CompanionInfo | null>(null);

  useEffect(() => {
    getCompanionInfo()
      .then(setCompanion)
      .catch(() => setCompanion(null));

    const handler = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      const change = changes[COMPANION_INFO_STORAGE_KEY];
      if (change?.newValue !== undefined) {
        setCompanion(change.newValue as CompanionInfo);
      }
    };
    chrome.storage.local.onChanged.addListener(handler);
    return () => chrome.storage.local.onChanged.removeListener(handler);
  }, []);

  const companionTypeLabel = t(
    companion?.appType === 'server'
      ? 'about_companion_type_server'
      : companion?.appType === 'desktop'
        ? 'about_companion_type_desktop'
        : 'about_companion_type_generic',
  );

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
            <>
              <div className={styles.hint}>
                {companionTypeLabel} · {t('about_version', { version: companion.appVersion })}
              </div>
              <div className={styles.hint}>
                {t('about_companion_protocol', { version: companion.protocolVersion })}
              </div>
            </>
          ) : (
            <div className={styles.hint}>{t('about_companion_not_connected')}</div>
          )}
        </div>
      </div>
    </Card>
  );
}
