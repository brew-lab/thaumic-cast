import { z } from 'zod';

import { PlayoutSourceSchema } from './events.js';

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
 * - `no-video`: the page answered but nothing in it is playing through a
 *   player video sync can work with yet.
 * - `unavailable`: this page or cast cannot be synced (see the reason).
 * - `turned-off`: the page's player turned the lead off after trouble (see
 *   the reason) until asked to try again.
 */
export const VideoSyncPhaseSchema = z.enum([
  'off',
  'locking',
  'in-step',
  'no-video',
  'unavailable',
  'turned-off',
]);
/** Where video sync stands for one cast (see {@link VideoSyncPhaseSchema}). */
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
 * - `not-web-page`: the tab shows a page no extension may enter (a browser
 *   page, the Web Store, a local file), so a reload would not help.
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
  'not-web-page',
  'freeze',
  'live-edge',
]);
/** Why video sync is unavailable or turned off (see {@link VideoSyncReasonSchema}). */
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
/** Video sync status for popup display (see {@link VideoSyncStatusSchema}). */
export type VideoSyncStatus = z.infer<typeof VideoSyncStatusSchema>;
