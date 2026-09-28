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
  type HeadStartSetting,
  type SpeakerMonitorSetting,
} from '../state/store';
import { headStartOptions } from '../lib/speaker-notices';
import { useTranslation } from 'react-i18next';
import { ExternalLink, X } from 'lucide-preact';
import { getVersion } from '@tauri-apps/api/app';
import { open } from '@tauri-apps/plugin-shell';
import { Button, Card } from '@thaumic-cast/ui';
import { PROTOCOL_VERSION } from '@thaumic-cast/protocol';
import { createLogger, GITHUB_RELEASES_URL } from '@thaumic-cast/shared';
import i18n, { resources, SupportedLocale } from '../lib/i18n';
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
 * - Language selection
 * - Theme (auto/light/dark)
 * - Speaker monitoring, the speaker head start and hand-added speakers
 * @returns The rendered Settings page
 */
export function Settings() {
  const { t } = useTranslation();
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [speakerMonitor, setSpeakerMonitorState] = useState<SpeakerMonitorSetting | null>(null);
  const [headStart, setHeadStartState] = useState<HeadStartSetting | null>(null);
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

  return (
    <div className={styles.settings}>
      <h2 className={styles.pageTitle}>{t('nav.settings')}</h2>

      {/* Startup Section */}
      <Card id="startup" title={t('settings.startup')} titleLevel="h3" className={styles.section}>
        <div className={styles.sectionContent}>
          <label className={styles.toggle}>
            <div className={styles.toggleInfo}>
              <h4 className={styles.toggleLabel}>{t('settings.autostart')}</h4>
              <p className={styles.toggleDescription}>{t('settings.autostart_description')}</p>
            </div>
            <input
              type="checkbox"
              checked={autostart ?? false}
              onChange={(e) => handleAutostartChange(e.currentTarget.checked)}
              disabled={autostart === null}
              className={styles.checkbox}
            />
          </label>
        </div>
      </Card>

      {/* Language Section */}
      <Card id="language" title={t('settings.language')} titleLevel="h3" className={styles.section}>
        <div className={styles.sectionContent}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>{t('settings.display_language')}</label>
            <select
              value={currentLanguage}
              onChange={(e) => handleLanguageChange(e.currentTarget.value as SupportedLocale)}
              className={styles.select}
            >
              {availableLanguages.map((locale) => (
                <option key={locale} value={locale}>
                  {LANGUAGE_NAMES[locale]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      {/* Appearance Section */}
      <Card
        id="appearance"
        title={t('settings.appearance')}
        titleLevel="h3"
        className={styles.section}
      >
        <div className={styles.sectionContent}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>{t('settings.theme')}</label>
            <select
              value={currentTheme}
              onChange={(e) => handleThemeChange(e.currentTarget.value as ThemeMode)}
              className={styles.select}
            >
              <option value="auto">{t('settings.theme_auto')}</option>
              <option value="light">{t('settings.theme_light')}</option>
              <option value="dark">{t('settings.theme_dark')}</option>
            </select>
            {currentTheme === 'auto' && (
              <span className={styles.hint}>{t('settings.theme_auto_desc')}</span>
            )}
          </div>
        </div>
      </Card>

      {/* Speakers Section */}
      <Card id="speakers" title={t('settings.speakers')} titleLevel="h3" className={styles.section}>
        <div className={styles.sectionContent}>
          <div className={styles.field}>
            <label className={styles.toggle}>
              <div className={styles.toggleInfo}>
                <h4 className={styles.toggleLabel}>{t('settings.speaker_monitor')}</h4>
                <p className={styles.toggleDescription}>
                  {t('settings.speaker_monitor_description')}
                </p>
              </div>
              <input
                type="checkbox"
                checked={speakerMonitor?.envOverride ?? speakerMonitor?.enabled ?? false}
                onChange={(e) => handleSpeakerMonitorChange(e.currentTarget.checked)}
                disabled={speakerMonitor === null || speakerMonitor.envOverride !== null}
                className={styles.checkbox}
              />
            </label>
            {speakerMonitor?.envOverride != null && (
              <span className={styles.hint}>
                {t(
                  speakerMonitor.envOverride
                    ? 'settings.speaker_monitor_env_on'
                    : 'settings.speaker_monitor_env_off',
                )}
              </span>
            )}
          </div>

          <div className={styles.field}>
            <label htmlFor="settings-head-start" className={styles.toggleLabel}>
              {t('settings.head_start')}
            </label>
            <p className={styles.toggleDescription}>{t('settings.head_start_description')}</p>
            <select
              id="settings-head-start"
              value={headStartMs ?? ''}
              onChange={(e) => handleHeadStartChange(Number(e.currentTarget.value))}
              disabled={headStart === null || headStart.envOverride !== null}
              className={styles.select}
            >
              {headStartMs !== null &&
                headStartOptions(headStartMs).map(({ ms, custom }) => (
                  <option key={ms} value={ms}>
                    {custom
                      ? t('settings.head_start_custom', { value: ms })
                      : ms === 0
                        ? t('settings.head_start_off')
                        : t('settings.head_start_ms', { value: ms })}
                  </option>
                ))}
            </select>
            {headStart?.envOverride != null && (
              <span className={styles.hint}>
                {headStart.envOverride === 0
                  ? t('settings.head_start_env_off')
                  : t('settings.head_start_env', { value: headStart.envOverride })}
              </span>
            )}
          </div>

          {manualIps.length > 0 && (
            <div className={styles.field}>
              <label className={styles.fieldLabel}>{t('settings.manual_speakers')}</label>
              <ul className={styles.speakerList}>
                {manualIps.map((ip) => (
                  <li key={ip} className={styles.speakerItem}>
                    <span>{ip}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveSpeaker(ip)}
                      className={styles.removeButton}
                      aria-label={t('settings.remove_speaker')}
                      title={t('settings.remove_speaker')}
                      disabled={removingIp !== null}
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
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
            <Button variant="secondary" onClick={handleCheckForUpdates}>
              <ExternalLink size={16} />
              {t('settings.check_for_updates')}
            </Button>
            <div className={styles.hint}>{t('settings.check_for_updates_description')}</div>
          </div>
        </div>
      </Card>
    </div>
  );
}
