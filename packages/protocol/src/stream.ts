import { z } from 'zod';

import { EncoderConfigSchema } from './encoder.js';
import { TabMediaStateSchema } from './media.js';

/**
 * Track-level metadata for display on Sonos devices.
 */
export const StreamMetadataSchema = z.object({
  title: z.string().optional(),
  artist: z.string().optional(),
  /** Source name derived from tab URL (e.g., "YouTube", "Spotify") */
  source: z.string().optional(),
});
export type StreamMetadata = z.infer<typeof StreamMetadataSchema>;

/**
 * Configuration parameters for initializing an audio stream session.
 */
export const StreamConfigSchema = z.object({
  streamId: z.string().uuid(),
  tabId: z.number().int().positive(),
  groupId: z.string(),
  encoderConfig: EncoderConfigSchema,
});
export type StreamConfig = z.infer<typeof StreamConfigSchema>;

/**
 * Current runtime status of an active cast session.
 */
export const CastStatusSchema = z.object({
  isActive: z.boolean(),
  streamId: z.string().uuid().optional(),
  tabId: z.number().int().positive().optional(),
  groupId: z.string().optional(),
  groupName: z.string().optional(),
  coordinatorIp: z.string().optional(),
  encoderConfig: EncoderConfigSchema.optional(),
  startedAt: z.number().int().positive().optional(),
});
export type CastStatus = z.infer<typeof CastStatusSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Start Volume
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A volume level on the Sonos scale, 0 to 100.
 */
export const VolumeLevelSchema = z.number().int().min(0).max(100);
export type VolumeLevel = z.infer<typeof VolumeLevelSchema>;

/**
 * The level each room starts a cast at, sent on `START_PLAYBACK`.
 *
 * Before playing, the companion sets every room of every target: to the
 * room's own hand-set level when there is one (even above the limit),
 * otherwise down to `limit` when the room is louder, never up. A room whose
 * level cannot be read is set to `limit`; a fixed (line-level) output is never
 * set. With no `limit` and no hand-set levels nothing is touched, which is
 * also what an absent `startVolume` means.
 */
export const StartVolumeSchema = z.object({
  /** The highest level a room may start at; absent when the limit is off. */
  limit: VolumeLevelSchema.optional(),
  /** Levels set by hand before Cast, keyed by room id (the player UUID, `RINCON_…`). */
  rooms: z.record(z.string(), VolumeLevelSchema).optional(),
});
export type StartVolume = z.infer<typeof StartVolumeSchema>;

/**
 * Works out the level a room will start at, the same way the companion does.
 * @param current - The room's level now, or undefined when not known yet
 * @param limit - The start limit, or undefined when the limit is off
 * @param handSet - A level set by hand before Cast, if any
 * @returns The start level, or undefined when it cannot be known until Cast
 */
export function plannedStartLevel(
  current: number | undefined,
  limit: number | undefined,
  handSet?: number,
): number | undefined {
  if (handSet !== undefined) return handSet;
  if (current === undefined) return undefined;
  return limit === undefined ? current : Math.min(current, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-Group Playback Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of starting playback on a single speaker.
 * Used for reporting per-speaker success/failure in multi-group casting.
 */
export const PlaybackResultSchema = z.object({
  /** IP address of the speaker */
  speakerIp: z.string(),
  /** Whether playback started successfully */
  success: z.boolean(),
  /** Stream URL the speaker is fetching (on success) */
  streamUrl: z.string().optional(),
  /** Error message (on failure) */
  error: z.string().optional(),
});
export type PlaybackResult = z.infer<typeof PlaybackResultSchema>;

/**
 * An active cast session with its current state.
 * Used for displaying in the popup's active casts list.
 * Supports multi-group casting (one stream to multiple speaker groups).
 */
export const ActiveCastSchema = z.object({
  /** Unique stream ID from server */
  streamId: z.string(),
  /** Tab ID being captured */
  tabId: z.number().int().positive(),
  /** Current media state (includes metadata) */
  mediaState: TabMediaStateSchema,
  /** Target speaker IP addresses (multi-group support) */
  speakerIps: z.array(z.string()),
  /** Speaker/group display names (parallel array with speakerIps) */
  speakerNames: z.array(z.string()),
  /**
   * The rooms the user chose (player UUIDs), in order. `speakerIps` are the
   * targets they play through; a target can carry rooms that were not chosen
   * (grouped partners). Empty for a cast started before rooms.
   */
  roomIds: z.array(z.string()).default([]),
  /** Encoder configuration used for this cast */
  encoderConfig: EncoderConfigSchema,
  /** Timestamp when cast started */
  startedAt: z.number(),
  /** Whether synchronized multi-speaker playback is active */
  syncSpeakers: z.boolean().default(false),
  /**
   * Whether the cast was started with video sync on. The companion decides at
   * the start of playback whether to measure for it, so the setting as it
   * stands now says nothing about a cast already running.
   */
  videoSync: z.boolean().default(false),
  /**
   * What the cast captures: one tab, or the whole browser (browser-wide
   * capture). The popup names a browser-wide cast "Whole browser".
   */
  captureMode: z.enum(['tab', 'browser']).default('tab'),
});
export type ActiveCast = z.infer<typeof ActiveCastSchema>;
