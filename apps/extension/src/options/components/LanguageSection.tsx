import type { JSX } from 'preact';
import { useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { Card } from '@thaumic-cast/ui';
import type { ExtensionSettings, SupportedLocale } from '../../lib/settings';
import { SUPPORTED_LOCALES, changeLanguage, getInitialLanguage } from '../../lib/i18n';
import styles from '../Options.module.css';

interface LanguageSectionProps {
  settings: ExtensionSettings;
  onUpdate: (partial: Partial<ExtensionSettings>) => Promise<void>;
}

/**
 * Language selection section. The options page shows it only when there is
 * more than one language to choose between (see `hasLanguageChoice`).
 *
 * The stored language may be 'auto' (follow the browser); the picker then
 * shows the language in use. Picking one stores it as an explicit choice.
 * @param root0
 * @param root0.settings
 * @param root0.onUpdate
 * @returns The language section element
 */
export function LanguageSection({ settings, onUpdate }: LanguageSectionProps): JSX.Element {
  const { t } = useTranslation();

  const handleLanguageChange = useCallback(
    async (language: SupportedLocale) => {
      await changeLanguage(language);
      await onUpdate({ language });
    },
    [onUpdate],
  );

  return (
    <Card title={t('language_section_title')}>
      <div className={styles.cardContent}>
        <div className={styles.field}>
          <label htmlFor="language-select" className={styles.label}>
            {t('language_label')}
          </label>
          <select
            id="language-select"
            className={styles.select}
            value={getInitialLanguage(settings.language)}
            onChange={(e) =>
              handleLanguageChange((e.target as HTMLSelectElement).value as SupportedLocale)
            }
          >
            {SUPPORTED_LOCALES.map((locale) => (
              <option key={locale} value={locale}>
                {t(`language_${locale}`)}
              </option>
            ))}
          </select>
          <span className={styles.hint}>{t('language_coming_soon')}</span>
        </div>
      </div>
    </Card>
  );
}
