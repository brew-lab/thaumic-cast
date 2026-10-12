import type { JSX } from 'preact';
import { useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { SegmentedControl, SettingsRow, SettingsSection } from '@thaumic-cast/ui';
import type { ExtensionSettings, ThemeMode } from '../../lib/settings';
import { applyTheme } from '../../lib/theme';

interface AppearanceSectionProps {
  settings: ExtensionSettings;
  onUpdate: (partial: Partial<ExtensionSettings>) => Promise<void>;
}

/**
 * Appearance settings section for theme selection.
 * @param props - Component props
 * @param props.settings - Current extension settings
 * @param props.onUpdate - Callback to update settings
 * @returns The appearance section element
 */
export function AppearanceSection({ settings, onUpdate }: AppearanceSectionProps): JSX.Element {
  const { t } = useTranslation();

  const handleThemeChange = useCallback(
    async (theme: ThemeMode) => {
      applyTheme(theme);
      await onUpdate({ theme });
    },
    [onUpdate],
  );

  return (
    <SettingsSection title={t('appearance_section_title')}>
      <SettingsRow
        label={t('appearance_theme')}
        controlWidth="wide"
        help={settings.theme === 'auto' ? t('appearance_theme_auto_desc') : undefined}
        control={(a11y) => (
          <SegmentedControl
            label={t('appearance_theme')}
            hideLabel
            value={settings.theme}
            onChange={handleThemeChange}
            aria-describedby={a11y['aria-describedby']}
            options={[
              { value: 'auto', label: t('appearance_theme_auto'), glyph: 'contrast' },
              { value: 'light', label: t('appearance_theme_light'), glyph: 'sun' },
              { value: 'dark', label: t('appearance_theme_dark'), glyph: 'moon' },
            ]}
          />
        )}
      />
    </SettingsSection>
  );
}
