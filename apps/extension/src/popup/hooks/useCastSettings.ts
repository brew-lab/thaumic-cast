import { useEffect, useState } from 'preact/hooks';
import {
  getDefaultExtensionSettings,
  loadExtensionSettings,
  parseStoredExtensionSettings,
  type ExtensionSettings,
} from '../../lib/settings';
import { startLimitOf } from '../../lib/start-level';
import { noop } from '../../lib/noop';
import { useMountedRef } from './useMountedRef';
import { useStorageListener } from './useStorageListener';

/** The settings the popup's cast controls read. */
export interface CastSettings {
  /** "Start no louder than", or null when the user turned it off. */
  limit: number | null;
  /** Whether a cast captures one tab or the whole browser. */
  captureMode: ExtensionSettings['captureMode'];
}

/**
 * Picks what the popup reads from the settings.
 * @param settings - The extension settings
 * @returns The start limit and the capture mode
 */
function castSettingsOf(settings: ExtensionSettings): CastSettings {
  return { limit: startLimitOf(settings) ?? null, captureMode: settings.captureMode };
}

/**
 * The start limit and the capture mode from the settings, kept up to date
 * when the options page changes them.
 * @returns The settings
 */
export function useCastSettings(): CastSettings {
  const [settings, setSettings] = useState<CastSettings>(() =>
    castSettingsOf(getDefaultExtensionSettings()),
  );
  const mountedRef = useMountedRef();

  useEffect(() => {
    loadExtensionSettings()
      .then((loaded) => {
        if (mountedRef.current) setSettings(castSettingsOf(loaded));
      })
      .catch(noop);
  }, []);

  useStorageListener<unknown>('extensionSettings', (stored) => {
    const parsed = parseStoredExtensionSettings(stored);
    if (parsed) setSettings(castSettingsOf(parsed));
  });

  return settings;
}
