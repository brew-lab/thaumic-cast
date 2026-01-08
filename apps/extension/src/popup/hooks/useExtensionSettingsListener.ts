/**
 * Extension Settings Listener Hook
 *
 * Loads extension settings and subscribes to real-time changes.
 * Automatically updates when settings are modified in the options page.
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import { loadExtensionSettings, type ExtensionSettings } from '../../lib/settings';
import { noop } from '../../lib/noop';
import { useStorageListener } from './useStorageListener';

/**
 * Settings values returned by the hook.
 */
interface ExtensionSettingsState {
  /** Whether video sync is enabled globally. */
  videoSyncEnabled: boolean;
}

/**
 * Hook that loads extension settings and subscribes to changes.
 * @returns Current extension settings values
 */
export function useExtensionSettingsListener(): ExtensionSettingsState {
  const [videoSyncEnabled, setVideoSyncEnabled] = useState(false);

  // Load initial settings
  useEffect(() => {
    loadExtensionSettings()
      .then((settings) => setVideoSyncEnabled(settings.videoSyncEnabled))
      .catch(noop);
  }, []);

  // Listen for settings changes from options page
  const handleSettingsChange = useCallback((newSettings: ExtensionSettings) => {
    if (newSettings?.videoSyncEnabled !== undefined) {
      setVideoSyncEnabled(newSettings.videoSyncEnabled);
    }
  }, []);

  useStorageListener('extensionSettings', handleSettingsChange);

  return { videoSyncEnabled };
}
