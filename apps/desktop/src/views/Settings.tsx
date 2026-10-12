import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  getAutostartEnabled,
  setAutostartEnabled,
  getManualSpeakerIps,
  removeManualSpeakerIp,
  clearSpeakerNotices,
  getSpeakerMonitor,
  setSpeakerMonitor,
  getHeadStart,
  setHeadStart,
  getDriftCompensation,
  setDriftCompensation,
  type DriftCompensationSetting,
  type HeadStartSetting,
  type SpeakerMonitorSetting,
} from '../state/store';
import { headStartOptions } from '../lib/speaker-notices';
import { driftModeForToggle, driftToggleState } from '../lib/drift-setting';
import { speakerMonitorOverrideKey } from '../lib/speaker-monitor-setting';
import { useTranslation } from 'react-i18next';
import { getVersion } from '@tauri-apps/api/app';
import { open } from '@tauri-apps/plugin-shell';
import { Button, Card, Chip, Cluster, SegmentedControl, Select, Switch } from '@thaumic-cast/ui';
import { PROTOCOL_VERSION } from '@thaumic-cast/protocol';
import { createLogger, GITHUB_RELEASES_URL } from '@thaumic-cast/shared';
import i18n, { resources, SupportedLocale } from '../lib/i18n';
import { hasLanguageChoice } from '../lib/language-choice';
import { type ThemeMode, getTheme, saveTheme, applyTheme } from '../lib/theme';
import { ManualSpeakerForm } from '../components/ManualSpeakerForm';
import styles from './Settings.module.css';

const log = createLogger('Settings');

/** Language display names */
const LANGUAGE_NAMES: Record<SupportedLocale, string> = {
  en: 'English',
};

/**
 * Settings page.
 *
 * Allows users to configure app preferences:
 * - Autostart on login
 * - Language selection, once there is more than one language
 * - Theme (auto/light/dark)
 * - Speaker monitoring, the speaker head start, clock drift correction and
 *   speakers added by IP address
 * @returns The rendered Settings page
 */
export function Settings() {
  const { t } = useTranslation();
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [speakerMonitor, setSpeakerMonitorState] = useState<SpeakerMonitorSetting | null>(null);
  const [headStart, setHeadStartState] = useState<HeadStartSetting | null>(null);
  const [drift, setDriftState] = useState<DriftCompensationSetting | null>(null);
  const [currentLanguage, setCurrentLanguage] = useState<SupportedLocale>(
    i18n.language as SupportedLocale,
  );
  const [currentTheme, setCurrentTheme] = useState<ThemeMode>(getTheme);

  // Manual speaker state
  const [manualIps, setManualIps] = useState<string[]>([]);
  const [removingIp, setRemovingIp] = useState<string | null>(null);

  // App version for the About section
  const [appVersion, setAppVersion] = useState<string>('');

  const handleSpeakerAdded = useCallback((ip: string) => {
    // Prevent duplicates in UI (backend also prevents, but avoid UI flicker)
    setManualIps((prev) => (prev.includes(ip) ? prev : [...prev, ip]));
  }, []);

  useEffect(() => {
    getAutostartEnabled()
      .then(setAutostart)
      .catch(() => setAutostart(false));

    getManualSpeakerIps()
      .then(setManualIps)
      .catch(() => setManualIps([]));

    getSpeakerMonitor()
      .then(setSpeakerMonitorState)
      .catch((error) => log.error('Failed to read speaker monitoring setting:', error));

    getHeadStart()
      .then(setHeadStartState)
      .catch((error) => log.error('Failed to read the speaker head start setting:', error));

    getDriftCompensation()
      .then(setDriftState)
      .catch((error) => log.error('Failed to read the drift correction setting:', error));

    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(''));
  }, []);

  const handleCheckForUpdates = useCallback(() => {
    open(GITHUB_RELEASES_URL);
  }, []);

  const handleRemoveSpeaker = useCallback(async (ip: string) => {
    setRemovingIp(ip);
    try {
      await removeManualSpeakerIp(ip);
      setManualIps((prev) => prev.filter((i) => i !== ip));
      // Backend automatically triggers topology refresh; Speakers view updates via event listener
    } catch (error) {
      log.error('Failed to remove speaker:', error);
      // Refresh from backend to restore consistent state
      getManualSpeakerIps()
        .then(setManualIps)
        .catch(() => {});
    } finally {
      setRemovingIp(null);
    }
  }, []);

  const handleAutostartChange = async (enabled: boolean) => {
    try {
      await setAutostartEnabled(enabled);
      setAutostart(enabled);
    } catch (error) {
      log.error('Failed to set autostart:', error);
    }
  };

  const handleSpeakerMonitorChange = async (enabled: boolean) => {
    try {
      const setting = await setSpeakerMonitor(enabled);
      setSpeakerMonitorState(setting);
      // No more reports will replace the notices showing, so drop them now.
      if (!(setting.envOverride ?? setting.enabled)) clearSpeakerNotices();
    } catch (error) {
      log.error('Failed to set speaker monitoring:', error);
      getSpeakerMonitor()
        .then(setSpeakerMonitorState)
        .catch(() => {});
    }
  };

  const handleHeadStartChange = async (ms: number) => {
    try {
      setHeadStartState(await setHeadStart(ms));
    } catch (error) {
      log.error('Failed to set the speaker head start:', error);
      // Re-read so the select stops showing a value that was not saved.
      getHeadStart()
        .then(setHeadStartState)
        .catch(() => {});
    }
  };

  const handleDriftChange = async (checked: boolean) => {
    try {
      setDriftState(await setDriftCompensation(driftModeForToggle(checked)));
    } catch (error) {
      log.error('Failed to set drift correction:', error);
      // Re-read so the toggle stops showing a value that was not saved.
      getDriftCompensation()
        .then(setDriftState)
        .catch(() => {});
    }
  };

  const handleLanguageChange = (locale: SupportedLocale) => {
    i18n.changeLanguage(locale);
    setCurrentLanguage(locale);
  };

  const handleThemeChange = (theme: ThemeMode) => {
    applyTheme(theme);
    saveTheme(theme);
    setCurrentTheme(theme);
  };

  const availableLanguages = Object.keys(resources) as SupportedLocale[];
  const headStartMs = headStart?.envOverride ?? headStart?.ms ?? null;
  const monitorOn = speakerMonitor ? (speakerMonitor.envOverride ?? speakerMonitor.enabled) : null;
  const monitorOverrideKey = speakerMonitorOverrideKey(speakerMonitor);
  const driftToggle = driftToggleState(drift, monitorOn);

  return (
    <div className={styles.settings}>
      <h2 className={styles.pageTitle}>{t('nav.settings')}</h2>

      {/* Startup Section */}
      <Card id="startup" title={t('settings.startup')} titleLevel="h3" className={styles.section}>
        <div className={styles.sectionContent}>
          <Switch
            label={t('settings.autostart')}
            description={t('settings.autostart_description')}
            checked={autostart ?? false}
            onChange={handleAutostartChange}
            disabled={autostart === null}
          />
        </div>
      </Card>

      {/* Language Section: shown once there is a second language to pick */}
      {hasLanguageChoice(availableLanguages) && (
        <Card
          id="language"
          title={t('settings.language')}
          titleLevel="h3"
          className={styles.section}
        >
          <div className={styles.sectionContent}>
            <Select
              label={t('settings.display_language')}
              value={currentLanguage}
              options={availableLanguages.map((locale) => ({
                value: locale,
                label: LANGUAGE_NAMES[locale],
              }))}
              onChange={handleLanguageChange}
            />
          </div>
        </Card>
      )}

      {/* Appearance Section */}
      <Card
        id="appearance"
        title={t('settings.appearance')}
        titleLevel="h3"
        className={styles.section}
      >
        <div className={styles.sectionContent}>
          <div className={styles.field}>
            <SegmentedControl
              label={t('settings.theme')}
              value={currentTheme}
              onChange={handleThemeChange}
              options={[
                { value: 'auto', label: t('settings.theme_auto'), glyph: 'contrast' },
                { value: 'light', label: t('settings.theme_light'), glyph: 'sun' },
                { value: 'dark', label: t('settings.theme_dark'), glyph: 'moon' },
              ]}
            />
            {currentTheme === 'auto' && (
              <span className={styles.hint}>{t('settings.theme_auto_desc')}</span>
            )}
          </div>
        </div>
      </Card>

      {/* Speakers Section */}
      <Card id="speakers" title={t('settings.speakers')} titleLevel="h3" className={styles.section}>
        <div className={styles.sectionContent}>
          <Switch
            label={t('settings.speaker_monitor')}
            description={t('settings.speaker_monitor_description')}
            note={monitorOverrideKey !== null ? t(monitorOverrideKey) : undefined}
            checked={speakerMonitor?.envOverride ?? speakerMonitor?.enabled ?? false}
            onChange={handleSpeakerMonitorChange}
            disabled={speakerMonitor === null || speakerMonitor.envOverride !== null}
          />

          <div className={styles.field}>
            {headStartMs !== null && (
              <Select
                id="settings-head-start"
                label={t('settings.head_start')}
                value={headStartMs}
                options={headStartOptions(headStartMs).map(({ ms, custom }) => ({
                  value: ms,
                  label: custom
                    ? t('settings.head_start_custom', { value: ms })
                    : ms === 0
                      ? t('settings.head_start_off')
                      : t('settings.head_start_ms', { value: ms }),
                }))}
                onChange={handleHeadStartChange}
                disabled={headStart === null || headStart.envOverride !== null}
                aria-describedby="settings-head-start-description"
              />
            )}
            <p id="settings-head-start-description" className={styles.toggleDescription}>
              {t('settings.head_start_description')}
            </p>
            {headStart?.envOverride != null && (
              <span className={styles.hint}>
                {headStart.envOverride === 0
                  ? t('settings.head_start_env_off')
                  : t('settings.head_start_env', { value: headStart.envOverride })}
              </span>
            )}
          </div>

          <Switch
            label={t('settings.drift')}
            description={t('settings.drift_description')}
            note={driftToggle.hint ? t(driftToggle.hint.key) : undefined}
            checked={driftToggle.checked}
            onChange={handleDriftChange}
            disabled={driftToggle.disabled}
          />

          {manualIps.length > 0 && (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>{t('settings.manual_speakers')}</span>
              <Cluster as="ul" gap="3">
                {manualIps.map((ip) => (
                  <li key={ip}>
                    <Chip
                      label={ip}
                      mono
                      removeLabel={`${t('settings.remove_speaker')}: ${ip}`}
                      onRemove={() => handleRemoveSpeaker(ip)}
                      disabled={removingIp !== null}
                    />
                  </li>
                ))}
              </Cluster>
            </div>
          )}

          <div className={styles.field}>
            <label htmlFor="settings-speaker-ip" className={styles.fieldLabel}>
              {t('settings.add_speaker')}
            </label>
            <ManualSpeakerForm
              inputId="settings-speaker-ip"
              buttonVariant="secondary"
              onSuccess={handleSpeakerAdded}
            />
          </div>
        </div>
      </Card>

      {/* About Section */}
      <Card id="about" title={t('settings.about')} titleLevel="h3" className={styles.section}>
        <div className={styles.sectionContent}>
          <div className={styles.field}>
            <div className={styles.fieldLabel}>{t('settings.about_app')}</div>
            <div className={styles.hint}>
              {appVersion ? t('settings.about_version', { version: appVersion }) : '—'}
            </div>
            <div className={styles.hint}>
              {t('settings.about_protocol', { version: PROTOCOL_VERSION })}
            </div>
          </div>

          <div className={styles.field}>
            <div>
              <Button icon="external" onClick={handleCheckForUpdates}>
                {t('settings.check_for_updates')}
              </Button>
            </div>
            <div className={styles.hint}>{t('settings.check_for_updates_description')}</div>
          </div>
        </div>
      </Card>
    </div>
  );
}
