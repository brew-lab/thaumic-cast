/**
 * Start Level
 *
 * The level a cast starts each speaker at. Before Cast the popup only keeps a
 * pending value; nothing reaches a speaker until Cast, when the companion
 * applies the rule in `plannedStartLevel` (protocol) to every room.
 *
 * Responsibilities:
 * - Turn the settings and the popup's hand-set levels into START_PLAYBACK's
 *   `startVolume`
 * - Decide what a speaker row shows before Cast
 *
 * Non-responsibilities:
 * - Setting any volume (the companion does that, at Cast)
 */

import type { StartVolume } from '@thaumic-cast/protocol';
import { plannedStartLevel } from '@thaumic-cast/protocol';
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
 * Picks the hand-set start levels of the speakers a cast starts on.
 * @param speakerIps - The speakers the cast starts on
 * @param pending - Levels set by hand, keyed by speaker IP
 * @returns The levels of those speakers only
 */
export function pendingStartsFor(
  speakerIps: readonly string[],
  pending: Readonly<Record<string, number>>,
): Record<string, number> {
  const levels: Record<string, number> = {};
  for (const ip of speakerIps) {
    const level = pending[ip];
    if (level !== undefined) levels[ip] = level;
  }
  return levels;
}

/** The limits the options page offers, besides none. */
export const START_CEILING_CHOICES: readonly number[] = Array.from(
  { length: 20 },
  (_, i) => (i + 1) * 5,
);

/**
 * The limits to offer, with the stored one included even when it is not one
 * of the usual choices, so the control always shows what is in force.
 * @param current - The stored limit
 * @returns The choices, in ascending order
 */
export function startCeilingChoices(current: number): number[] {
  return START_CEILING_CHOICES.includes(current)
    ? [...START_CEILING_CHOICES]
    : [...START_CEILING_CHOICES, current].sort((a, b) => a - b);
}

/**
 * Builds the `startVolume` a new cast sends with START_PLAYBACK.
 * @param settings - The extension settings
 * @param speakerIps - The speakers the cast starts on
 * @param startLevels - Levels set by hand in the popup, keyed by speaker IP
 * @returns The start volume, or undefined when there is nothing to change
 */
export function buildStartVolume(
  settings: StartLimitSettings,
  speakerIps: readonly string[],
  startLevels: Readonly<Record<string, number>> = {},
): StartVolume | undefined {
  const limit = startLimitOf(settings);
  const speakers = pendingStartsFor(speakerIps, startLevels);
  const hasHandSet = Object.keys(speakers).length > 0;
  if (limit === undefined && !hasHandSet) return undefined;
  return {
    ...(limit !== undefined && { limit }),
    ...(hasHandSet && { speakers }),
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

/** What a speaker row shows before Cast. */
export type StartLevelView =
  /** Line-level output: the amplifier sets the level, so there is no slider. */
  | { kind: 'fixed' }
  /** The speaker has not reported its level yet. */
  | { kind: 'unknown'; limit: number | undefined }
  /** The level the cast will start at, and the room's level now if known. */
  | { kind: 'known'; now: number | undefined; start: number };

/** Inputs for {@link startLevelView}. */
export interface StartLevelInput {
  /** The room's level now, or undefined before the speaker reports it. */
  current: number | undefined;
  /** Whether the output is fixed (line level). */
  fixed: boolean;
  /** The start limit, or undefined when it is off. */
  limit: number | undefined;
  /** A level set by hand before Cast, if any. */
  pending: number | undefined;
}

/**
 * Works out what a speaker row shows before Cast.
 * @param input - The room's level, fixed flag, limit and hand-set level
 * @param input.current - The room's level now, or undefined before it reports
 * @param input.fixed - Whether the output is fixed (line level)
 * @param input.limit - The start limit, or undefined when it is off
 * @param input.pending - A level set by hand before Cast, if any
 * @returns The view for the row
 */
export function startLevelView({
  current,
  fixed,
  limit,
  pending,
}: StartLevelInput): StartLevelView {
  if (fixed) return { kind: 'fixed' };
  const start = plannedStartLevel(current, limit, pending);
  if (start === undefined) return { kind: 'unknown', limit };
  return { kind: 'known', now: current, start };
}

/** A message key and its values, for the line under a speaker row. */
export interface StartLevelCaption {
  key: 'start_level_caption' | 'start_level_unknown' | 'volume_fixed_hint';
  params: Record<string, number>;
}

/**
 * Picks the line under a speaker row before Cast, if it needs one.
 * @param view - The row's view
 * @returns The caption, or null when the start is simply the room's level
 */
export function startLevelCaption(view: StartLevelView): StartLevelCaption | null {
  if (view.kind === 'fixed') return { key: 'volume_fixed_hint', params: {} };
  if (view.kind === 'unknown') {
    return view.limit === undefined
      ? null
      : { key: 'start_level_unknown', params: { limit: view.limit } };
  }
  if (view.kind === 'known' && view.now !== undefined && view.now !== view.start) {
    return { key: 'start_level_caption', params: { now: view.now, start: view.start } };
  }
  return null;
}
