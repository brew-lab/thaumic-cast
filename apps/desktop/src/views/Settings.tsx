import { useEffect, useState } from 'preact/hooks';
import { getAutostartEnabled, setAutostartEnabled } from '../state/store';
import { useTranslation } from 'react-i18next';
import { Power, Globe } from 'lucide-preact';
import i18n, { resources, SupportedLocale } from '../lib/i18n';
import styles from './Settings.module.css';

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
 * @returns The rendered Settings page
 */
export function Settings() {
  const { t } = useTranslation();
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [currentLanguage, setCurrentLanguage] = useState<SupportedLocale>(
    i18n.language as SupportedLocale,
  );

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
      console.error('Failed to set autostart:', error);
    }
  };

  const handleLanguageChange = (locale: SupportedLocale) => {
    i18n.changeLanguage(locale);
    setCurrentLanguage(locale);
  };

  const availableLanguages = Object.keys(resources) as SupportedLocale[];

  return (
    <div className={styles.settings}>
      <h2 className={styles.title}>{t('nav.settings')}</h2>

      {/* Startup Section */}
      <div className={styles.section}>
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
      </div>

      {/* Language Section */}
      <div className={styles.section}>
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
      </div>
    </div>
  );
}
