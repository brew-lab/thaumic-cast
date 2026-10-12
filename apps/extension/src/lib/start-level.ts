/**
 * Start Level
 *
 * The level a cast starts each speaker at. Before Cast the popup only keeps a
 * pending value; nothing reaches a speaker until Cast, when the companion
 * applies the rule in `plannedStartLevel` (protocol) to every room. What a
 * row shows before Cast is StartLevel's own rule (`@thaumic-cast/ui`).
 *
 * Responsibilities:
 * - Turn the settings and the popup's hand-set levels into START_PLAYBACK's
 *   `startVolume`
 *
 * Non-responsibilities:
 * - Setting any volume (the companion does that, at Cast)
 */

import type { StartVolume } from '@thaumic-cast/protocol';
import type { ExtensionSettings } from './settings';

/** The settings the start level reads. */
export type StartLimitSettings = Pick<ExtensionSettings, 'startCeilingEnabled' | 'startCeiling'>;

/**
 * Reads the start limit from the settings.
 * @param settings - The extension settings
 * @returns The limit, or undefined when the user turned it off
 */
export function startLimitOf(settings: StartLimitSettings): number | undefined {
  return settings.startCeilingEnabled ? settings.startCeiling : undefined;
}

/**
 * Picks the hand-set start levels of the rooms (or speakers) a cast starts on.
 * @param keys - The rooms the cast starts on
 * @param pending - Levels set by hand, keyed the same way
 * @returns The levels of those rooms only
 */
export function pendingStartsFor(
  keys: readonly string[],
  pending: Readonly<Record<string, number>>,
): Record<string, number> {
  const levels: Record<string, number> = {};
  for (const key of keys) {
    const level = pending[key];
    if (level !== undefined) levels[key] = level;
  }
  return levels;
}

/**
 * Builds the `startVolume` a new cast sends with START_PLAYBACK.
 * @param settings - The extension settings
 * @param roomIds - The rooms the cast starts on (player UUIDs)
 * @param startLevels - Levels set by hand in the popup, keyed by room id
 * @returns The start volume, or undefined when there is nothing to change
 */
export function buildStartVolume(
  settings: StartLimitSettings,
  roomIds: readonly string[],
  startLevels: Readonly<Record<string, number>> = {},
): StartVolume | undefined {
  const limit = startLimitOf(settings);
  const rooms = pendingStartsFor(roomIds, startLevels);
  const hasHandSet = Object.keys(rooms).length > 0;
  if (limit === undefined && !hasHandSet) return undefined;
  return {
    ...(limit !== undefined && { limit }),
    ...(hasHandSet && { rooms }),
  };
}

/**
 * Records a start level set by hand before Cast. It stays in the popup: the
 * speaker is not touched until Cast.
 * @param pending - The levels set so far, keyed by speaker IP
 * @param speakerIp - The speaker the level is for
 * @param level - The level, 0 to 100
 * @returns The levels with this one added or replaced
 */
export function withPendingStart(
  pending: Readonly<Record<string, number>>,
  speakerIp: string,
  level: number,
): Record<string, number> {
  return { ...pending, [speakerIp]: level };
}
