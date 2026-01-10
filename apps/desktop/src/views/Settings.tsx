import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  getAutostartEnabled,
  setAutostartEnabled,
  getManualSpeakerIps,
  removeManualSpeakerIp,
} from '../state/store';
import { useTranslation } from 'react-i18next';
import { Power, Globe, Palette, Speaker, X } from 'lucide-preact';
import { Card } from '@thaumic-cast/ui';
import { createLogger } from '@thaumic-cast/shared';
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
 * @returns The rendered Settings page
 */
export function Settings() {
  const { t } = useTranslation();
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [currentLanguage, setCurrentLanguage] = useState<SupportedLocale>(
    i18n.language as SupportedLocale,
  );
  const [currentTheme, setCurrentTheme] = useState<ThemeMode>(getTheme);

  // Manual speaker state
  const [manualIps, setManualIps] = useState<string[]>([]);
  const [removingIp, setRemovingIp] = useState<string | null>(null);

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

  return (
    <div className={styles.settings}>
      <h2 className={styles.title}>{t('nav.settings')}</h2>

      {/* Startup Section */}
      <Card noPadding className={styles.section}>
        <div className={styles.sectionHeader}>
          <Power size={18} />
          <h3 className={styles.sectionTitle}>{t('settings.startup')}</h3>
        </div>

        <div className={styles.sectionContent}>
          <label className={styles.toggle}>
            <div className={styles.toggleInfo}>
              <span className={styles.toggleLabel}>{t('settings.autostart')}</span>
              <span className={styles.toggleDescription}>
                {t('settings.autostart_description')}
              </span>
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
      <Card noPadding className={styles.section}>
        <div className={styles.sectionHeader}>
          <Globe size={18} />
          <h3 className={styles.sectionTitle}>{t('settings.language')}</h3>
        </div>

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
      <Card noPadding className={styles.section}>
        <div className={styles.sectionHeader}>
          <Palette size={18} />
          <h3 className={styles.sectionTitle}>{t('settings.appearance')}</h3>
        </div>

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
      <Card noPadding className={styles.section}>
        <div className={styles.sectionHeader}>
          <Speaker size={18} />
          <h3 className={styles.sectionTitle}>{t('settings.speakers')}</h3>
        </div>

        <div className={styles.sectionContent}>
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
    </div>
  );
}
