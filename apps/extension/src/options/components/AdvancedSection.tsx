import type { JSX } from 'preact';
import { useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { Card } from '@thaumic-cast/ui';
import type { ExtensionSettings } from '../../lib/settings';
import styles from '../Options.module.css';

interface AdvancedSectionProps {
  settings: ExtensionSettings;
  onUpdate: (partial: Partial<ExtensionSettings>) => Promise<void>;
}

/**
 * Advanced settings section for experimental features.
 * Includes video sync and keep tab audible options.
 * @param props - Component props
 * @param props.settings - Current extension settings
 * @param props.onUpdate - Callback to update settings
 * @returns The advanced section element
 */
export function AdvancedSection({ settings, onUpdate }: AdvancedSectionProps): JSX.Element {
  const { t } = useTranslation();

  const handleVideoSyncToggle = useCallback(async () => {
    await onUpdate({ videoSyncEnabled: !settings.videoSyncEnabled });
  }, [settings.videoSyncEnabled, onUpdate]);

  const handleKeepTabAudibleToggle = useCallback(async () => {
    await onUpdate({ keepTabAudible: !settings.keepTabAudible });
  }, [settings.keepTabAudible, onUpdate]);

  return (
    <Card title={t('advanced_section_title')}>
      <div className={styles.cardContent}>
        <label className={styles.radioOption}>
          <input
            type="checkbox"
            className={styles.radioInput}
            checked={settings.videoSyncEnabled}
            onChange={handleVideoSyncToggle}
            aria-describedby="video-sync-desc"
          />
          <div className={styles.radioContent}>
            <span className={styles.radioLabel}>{t('video_sync_enable')}</span>
            <span id="video-sync-desc" className={styles.radioDesc}>
              {t('video_sync_description')}
            </span>
          </div>
        </label>

        <label className={styles.radioOption}>
          <input
            type="checkbox"
            className={styles.radioInput}
            checked={settings.keepTabAudible}
            onChange={handleKeepTabAudibleToggle}
            aria-describedby="keep-tab-audible-desc"
          />
          <div className={styles.radioContent}>
            <span className={styles.radioLabel}>{t('keep_tab_audible_enable')}</span>
            <span id="keep-tab-audible-desc" className={styles.radioDesc}>
              {t('keep_tab_audible_description')}
            </span>
          </div>
        </label>
      </div>
    </Card>
  );
}
