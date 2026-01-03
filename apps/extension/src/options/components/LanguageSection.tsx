import type { JSX } from 'preact';
import { useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { Card } from '@thaumic-cast/ui';
import type { ExtensionSettings, SupportedLocale } from '../../lib/settings';
import { changeLanguage } from '../../lib/i18n';
import styles from '../Options.module.css';

interface LanguageSectionProps {
  settings: ExtensionSettings;
  onUpdate: (partial: Partial<ExtensionSettings>) => Promise<void>;
}

/**
 * Language selection section.
 * Currently only English is available.
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
            value={settings.language}
            onChange={(e) =>
              handleLanguageChange((e.target as HTMLSelectElement).value as SupportedLocale)
            }
          >
            <option value="en">{t('language_en')}</option>
          </select>
          <span className={styles.hint}>{t('language_coming_soon')}</span>
        </div>
      </div>
    </Card>
  );
}
