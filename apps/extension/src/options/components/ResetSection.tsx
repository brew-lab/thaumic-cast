import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, SettingsRow, SettingsSection } from '@thaumic-cast/ui';
import type { ExtensionSettings } from '../../lib/settings';
import { isAtDefaults, resetValues } from '../../lib/settings-reset';
import { applyTheme } from '../../lib/theme';
import { changeLanguage, getInitialLanguage } from '../../lib/i18n';

interface ResetSectionProps {
  settings: ExtensionSettings;
  onUpdate: (partial: Partial<ExtensionSettings>) => Promise<void>;
}

/**
 * The page's last settings section (C-section, §11): "Reset all settings", which asks first in
 * a Dialog, as the desktop's Disconnect does, then puts every setting back to its default
 * except the connection. The theme and the language change at once, as when picked by hand;
 * the rest applies as each setting's own row says (most from the next cast). Disabled while
 * every setting is already at its default.
 * @param props - Component props
 * @param props.settings - Current extension settings
 * @param props.onUpdate - Callback to update settings
 * @returns The reset section element
 */
export function ResetSection({ settings, onUpdate }: ResetSectionProps): JSX.Element {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);

  const reset = async (): Promise<void> => {
    const values = resetValues();
    await onUpdate(values);
    applyTheme(values.theme);
    await changeLanguage(getInitialLanguage(values.language));
  };

  return (
    <>
      <SettingsSection title={t('reset')}>
        <SettingsRow
          label={t('reset_all')}
          help={t('reset_all_hint')}
          controlWidth="action"
          control={
            <Button
              kind="outline"
              disabled={isAtDefaults(settings)}
              onClick={() => setConfirming(true)}
              aria-label={t('reset_all')}
            >
              {t('reset')}
            </Button>
          }
        />
      </SettingsSection>
      <Dialog
        open={confirming}
        title={t('reset_all')}
        description={t('reset_all_hint')}
        cancelLabel={t('cancel')}
        closeLabel={t('close')}
        confirm={{ label: t('reset'), failed: t('try_again'), onAction: reset }}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}
