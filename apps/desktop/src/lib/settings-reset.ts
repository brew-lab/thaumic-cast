import type {
  DriftCompensationSetting,
  DriftMode,
  HeadStartSetting,
  SpeakerMonitorSetting,
} from '../state/store';
import type { ThemeMode } from './theme';

/**
 * The speaker settings' defaults, as `get_speaker_setting_defaults` returns them (the core's
 * own defaults, which the settings file falls back to).
 */
export interface SpeakerSettingDefaults {
  /** Speaker monitoring. */
  speakerMonitor: boolean;
  /** The speaker head start, in ms (0 is off). */
  pcmConnectBurstMs: number;
  /** Clock drift correction. */
  driftCompensation: DriftMode;
}

/** Launch at login is off until the user turns it on (the OS starts with no login item). */
export const AUTOSTART_DEFAULT = false;

/** The theme follows the system until the user picks one. */
export const THEME_DEFAULT: ThemeMode = 'auto';

/** Show diagnostics is off until the user turns it on. */
export const DIAGNOSTICS_DEFAULT = false;

/**
 * The settings a reset puts back, as the Settings view holds them. Not here, so a reset never
 * touches them: the server's address and ports, the speakers added by IP address (removing one
 * would drop its speaker) and the language, which has no choice while there is one language and
 * is not saved.
 */
export interface ResettableSettings {
  /** Launch at login, from the OS. */
  autostart: boolean;
  /** The window's theme. */
  theme: ThemeMode;
  /** Show diagnostics. */
  diagnostics: boolean;
  /** Speaker monitoring, as the core holds it. */
  speakerMonitor: SpeakerMonitorSetting;
  /** The speaker head start, as the core holds it. */
  headStart: HeadStartSetting;
  /** Clock drift correction, as the core holds it. */
  drift: DriftCompensationSetting;
}

/**
 * How a reset saves each setting: the same calls a change by hand makes, so each applies
 * as it would then (the theme at once, launch at login through the OS, the speaker settings
 * from each speaker's next connection).
 */
export interface ResetActions {
  /** Turns launch at login on or off. */
  setAutostart: (enabled: boolean) => Promise<void>;
  /** Applies and saves the theme. */
  setTheme: (theme: ThemeMode) => void;
  /** Saves Show diagnostics. */
  setDiagnostics: (on: boolean) => void;
  /** Saves speaker monitoring. */
  setSpeakerMonitor: (enabled: boolean) => Promise<SpeakerMonitorSetting>;
  /** Saves the head start. */
  setHeadStart: (ms: number) => Promise<HeadStartSetting>;
  /** Saves drift correction. */
  setDrift: (mode: DriftMode) => Promise<DriftCompensationSetting>;
}

/**
 * Whether a reset would change anything. A setting an environment variable fixes is left out:
 * the view cannot change it, and neither does a reset.
 * @param current - The settings as they are
 * @param defaults - The speaker settings' defaults
 * @returns True when every setting a reset could change is at its default
 */
export function isAtDefaults(
  current: ResettableSettings,
  defaults: SpeakerSettingDefaults,
): boolean {
  const { speakerMonitor, headStart, drift } = current;
  return (
    current.autostart === AUTOSTART_DEFAULT &&
    current.theme === THEME_DEFAULT &&
    current.diagnostics === DIAGNOSTICS_DEFAULT &&
    (speakerMonitor.envOverride !== null || speakerMonitor.enabled === defaults.speakerMonitor) &&
    (headStart.envOverride !== null || headStart.ms === defaults.pcmConnectBurstMs) &&
    (drift.envOverride !== null || drift.mode === defaults.driftCompensation)
  );
}

/**
 * Puts every setting back to its default through `actions`, skipping those already there and
 * those an environment variable fixes. Every setting is tried, even after one fails; the first
 * failure is thrown once all have been tried.
 * @param current - The settings as they are
 * @param defaults - The speaker settings' defaults
 * @param actions - How each setting is saved
 * @returns The settings as saved
 * @throws The first failure, after every setting has been tried
 */
export async function resetSettings(
  current: ResettableSettings,
  defaults: SpeakerSettingDefaults,
  actions: ResetActions,
): Promise<ResettableSettings> {
  const next: ResettableSettings = { ...current };
  let failure: unknown = null;
  const attempt = async (step: () => Promise<void> | void): Promise<void> => {
    try {
      await step();
    } catch (error) {
      failure ??= error;
    }
  };

  if (current.theme !== THEME_DEFAULT) {
    await attempt(() => {
      actions.setTheme(THEME_DEFAULT);
      next.theme = THEME_DEFAULT;
    });
  }
  if (current.diagnostics !== DIAGNOSTICS_DEFAULT) {
    await attempt(() => {
      actions.setDiagnostics(DIAGNOSTICS_DEFAULT);
      next.diagnostics = DIAGNOSTICS_DEFAULT;
    });
  }
  if (current.autostart !== AUTOSTART_DEFAULT) {
    await attempt(async () => {
      await actions.setAutostart(AUTOSTART_DEFAULT);
      next.autostart = AUTOSTART_DEFAULT;
    });
  }
  const { speakerMonitor, headStart, drift } = current;
  if (speakerMonitor.envOverride === null && speakerMonitor.enabled !== defaults.speakerMonitor) {
    await attempt(async () => {
      next.speakerMonitor = await actions.setSpeakerMonitor(defaults.speakerMonitor);
    });
  }
  if (headStart.envOverride === null && headStart.ms !== defaults.pcmConnectBurstMs) {
    await attempt(async () => {
      next.headStart = await actions.setHeadStart(defaults.pcmConnectBurstMs);
    });
  }
  if (drift.envOverride === null && drift.mode !== defaults.driftCompensation) {
    await attempt(async () => {
      next.drift = await actions.setDrift(defaults.driftCompensation);
    });
  }

  if (failure !== null) throw failure;
  return next;
}
