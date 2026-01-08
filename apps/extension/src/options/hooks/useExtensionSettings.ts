import { useState, useEffect, useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  loadExtensionSettings,
  saveExtensionSettings,
  type ExtensionSettings,
  getDefaultExtensionSettings,
} from '../../lib/settings';
import { useMountedRef } from '../../popup/hooks/useMountedRef';
import { useStorageListener } from '../../popup/hooks/useStorageListener';

/**
 * Hook for loading and updating extension settings.
 * @returns Settings state and update function
 */
export function useExtensionSettings(): {
  settings: ExtensionSettings;
  updateSettings: (partial: Partial<ExtensionSettings>) => Promise<void>;
  loading: boolean;
  error: string | null;
} {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<ExtensionSettings>(getDefaultExtensionSettings());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useMountedRef();

  // Load settings on mount
  useEffect(() => {
    /** Loads settings from storage. */
    async function load() {
      try {
        const loaded = await loadExtensionSettings();
        if (mountedRef.current) {
          setSettings(loaded);
          setLoading(false);
        }
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : t('error_load_settings'));
          setLoading(false);
        }
      }
    }

    load();
  }, []);

  // Listen for storage changes from other contexts
  useStorageListener<ExtensionSettings>('extensionSettings', setSettings);

  const updateSettings = useCallback(
    async (partial: Partial<ExtensionSettings>) => {
      try {
        setError(null);
        await saveExtensionSettings(partial);
        setSettings((prev) => ({ ...prev, ...partial }));
      } catch (err) {
        setError(err instanceof Error ? err.message : t('error_save_settings'));
        throw err;
      }
    },
    [t],
  );

  return { settings, updateSettings, loading, error };
}
