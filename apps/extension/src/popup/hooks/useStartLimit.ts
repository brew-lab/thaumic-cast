import { useEffect, useState } from 'preact/hooks';
import {
  getDefaultExtensionSettings,
  loadExtensionSettings,
  parseStoredExtensionSettings,
} from '../../lib/settings';
import { startLimitOf } from '../../lib/start-level';
import { noop } from '../../lib/noop';
import { useMountedRef } from './useMountedRef';
import { useStorageListener } from './useStorageListener';

/**
 * The start limit ("Start no louder than") from the settings, kept up to date
 * when the options page changes it.
 * @returns The limit, or undefined when the user turned it off
 */
export function useStartLimit(): number | undefined {
  const [limit, setLimit] = useState<number | undefined>(() =>
    startLimitOf(getDefaultExtensionSettings()),
  );
  const mountedRef = useMountedRef();

  useEffect(() => {
    loadExtensionSettings()
      .then((settings) => {
        if (mountedRef.current) setLimit(startLimitOf(settings));
      })
      .catch(noop);
  }, []);

  useStorageListener<unknown>('extensionSettings', (stored) => {
    const settings = parseStoredExtensionSettings(stored);
    if (settings) setLimit(startLimitOf(settings));
  });

  return limit;
}
