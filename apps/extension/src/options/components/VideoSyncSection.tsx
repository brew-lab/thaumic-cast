import type { JSX } from 'preact';
import { useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { Card } from '@thaumic-cast/ui';
import type { ExtensionSettings } from '../../lib/settings';
import styles from '../Options.module.css';

interface VideoSyncSectionProps {
  settings: ExtensionSettings;
  onUpdate: (partial: Partial<ExtensionSettings>) => Promise<void>;
}

/**
 * Video sync settings section for enabling/disabling video sync controls.
 * @param props - Component props
 * @param props.settings - Current extension settings
 * @param props.onUpdate - Callback to update settings
 * @returns The video sync section element
 */
export function VideoSyncSection({ settings, onUpdate }: VideoSyncSectionProps): JSX.Element {
  const { t } = useTranslation();

  const handleToggle = useCallback(async () => {
    await onUpdate({ videoSyncEnabled: !settings.videoSyncEnabled });
  }, [settings.videoSyncEnabled, onUpdate]);

  return (
    <Card title={t('advanced_section_title')}>
      <div className={styles.cardContent}>
        <label className={styles.radioOption}>
          <input
            type="checkbox"
            className={styles.radioInput}
            checked={settings.videoSyncEnabled}
            onChange={handleToggle}
            aria-describedby="video-sync-desc"
          />
          <div className={styles.radioContent}>
            <span className={styles.radioLabel}>{t('video_sync_enable')}</span>
            <span id="video-sync-desc" className={styles.radioDesc}>
              {t('video_sync_description')}
            </span>
          </div>
        </label>
      </div>
    </Card>
  );
}
