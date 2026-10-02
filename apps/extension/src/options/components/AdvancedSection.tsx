import type { JSX } from 'preact';
import { useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { AppType } from '@thaumic-cast/protocol';
import { Card } from '@thaumic-cast/ui';
import type { CompanionCapability } from '../../lib/audio-resolver';
import { captureToggleState } from '../../lib/capture-capability';
import { isWindowsPlatform, type ExtensionSettings } from '../../lib/settings';
import styles from '../Options.module.css';

interface AdvancedSectionProps {
  settings: ExtensionSettings;
  onUpdate: (partial: Partial<ExtensionSettings>) => Promise<void>;
  /** Which companion is connected; null when none is, or it does not say. */
  appType: AppType | null;
  /** What the connected companion can do. */
  capability: CompanionCapability;
}

/** Browser capture requires WASAPI (Windows only). */
const isWindows = isWindowsPlatform();

/**
 * Advanced settings section for experimental features.
 * Includes video sync and keep tab audible options. A control that cannot act
 * is disabled and says why: keeping the tab awake under browser-wide capture,
 * and browser-wide capture against a companion that cannot capture.
 * @param props - Component props
 * @param props.settings - Current extension settings
 * @param props.onUpdate - Callback to update settings
 * @param props.appType - Which companion is connected
 * @param props.capability - What the connected companion can do
 * @returns The advanced section element
 */
export function AdvancedSection({
  settings,
  onUpdate,
  appType,
  capability,
}: AdvancedSectionProps): JSX.Element {
  const { t } = useTranslation();

  const browserWide = settings.captureMode === 'browser';
  const captureToggle = captureToggleState(settings.captureMode, appType, capability);

  const handleVideoSyncToggle = useCallback(async () => {
    await onUpdate({ videoSyncEnabled: !settings.videoSyncEnabled });
  }, [settings.videoSyncEnabled, onUpdate]);

  const handleKeepTabAudibleToggle = useCallback(async () => {
    await onUpdate({ keepTabAudible: !settings.keepTabAudible });
  }, [settings.keepTabAudible, onUpdate]);

  const handleSyncSpeakersToggle = useCallback(async () => {
    await onUpdate({ syncSpeakers: !settings.syncSpeakers });
  }, [settings.syncSpeakers, onUpdate]);

  const handleCaptureModeToggle = useCallback(async () => {
    await onUpdate({ captureMode: settings.captureMode === 'browser' ? 'tab' : 'browser' });
  }, [settings.captureMode, onUpdate]);

  return (
    <Card title={t('advanced_section_title')}>
      <div className={styles.cardContent}>
        <label className={styles.radioOption}>
          <input
            type="checkbox"
            className={styles.radioInput}
            checked={settings.videoSyncEnabled}
            onChange={handleVideoSyncToggle}
            aria-describedby="video-sync-desc video-sync-note"
          />
          <div className={styles.radioContent}>
            <span className={styles.radioLabel}>{t('video_sync_enable')}</span>
            <span id="video-sync-desc" className={styles.radioDesc}>
              {t('video_sync_description')}
            </span>
            <span id="video-sync-note" className={styles.radioNote}>
              {t('video_sync_next_cast')}
            </span>
          </div>
        </label>

        <label
          className={
            browserWide ? `${styles.radioOption} ${styles.radioOptionDisabled}` : styles.radioOption
          }
        >
          <input
            type="checkbox"
            className={styles.radioInput}
            checked={settings.keepTabAudible}
            onChange={handleKeepTabAudibleToggle}
            disabled={browserWide}
            aria-describedby={
              browserWide ? 'keep-tab-audible-desc keep-tab-audible-note' : 'keep-tab-audible-desc'
            }
          />
          <div className={styles.radioContent}>
            <span className={styles.radioLabel}>{t('keep_tab_audible_enable')}</span>
            <span id="keep-tab-audible-desc" className={styles.radioDesc}>
              {t('keep_tab_audible_description')}
            </span>
            {browserWide && (
              <span id="keep-tab-audible-note" className={styles.radioNote}>
                {t('keep_tab_audible_browser_capture_note')}
              </span>
            )}
          </div>
        </label>

        <label className={styles.radioOption}>
          <input
            type="checkbox"
            className={styles.radioInput}
            checked={settings.syncSpeakers}
            onChange={handleSyncSpeakersToggle}
            aria-describedby="sync-speakers-desc"
          />
          <div className={styles.radioContent}>
            <span className={styles.radioLabel}>{t('sync_speakers_enable')}</span>
            <span id="sync-speakers-desc" className={styles.radioDesc}>
              {t('sync_speakers_description')}
            </span>
          </div>
        </label>

        {isWindows && captureToggle.visible && (
          <label
            className={
              captureToggle.disabled
                ? `${styles.radioOption} ${styles.radioOptionDisabled}`
                : styles.radioOption
            }
          >
            <input
              type="checkbox"
              className={styles.radioInput}
              checked={browserWide}
              onChange={handleCaptureModeToggle}
              disabled={captureToggle.disabled}
              aria-describedby={
                captureToggle.noteKeys.length > 0
                  ? 'capture-mode-desc capture-mode-note'
                  : 'capture-mode-desc'
              }
            />
            <div className={styles.radioContent}>
              <span className={styles.radioLabel}>{t('capture_mode_browser_enable')}</span>
              <span id="capture-mode-desc" className={styles.radioDesc}>
                {t('capture_mode_browser_description')}
              </span>
              {captureToggle.noteKeys.length > 0 && (
                <span id="capture-mode-note" className={styles.radioNote}>
                  {captureToggle.noteKeys.map((key) => t(key)).join(' ')}
                </span>
              )}
            </div>
          </label>
        )}
      </div>
    </Card>
  );
}
