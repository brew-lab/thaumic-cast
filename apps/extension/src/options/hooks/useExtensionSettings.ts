import { useState, useEffect, useCallback } from 'preact/hooks';
import {
  loadExtensionSettings,
  saveExtensionSettings,
  type ExtensionSettings,
  getDefaultExtensionSettings,
} from '../../lib/settings';

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
  const [settings, setSettings] = useState<ExtensionSettings>(getDefaultExtensionSettings());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load settings on mount
  useEffect(() => {
    let mounted = true;

    /** Loads settings from storage. */
    async function load() {
      try {
        const loaded = await loadExtensionSettings();
        if (mounted) {
          setSettings(loaded);
          setLoading(false);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to load settings');
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      mounted = false;
    };
  }, []);

  // Listen for storage changes from other contexts
  useEffect(() => {
    const handler = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes['extensionSettings']?.newValue) {
        setSettings(changes['extensionSettings'].newValue);
      }
    };

    chrome.storage.sync.onChanged.addListener(handler);
    return () => chrome.storage.sync.onChanged.removeListener(handler);
  }, []);

  const updateSettings = useCallback(async (partial: Partial<ExtensionSettings>) => {
    try {
      setError(null);
      await saveExtensionSettings(partial);
      setSettings((prev) => ({ ...prev, ...partial }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
      throw err;
    }
  }, []);

  return { settings, updateSettings, loading, error };
}
