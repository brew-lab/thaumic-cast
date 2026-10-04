/**
 * The user's video sync trim for each speaker, kept in chrome.storage.local.
 *
 * The trim corrects what the lead cannot measure, chiefly the speaker's own
 * output delay, which differs by model and setup. It belongs to the speaker,
 * not the cast, so it is keyed by the speaker's UUID from the cached zone
 * groups, or by its IP address when the UUID is not known. A per-companion
 * store may replace this later, so other clients share the trims.
 */

import { z } from 'zod';
import type { ZoneGroup } from '@thaumic-cast/protocol';

/** Storage key of the trims. */
export const VIDEO_SYNC_TRIM_STORAGE_KEY = 'videoSyncTrimBySpeaker';

/** Smallest trim, in ms. */
export const VIDEO_SYNC_TRIM_MIN_MS = -500;

/** Largest trim, in ms. */
export const VIDEO_SYNC_TRIM_MAX_MS = 500;

/** Trim step, in ms. */
export const VIDEO_SYNC_TRIM_STEP_MS = 10;

/** One stored trim. */
export const VideoSyncTrimSchema = z
  .number()
  .int()
  .min(VIDEO_SYNC_TRIM_MIN_MS)
  .max(VIDEO_SYNC_TRIM_MAX_MS);

/** The stored trims, speaker key to ms. */
export const VideoSyncTrimMapSchema = z.record(z.string(), VideoSyncTrimSchema);
/** The stored trims, speaker key (UUID, or IP address) to ms. */
export type VideoSyncTrimMap = z.infer<typeof VideoSyncTrimMapSchema>;

/**
 * Brings a trim into range and onto the step.
 * @param ms - Any number
 * @returns The trim, in ms
 */
export function clampTrim(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  const stepped = Math.round(ms / VIDEO_SYNC_TRIM_STEP_MS) * VIDEO_SYNC_TRIM_STEP_MS;
  return Math.min(VIDEO_SYNC_TRIM_MAX_MS, Math.max(VIDEO_SYNC_TRIM_MIN_MS, stepped)) || 0;
}

/**
 * Finds a speaker's UUID in the zone groups.
 * @param speakerIp - The speaker's address
 * @param groups - The cached zone groups
 * @returns The UUID, or undefined when the speaker is not listed
 */
export function speakerUuid(speakerIp: string, groups: readonly ZoneGroup[]): string | undefined {
  for (const group of groups) {
    const member = group.members.find((m) => m.ip === speakerIp);
    if (member) return member.uuid;
    if (group.coordinatorIp === speakerIp) return group.coordinatorUuid;
  }
  return undefined;
}

/**
 * Reads the stored trims, keeping only the valid entries.
 * @returns The trims
 */
async function readTrims(): Promise<VideoSyncTrimMap> {
  const stored = (await chrome.storage.local.get(VIDEO_SYNC_TRIM_STORAGE_KEY))[
    VIDEO_SYNC_TRIM_STORAGE_KEY
  ];
  const whole = VideoSyncTrimMapSchema.safeParse(stored);
  if (whole.success) return whole.data;
  const out: VideoSyncTrimMap = {};
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
      const parsed = VideoSyncTrimSchema.safeParse(value);
      if (parsed.success) out[key] = parsed.data;
    }
  }
  return out;
}

/**
 * Loads a speaker's trim. A trim kept under the address is the newer one
 * whenever the UUID is known too (saving under the UUID drops the address
 * entry), so it wins and moves to the UUID.
 * @param speakerIp - The speaker's address
 * @param groups - The cached zone groups, to find its UUID
 * @returns The trim, in ms (0 when none is stored)
 */
export async function loadSpeakerTrim(
  speakerIp: string,
  groups: readonly ZoneGroup[],
): Promise<number> {
  try {
    const trims = await readTrims();
    const uuid = speakerUuid(speakerIp, groups);
    const byIp = trims[speakerIp];
    if (uuid === undefined) return byIp ?? 0;
    if (byIp === undefined) return trims[uuid] ?? 0;
    trims[uuid] = byIp;
    delete trims[speakerIp];
    try {
      await chrome.storage.local.set({ [VIDEO_SYNC_TRIM_STORAGE_KEY]: trims });
    } catch {
      // Moved next time instead.
    }
    return byIp;
  } catch {
    return 0;
  }
}

/**
 * Saves a speaker's trim, under its UUID when known (dropping any entry kept
 * under its address) or else its address.
 * @param speakerIp - The speaker's address
 * @param groups - The cached zone groups, to find its UUID
 * @param trimMs - The trim, in ms (clamped)
 * @returns The trim stored
 */
export async function saveSpeakerTrim(
  speakerIp: string,
  groups: readonly ZoneGroup[],
  trimMs: number,
): Promise<number> {
  const trim = clampTrim(trimMs);
  const trims = await readTrims();
  const uuid = speakerUuid(speakerIp, groups);
  if (uuid !== undefined) {
    trims[uuid] = trim;
    delete trims[speakerIp];
  } else {
    trims[speakerIp] = trim;
  }
  await chrome.storage.local.set({ [VIDEO_SYNC_TRIM_STORAGE_KEY]: trims });
  return trim;
}
