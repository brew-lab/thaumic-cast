/**
 * Speaker Monitor Override Line
 *
 * The speaker-monitor checkbox is locked while an environment variable fixes
 * it, and the line under it names the variable. Two variables can: the
 * setting's own, THAUMIC_SPEAKER_MONITOR, and the older
 * THAUMIC_SPEAKER_DIAGNOSTICS, which only ever turns it on. The backend
 * reads both once, when the app starts. Pure, so the rule is testable
 * without Tauri.
 */

import type { SpeakerMonitorSetting } from '../state/store';

/**
 * The i18n key of the line that says an environment variable fixes the
 * speaker-monitor setting.
 * @param setting - The speaker-monitor setting, or null while it loads
 * @returns The key, or null when no variable fixes it
 */
export function speakerMonitorOverrideKey(setting: SpeakerMonitorSetting | null): string | null {
  if (setting === null || setting.envOverride === null) return null;
  if (setting.origin === 'legacyEnv') return 'settings.speaker_monitor_legacy_env';
  return setting.envOverride
    ? 'settings.speaker_monitor_env_on'
    : 'settings.speaker_monitor_env_off';
}
