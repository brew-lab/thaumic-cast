/**
 * Clock Drift Correction Toggle
 *
 * The settings view offers clock drift correction as a plain on/off toggle
 * over the core's three modes: on is `on`, and off saves `observe`, which
 * leaves the audio exactly as captured while the log keeps saying what
 * correction would do. `off` itself can only come from the settings file or
 * THAUMIC_DRIFT_COMPENSATION. Correction steers by the speaker monitor, so
 * the toggle is disabled while the monitor is off. Pure, so the rules are
 * testable without Tauri.
 */

import type { DriftCompensationSetting, DriftMode } from '../state/store';

/** What the drift toggle shows. */
export interface DriftToggleState {
  /** Whether the checkbox is ticked: correction is on in effect. */
  checked: boolean;
  /** Whether the checkbox cannot be changed. */
  disabled: boolean;
  /** Why it is disabled, as an i18n key with its values; null when it is not. */
  hint: { key: string; params?: Record<string, string> } | null;
}

/** The i18n key naming each mode in the environment notice. */
const MODE_LABEL_KEYS: Record<DriftMode, string> = {
  on: 'settings.drift_label_on',
  observe: 'settings.drift_label_observe',
  off: 'settings.drift_label_off',
};

/**
 * The i18n key naming a drift correction mode.
 * @param mode - The mode
 * @returns The key of its label
 */
export function driftModeLabelKey(mode: DriftMode): string {
  return MODE_LABEL_KEYS[mode];
}

/**
 * Works out what the drift toggle shows.
 * @param drift - The drift setting, or null while it loads
 * @param monitorOn - Whether the speaker monitor is on in effect, or null while it loads
 * @param translate - Turns an i18n key into its text, for the mode's label
 * @returns The toggle's state
 */
export function driftToggleState(
  drift: DriftCompensationSetting | null,
  monitorOn: boolean | null,
  translate: (key: string) => string,
): DriftToggleState {
  if (drift === null || monitorOn === null) return { checked: false, disabled: true, hint: null };
  if (drift.envOverride !== null) {
    return {
      checked: monitorOn && drift.envOverride === 'on',
      disabled: true,
      hint: {
        key: 'settings.drift_env',
        params: { label: translate(driftModeLabelKey(drift.envOverride)) },
      },
    };
  }
  if (!monitorOn) {
    return { checked: false, disabled: true, hint: { key: 'settings.drift_needs_monitor' } };
  }
  return { checked: drift.mode === 'on', disabled: false, hint: null };
}

/**
 * The mode the toggle saves.
 * @param checked - Whether the toggle was ticked
 * @returns `on`, or `observe` for off
 */
export function driftModeForToggle(checked: boolean): DriftMode {
  return checked ? 'on' : 'observe';
}

/**
 * Whether a drift notice should offer turning correction on: it is not on in
 * effect, and no environment variable fixes it.
 * @param drift - The drift setting, or null when unknown
 * @returns True when the user can turn correction on in Settings
 */
export function offersDriftCorrection(drift: DriftCompensationSetting | null): boolean {
  return drift !== null && drift.envOverride === null && drift.mode !== 'on';
}
