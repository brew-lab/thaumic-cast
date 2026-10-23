import { getDefaultExtensionSettings, type ExtensionSettings } from './settings';

/**
 * What a reset leaves as it is. The connection (the companion's address and whether it is
 * found by itself), so a reset never disconnects; and the bookkeeping that is not a setting
 * (the audio settings' layout version and the smoothing migration's one-time line, which a
 * reset neither shows again nor hides).
 */
export const KEPT_ON_RESET = [
  'serverUrl',
  'useAutoDiscover',
  'audioSettingsVersion',
  'smoothingMigrationNotice',
] as const satisfies readonly (keyof ExtensionSettings)[];

/** The settings a reset puts back to their defaults. */
export type ResettableSettings = Omit<ExtensionSettings, (typeof KEPT_ON_RESET)[number]>;

/**
 * Every setting a reset puts back, at its default.
 * @returns The defaults, without the connection and the bookkeeping
 */
export function resetValues(): ResettableSettings {
  const defaults = getDefaultExtensionSettings();
  const values: Partial<ExtensionSettings> = {
    ...defaults,
    customAudioSettings: { ...defaults.customAudioSettings },
  };
  for (const key of KEPT_ON_RESET) delete values[key];
  return values as ResettableSettings;
}

/**
 * Whether two setting values are the same: equal, or objects with the same keys and values.
 * @param a - One value
 * @param b - The other
 * @returns True when they are the same
 */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

/**
 * Whether a reset would change anything.
 * @param settings - The settings as they are
 * @returns True when every setting a reset puts back is at its default
 */
export function isAtDefaults(settings: ExtensionSettings): boolean {
  return Object.entries(resetValues()).every(([key, value]) =>
    same(settings[key as keyof ExtensionSettings], value),
  );
}
