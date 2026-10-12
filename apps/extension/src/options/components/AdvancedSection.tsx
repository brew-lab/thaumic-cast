import type { JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { AppType } from '@thaumic-cast/protocol';
import { Card, Select, Switch } from '@thaumic-cast/ui';
import type { CompanionCapability } from '../../lib/audio-resolver';
import { captureToggleState } from '../../lib/capture-capability';
import { isWindowsPlatform, type ExtensionSettings } from '../../lib/settings';
import { startCeilingChoices } from '../../lib/start-level';
import { hasVideoSyncHostAccess, requestVideoSyncHostAccess } from '../../lib/video-sync-access';
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
 * Includes video sync, keep tab audible and the start level limit. A control that cannot act
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

  // Video sync works inside each site's player, which needs the all-sites
  // permission: asked for when it is turned on (the click is the gesture the
  // prompt needs). Without it the setting stays off, or, when it was on
  // before the grant was needed or was withdrawn, a note says so.
  const [videoSyncNeedsAccess, setVideoSyncNeedsAccess] = useState(false);
  useEffect(() => {
    if (!settings.videoSyncEnabled) return;
    let live = true;
    void hasVideoSyncHostAccess().then((ok) => {
      if (live) setVideoSyncNeedsAccess(!ok);
    });
    return () => {
      live = false;
    };
  }, [settings.videoSyncEnabled]);

  const handleVideoSyncToggle = useCallback(async () => {
    if (settings.videoSyncEnabled) {
      setVideoSyncNeedsAccess(false);
      await onUpdate({ videoSyncEnabled: false });
      return;
    }
    const granted = await requestVideoSyncHostAccess();
    setVideoSyncNeedsAccess(!granted);
    if (granted) await onUpdate({ videoSyncEnabled: true });
  }, [settings.videoSyncEnabled, onUpdate]);

  const handleKeepTabAudibleToggle = useCallback(async () => {
    await onUpdate({ keepTabAudible: !settings.keepTabAudible });
  }, [settings.keepTabAudible, onUpdate]);

  const handleSyncSpeakersToggle = useCallback(async () => {
    await onUpdate({ syncSpeakers: !settings.syncSpeakers });
  }, [settings.syncSpeakers, onUpdate]);

  const handleStartCeilingChange = useCallback(
    async (value: string) => {
      if (value === 'off') {
        await onUpdate({ startCeilingEnabled: false });
      } else {
        await onUpdate({ startCeilingEnabled: true, startCeiling: Number(value) });
      }
    },
    [onUpdate],
  );

  const handleCaptureModeToggle = useCallback(async () => {
    await onUpdate({ captureMode: settings.captureMode === 'browser' ? 'tab' : 'browser' });
  }, [settings.captureMode, onUpdate]);

  return (
    <Card title={t('advanced_section_title')}>
      <div className={styles.cardContent}>
        <Switch
          label={t('video_sync_enable')}
          description={t('video_sync_description')}
          note={
            videoSyncNeedsAccess
              ? `${t('video_sync_next_cast')} ${t('video_sync_needs_access')}`
              : t('video_sync_next_cast')
          }
          checked={settings.videoSyncEnabled}
          onChange={handleVideoSyncToggle}
        />

        <Switch
          label={t('keep_tab_audible_enable')}
          description={t('keep_tab_audible_description')}
          note={browserWide ? t('keep_tab_audible_browser_capture_note') : undefined}
          checked={settings.keepTabAudible}
          onChange={handleKeepTabAudibleToggle}
          disabled={browserWide}
        />

        <div className={styles.field}>
          <Select
            id="start-ceiling-select"
            label={t('start_ceiling_enable')}
            value={settings.startCeilingEnabled ? String(settings.startCeiling) : 'off'}
            options={[
              ...startCeilingChoices(settings.startCeiling).map((level) => ({
                value: String(level),
                label: String(level),
              })),
              { value: 'off', label: t('start_ceiling_off') },
            ]}
            onChange={handleStartCeilingChange}
            aria-describedby="start-ceiling-desc"
          />
          <span id="start-ceiling-desc" className={styles.hint}>
            {t('start_ceiling_description')}
          </span>
        </div>

        <Switch
          label={t('sync_speakers_enable')}
          description={t('sync_speakers_description')}
          checked={settings.syncSpeakers}
          onChange={handleSyncSpeakersToggle}
        />

        {isWindows && captureToggle.visible && (
          <Switch
            label={t('capture_mode_browser_enable')}
            description={t('capture_mode_browser_description')}
            note={
              captureToggle.noteKeys.length > 0
                ? captureToggle.noteKeys.map((key) => t(key)).join(' ')
                : undefined
            }
            checked={browserWide}
            onChange={handleCaptureModeToggle}
            disabled={captureToggle.disabled}
          />
        )}
      </div>
    </Card>
  );
}
