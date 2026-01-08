/**
 * Extension Settings Listener Hook
 *
 * Loads extension settings and subscribes to real-time changes.
 * Automatically updates when settings are modified in the options page.
 */

import { useState, useEffect } from 'preact/hooks';
import { loadExtensionSettings } from '../../lib/settings';
import { noop } from '../../lib/noop';

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

  useEffect(() => {
    // Load initial settings
    loadExtensionSettings()
      .then((settings) => setVideoSyncEnabled(settings.videoSyncEnabled))
      .catch(noop);

    // Listen for settings changes from options page
    const handler = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      const newSettings = changes['extensionSettings']?.newValue;
      if (newSettings?.videoSyncEnabled !== undefined) {
        setVideoSyncEnabled(newSettings.videoSyncEnabled);
      }
    };

    chrome.storage.sync.onChanged.addListener(handler);
    return () => chrome.storage.sync.onChanged.removeListener(handler);
  }, []);

  return { videoSyncEnabled };
}
