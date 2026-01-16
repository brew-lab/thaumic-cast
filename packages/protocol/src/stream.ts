import { z } from 'zod';

import { EncoderConfigSchema } from './encoder.js';
import { TabMediaStateSchema } from './media.js';

/**
 * Track-level metadata for display on Sonos devices.
 */
export const StreamMetadataSchema = z.object({
  title: z.string().optional(),
  artist: z.string().optional(),
  album: z.string().optional(),
  artwork: z.string().optional(),
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
  /** Encoder configuration used for this cast */
  encoderConfig: EncoderConfigSchema,
  /** Timestamp when cast started */
  startedAt: z.number(),
});
export type ActiveCast = z.infer<typeof ActiveCastSchema>;
