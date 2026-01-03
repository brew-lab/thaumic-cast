import type { JSX } from 'preact';
import { useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { Card } from '@thaumic-cast/ui';
import type { ExtensionSettings, ThemeMode } from '../../lib/settings';
import { applyTheme } from '../../lib/theme';
import styles from '../Options.module.css';

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
    <Card title={t('appearance_section_title')}>
      <div className={styles.cardContent}>
        <div className={styles.field}>
          <label className={styles.label}>{t('appearance_theme')}</label>
          <select
            className={styles.select}
            value={settings.theme}
            onChange={(e) => handleThemeChange((e.target as HTMLSelectElement).value as ThemeMode)}
          >
            <option value="auto">{t('appearance_theme_auto')}</option>
            <option value="light">{t('appearance_theme_light')}</option>
            <option value="dark">{t('appearance_theme_dark')}</option>
          </select>
          {settings.theme === 'auto' && (
            <span className={styles.hint}>{t('appearance_theme_auto_desc')}</span>
          )}
        </div>
      </div>
    </Card>
  );
}
