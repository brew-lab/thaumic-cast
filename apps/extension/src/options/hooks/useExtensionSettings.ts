import { useState, useEffect, useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { createLogger } from '@thaumic-cast/shared';
import {
  loadExtensionSettings,
  saveExtensionSettings,
  type ExtensionSettings,
  getDefaultExtensionSettings,
} from '../../lib/settings';
import { useMountedRef } from '../../popup/hooks/useMountedRef';
import { useStorageListener } from '../../popup/hooks/useStorageListener';

const log = createLogger('ExtensionSettings');

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
        let loaded = await loadExtensionSettings();

        // Normalize UI state on initial load only: if manual mode has no URL,
        // show auto-discover (reflects actual backend fallback behavior).
        // Not applied during editing or via storage listener.
        if (!loaded.useAutoDiscover && !loaded.serverUrl) {
          loaded = { ...loaded, useAutoDiscover: true };
        }

        if (mountedRef.current) {
          setSettings(loaded);
          setLoading(false);
        }
      } catch (err) {
        log.error('Failed to load settings:', err);
        if (mountedRef.current) {
          setError(t('error_load_settings'));
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
        // saveExtensionSettings returns the fully merged and Zod-validated settings
        const saved = await saveExtensionSettings(partial);
        setSettings(saved);
      } catch (err) {
        log.error('Failed to save settings:', err);
        setError(t('error_save_settings'));
        throw err;
      }
    },
    [t],
  );

  return { settings, updateSettings, loading, error };
}
