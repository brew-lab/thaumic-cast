import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { Card } from '@thaumic-cast/ui';
import {
  COMPANION_INFO_STORAGE_KEY,
  companionTypeLabelKey,
  type CompanionInfo,
  getCompanionInfo,
} from '../../lib/versionCheck';
import { useStorageListener } from '../../popup/hooks/useStorageListener';
import styles from '../Options.module.css';

/**
 * About section showing extension information and — when the extension is
 * connected to a desktop app or server — that companion's reported version
 * metadata. Values are read from `chrome.storage.local`, populated by the
 * offscreen worker on each successful handshake; `useStorageListener` keeps
 * the display in sync with live handshake events.
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
  }, []);

  useStorageListener<CompanionInfo>(COMPANION_INFO_STORAGE_KEY, setCompanion);

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
                {t(companionTypeLabelKey(companion.appType))} ·{' '}
                {t('about_version', { version: companion.appVersion })}
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
