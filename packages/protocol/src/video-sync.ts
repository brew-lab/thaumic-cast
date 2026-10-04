import { z } from 'zod';

import { PlayoutSourceSchema } from './events.js';

// ─────────────────────────────────────────────────────────────────────────────
// Video Sync Types (for A/V delay compensation)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single latency sample for the stability gate.
 */
export interface LatencySample {
  latencyMs: number;
  jitterMs: number;
  confidence: number;
  /** Timestamp when sample was received (performance.now()) */
  tMs: number;
}

/**
 * Rolling window of latency samples for stability detection.
 */
export interface SampleWindow {
  buf: LatencySample[];
  /** Maximum samples to keep */
  max: number;
}

/**
 * Video sync state machine states.
 *
 * State transitions:
 * - NoData → Acquiring (on first Updated event)
 * - Acquiring → Locked (when stability gate passes)
 * - Locked → Stale (on Stale event)
 * - Stale → Acquiring (on Updated event, same or different epoch)
 * - Any → Acquiring (on epoch change)
 */
export type VideoSyncState =
  | { kind: 'NoData' }
  | {
      kind: 'Acquiring';
      epochId: number;
      samples: SampleWindow;
    }
  | {
      kind: 'Locked';
      epochId: number;
      /** Rolling sample window for windowed median (slew target) */
      samples: SampleWindow;
      /** Locked latency value in ms (used for video delay) */
      lockedLatencyMs: number;
      /** User-adjustable trim in ms (positive = more delay) */
      userTrimMs: number;
      /** performance.now() when lock was established */
      lockNowMs: number;
      /** video.currentTime when lock was established */
      lockVideoTime: number;
      /** Control mode: 'rate' for playbackRate, 'pause' for micro-pauses */
      rateMode: 'rate' | 'pause';
    }
  | {
      kind: 'Stale';
      epochId: number;
      /** Last known latency (preserved for UI display) */
      lockedLatencyMs: number;
      /** User trim preserved across stale */
      userTrimMs: number;
      /** When stale was detected (performance.now()) */
      sinceMs: number;
    };

/**
 * Constants for the video sync stability gate.
 */
export const VIDEO_SYNC_CONSTANTS = {
  /** Minimum confidence required for each sample */
  MIN_CONFIDENCE: 0.7,
  /** Maximum jitter (ms) allowed for each sample */
  MAX_JITTER_MS: 120,
  /** Maximum deviation from median (ms) for stability */
  MAX_MEDIAN_DEVIATION_MS: 80,
  /** Number of samples required to pass stability gate */
  REQUIRED_SAMPLES: 5,
  /** Deadband for locked state - ignore changes smaller than this */
  LOCK_DEADBAND_MS: 80,
  /** Maximum slew rate when adjusting locked latency (ms per second) */
  SLEW_RATE_MS_PER_SEC: 20,
  /** Deadband for video sync error (seconds) */
  ERROR_DEADBAND_SEC: 0.12,
  /** Hard error threshold for seek/pause (seconds) */
  HARD_ERROR_THRESHOLD_SEC: 1.0,
  /** Maximum micro-pause duration (ms) */
  MAX_MICRO_PAUSE_MS: 250,
  /** Maximum playback rate adjustment (±5%) */
  MAX_RATE_ADJUSTMENT: 0.05,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Video Sync Status (for popup display)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where video sync stands for one cast.
 *
 * - `off`: switched off for this cast.
 * - `locking`: working out how late the speaker plays, or moving the sound;
 *   a lead may already be in force.
 * - `in-step`: the speaker's delay is measured and the page plays its sound
 *   that much early.
 * - `unavailable`: this page or cast cannot be synced (see the reason).
 * - `turned-off`: the page's player turned the lead off after trouble (see
 *   the reason) until asked to try again.
 */
export const VideoSyncPhaseSchema = z.enum([
  'off',
  'locking',
  'in-step',
  'unavailable',
  'turned-off',
]);
export type VideoSyncPhase = z.infer<typeof VideoSyncPhaseSchema>;

/**
 * Why video sync is unavailable or turned off.
 *
 * - `muxed`: the player keeps sound and picture in one stream.
 * - `worker`: the player runs its media in a worker the extension cannot reach.
 * - `no-mse`: the playing element does not use Media Source Extensions.
 * - `format`: the player's audio format cannot be shifted.
 * - `pcm-only`: the cast is not PCM, the only codec whose delay is measured.
 * - `companion-old`: the companion sends no playout estimate.
 * - `browser-capture`: the cast captures the whole browser, not this tab.
 * - `reload`: the page was open before video sync was on.
 * - `no-access`: Chrome has not let video sync onto websites.
 * - `freeze`: the video stuck after the sound moved, so it moved back.
 * - `live-edge`: the broadcast is too near live to play the sound early.
 */
export const VideoSyncReasonSchema = z.enum([
  'muxed',
  'worker',
  'no-mse',
  'format',
  'pcm-only',
  'companion-old',
  'browser-capture',
  'reload',
  'no-access',
  'freeze',
  'live-edge',
]);
export type VideoSyncReason = z.infer<typeof VideoSyncReasonSchema>;

/**
 * Video sync status for popup display: the per-cast state the background's
 * lead controller keeps for one tab.
 */
export const VideoSyncStatusSchema = z.object({
  /** Whether video sync is switched on for this cast */
  enabled: z.boolean(),
  /** Where it stands */
  state: VideoSyncPhaseSchema,
  /** Why, when `state` is `unavailable` or `turned-off` */
  reason: VideoSyncReasonSchema.optional(),
  /** The speaker whose delay is followed (the cast's first) */
  speakerIp: z.string().optional(),
  /** That speaker's display name */
  speakerName: z.string().optional(),
  /** The user's trim for that speaker, in ms (positive plays the sound earlier) */
  trimMs: z.number().int(),
  /** The lead sent to the page, in ms of wall time, once one has been */
  leadMs: z.number().int().nonnegative().optional(),
  /** Where the companion's estimate of the speaker's delay came from */
  source: PlayoutSourceSchema.optional(),
});
export type VideoSyncStatus = z.infer<typeof VideoSyncStatusSchema>;
