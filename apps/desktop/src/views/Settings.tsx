import { useEffect, useState } from 'preact/hooks';
import { getAutostartEnabled, setAutostartEnabled } from '../state/store';
import { useTranslation } from 'react-i18next';
import { Power, Globe, Palette } from 'lucide-preact';
import { Card } from '@thaumic-cast/ui';
import { createLogger } from '@thaumic-cast/shared';
import i18n, { resources, SupportedLocale } from '../lib/i18n';
import { type ThemeMode, getTheme, saveTheme, applyTheme } from '../lib/theme';
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

  useEffect(() => {
    getAutostartEnabled()
      .then(setAutostart)
      .catch(() => setAutostart(false));
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
        <div className={styles['section-header']}>
          <Power size={18} />
          <h3 className={styles['section-title']}>{t('settings.startup')}</h3>
        </div>

        <div className={styles['section-content']}>
          <label className={styles.toggle}>
            <div className={styles['toggle-info']}>
              <span className={styles['toggle-label']}>{t('settings.autostart')}</span>
              <span className={styles['toggle-description']}>
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
        <div className={styles['section-header']}>
          <Globe size={18} />
          <h3 className={styles['section-title']}>{t('settings.language')}</h3>
        </div>

        <div className={styles['section-content']}>
          <div className={styles.field}>
            <label className={styles['field-label']}>{t('settings.display_language')}</label>
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
        <div className={styles['section-header']}>
          <Palette size={18} />
          <h3 className={styles['section-title']}>{t('settings.appearance')}</h3>
        </div>

        <div className={styles['section-content']}>
          <div className={styles.field}>
            <label className={styles['field-label']}>{t('settings.theme')}</label>
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
    </div>
  );
}
