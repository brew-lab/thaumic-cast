import type { JSX } from 'preact';
import { useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { Select, SettingsRow, SettingsSection } from '@thaumic-cast/ui';
import type { ExtensionSettings, SupportedLocale } from '../../lib/settings';
import { SUPPORTED_LOCALES, changeLanguage, getInitialLanguage } from '../../lib/i18n';

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
    <SettingsSection title={t('language_section_title')}>
      <SettingsRow
        label={t('language_label')}
        control={
          <Select
            label={t('language_label')}
            hideLabel
            value={getInitialLanguage(settings.language)}
            options={SUPPORTED_LOCALES.map((locale) => ({
              value: locale,
              label: t(`language_${locale}`),
            }))}
            onChange={handleLanguageChange}
          />
        }
      />
    </SettingsSection>
  );
}
