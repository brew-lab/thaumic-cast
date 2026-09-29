import { z } from 'zod';

import { CompanionAudioSchema } from './audio.js';
import { TransportStateSchema, ZoneGroupSchema } from './sonos.js';

/**
 * Reasons for removing a speaker from an active cast session.
 * - `source_changed`: User switched Sonos to another source (Spotify, AirPlay, etc.)
 * - `playback_stopped`: Playback stopped on the speaker (system/network issue)
 * - `speaker_stopped`: Speaker stopped unexpectedly (e.g., stream killed due to underflow)
 * - `speaker_taken_over`: Another cast client started its own stream on this speaker
 * - `user_removed`: User explicitly removed the speaker via UI
 * - `continuation_failed`: A long PCM cast could not be moved on to its next segment
 *   (the speaker would not start it), so it ended there
 */
export const SpeakerRemovalReasonSchema = z.enum([
  'source_changed',
  'playback_stopped',
  'speaker_stopped',
  'speaker_taken_over',
  'user_removed',
  'continuation_failed',
]);
export type SpeakerRemovalReason = z.infer<typeof SpeakerRemovalReasonSchema>;

/**
 * Sonos event types broadcast by desktop app.
 */
export const SonosEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('transportState'),
    speakerIp: z.string(),
    state: TransportStateSchema,
    currentUri: z.string().optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('groupVolume'),
    speakerIp: z.string(),
    volume: z.number(),
    fixed: z.boolean().optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('groupMute'),
    speakerIp: z.string(),
    muted: z.boolean(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('sourceChanged'),
    speakerIp: z.string(),
    currentUri: z.string(),
    expectedUri: z.string().optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('zoneGroupsUpdated'),
    groups: z.array(ZoneGroupSchema),
    timestamp: z.number(),
  }),
]);
export type SonosEvent = z.infer<typeof SonosEventSchema>;

/**
 * Parses and validates a Sonos event from a raw payload.
 * @param data - The raw event data to parse
 * @returns A validated SonosEvent or null if invalid
 */
export function parseSonosEvent(data: unknown): SonosEvent | null {
  const result = SonosEventSchema.safeParse(data);
  return result.success ? result.data : null;
}

/**
 * Stream event types broadcast by desktop app.
 */
export const StreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('created'),
    streamId: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('ended'),
    streamId: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('playbackStarted'),
    streamId: z.string(),
    speakerIp: z.string(),
    streamUrl: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('playbackStopped'),
    streamId: z.string(),
    speakerIp: z.string(),
    /** Reason for stopping (optional for backward compat) */
    reason: SpeakerRemovalReasonSchema.optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('playbackStopFailed'),
    streamId: z.string(),
    speakerIp: z.string(),
    error: z.string(),
    /** Reason for the attempted stop (optional for backward compat) */
    reason: SpeakerRemovalReasonSchema.optional(),
    timestamp: z.number(),
  }),
  z.object({
    /**
     * Audio from the casting browser reached the companion late often enough
     * that every speaker on the stream had gaps: the stream's smoothing ran dry
     * at least twice in a minute. Sent at most once every ten minutes per
     * stream, and only to the client that owns it.
     */
    type: z.literal('ingestGaps'),
    /** ID of the stream whose audio arrived late */
    streamId: z.string(),
    /** Gaps counted in the last minute */
    gapsLastMinute: z.number().int().nonnegative(),
    /** The longest of those gaps in the audio's arrival, in milliseconds */
    worstGapMs: z.number().int().nonnegative(),
    /** The smoothing the stream runs with, in milliseconds */
    smoothingMs: z.number().int().nonnegative(),
    /**
     * The smallest smoothing step that would have covered the worst gap.
     * Absent when no step offered would: the gap is more than smoothing covers.
     */
    suggestedSmoothingMs: z.number().int().positive().optional(),
    timestamp: z.number(),
  }),
  CompanionAudioSchema.extend({
    /**
     * The companion's speaker-side audio settings changed. Sent to every
     * client, so the head start they show and the wording of their speaker
     * notices never go stale. Carries the settings as they now stand.
     */
    type: z.literal('companionAudioChanged'),
    timestamp: z.number(),
  }),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;

/**
 * Latency event types broadcast by desktop app.
 * Used for measuring audio playback delay from source to Sonos speaker.
 *
 * Events include epochId for deterministic state machine transitions:
 * - Epoch changes when Sonos reconnects to the stream
 * - Extension should re-lock sync when epochId changes
 */
export const LatencyEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('updated'),
    /** ID of the stream being measured */
    streamId: z.string(),
    /** IP address of the speaker being monitored */
    speakerIp: z.string(),
    /** Playback epoch ID (increments on Sonos reconnect) */
    epochId: z.number().int().nonnegative(),
    /** Measured latency in milliseconds (EMA-smoothed) */
    latencyMs: z.number().int().nonnegative(),
    /** Measurement jitter in milliseconds (standard deviation) */
    jitterMs: z.number().int().nonnegative(),
    /** Confidence score from 0.0 to 1.0 (higher = more reliable) */
    confidence: z.number().min(0).max(1),
    /** Unix timestamp in milliseconds */
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('stale'),
    /** ID of the stream that went stale */
    streamId: z.string(),
    /** IP address of the speaker that went stale */
    speakerIp: z.string(),
    /** Epoch ID that went stale (helps detect reconnects) */
    epochId: z.number().int().nonnegative(),
    /** Unix timestamp in milliseconds */
    timestamp: z.number(),
  }),
]);
export type LatencyEvent = z.infer<typeof LatencyEventSchema>;

/**
 * The companion's verdict on the buffer of a speaker fetching one of its streams.
 *
 * - `locking`: measuring, but the estimate is not yet precise or settled.
 * - `ok`: the reserve is measured and healthy.
 * - `draining`: the speaker plays faster than the audio arrives and its reserve
 *   is projected to reach the low floor within thirty minutes.
 * - `low`: the reserve has fallen below the absolute floor sized from the
 *   speaker head start its connection was sent.
 * - `paused`: the speaker is known not to be playing.
 * - `stale`: the speaker has stopped answering position polls.
 * - `dormant`: the speaker is playing something else.
 */
export const SpeakerHealthStateSchema = z.enum([
  'locking',
  'ok',
  'draining',
  'low',
  'paused',
  'stale',
  'dormant',
]);
export type SpeakerHealthState = z.infer<typeof SpeakerHealthStateSchema>;

/**
 * What a speaker notice is about. Mirrors `SpeakerNoticeKind` in thaumic-core's
 * speaker monitor.
 *
 * - `head_start_ran_out`: a Wi-Fi stall outlasted the speaker head start and the
 *   speaker cut out.
 * - `head_start_close`: a stall nearly outlasted the head start.
 * - `head_start_no_remedy`: a cut-out the longest head start would not have
 *   covered either.
 * - `running_low`: the reserve itself is below the floor.
 * - `drift_uncorrected`: the speaker's clock is draining the reserve and nothing
 *   corrects it.
 * - `drift_saturated`: drift correction is on but cannot keep up with the
 *   speaker's clock (sent only by companions with drift correction).
 */
export const SpeakerNoticeKindSchema = z.enum([
  'head_start_ran_out',
  'head_start_close',
  'head_start_no_remedy',
  'running_low',
  'drift_uncorrected',
  'drift_saturated',
]);
export type SpeakerNoticeKind = z.infer<typeof SpeakerNoticeKindSchema>;

/**
 * Why a notice's speaker is in trouble, where the kind alone does not say.
 * Mirrors `SpeakerNoticeCause` in thaumic-core's speaker monitor.
 *
 * - `drift`: the speaker's clock runs faster than the audio arrives, net of any
 *   drift correction, and that (not a Wi-Fi stall) drained its reserve. Sent
 *   with `running_low`.
 */
export const SpeakerNoticeCauseSchema = z.enum(['drift']);
export type SpeakerNoticeCause = z.infer<typeof SpeakerNoticeCauseSchema>;

/**
 * What the user is told about one speaker, with the figures its wording needs.
 * The companion decides; clients pick the words. Values are in milliseconds
 * unless named otherwise.
 */
export const SpeakerNoticeSchema = z.object({
  kind: SpeakerNoticeKindSchema,
  /**
   * The episode, counted per stream and speaker: the same while the notice is
   * repeated, new on a new episode or an escalation. Clients dismiss by it.
   */
  noticeId: z.number().int().nonnegative(),
  /** The audio a stall held back from the speaker (head-start kinds) */
  stallMs: z.number().int().nonnegative().optional(),
  /** The audio the speaker had left at its lowest, or holds most of the time (`running_low`) */
  leftMs: z.number().int().optional(),
  /** The speaker head start the connection was sent (PCM only) */
  headStartMs: z.number().int().nonnegative().optional(),
  /** The head start that would have covered the stall (`head_start_close`, `head_start_ran_out`) */
  suggestedHeadStartMs: z.number().int().positive().optional(),
  /** Minutes until the speaker runs low (drift kinds) */
  minutes: z.number().int().nonnegative().optional(),
  /** Whether stopping and restarting the cast refills the speaker */
  restartHelps: z.boolean(),
  /**
   * Why the speaker is in trouble, when the companion can tell and the kind
   * does not say (`running_low`: `drift` when the clock drained it). Absent
   * otherwise, and from companions that predate it. A cause this client does
   * not know is dropped rather than failing the notice.
   */
  cause: SpeakerNoticeCauseSchema.optional().catch(undefined),
});
export type SpeakerNotice = z.infer<typeof SpeakerNoticeSchema>;

/**
 * Network event types broadcast by the companion.
 */
export const NetworkEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('healthChanged'),
    health: z.enum(['ok', 'degraded']),
    /** Why the network is degraded, when it is */
    reason: z.string().optional(),
    /** Unix timestamp in milliseconds */
    timestamp: z.number(),
  }),
  z.object({
    /**
     * How much audio a speaker fetching one of our streams holds ahead of its
     * playhead (its reserve), and how fast that is changing. Sent every 30 s
     * and on every state change while the speaker is monitored, and only to
     * the client that owns the stream. The reserve's absolute zero is only
     * approximately known; `low` is judged against `floorMs`.
     */
    type: z.literal('speakerHealth'),
    /** ID of the stream the speaker is fetching */
    streamId: z.string(),
    /** IP address of the speaker fetching it */
    speakerIp: z.string(),
    /** Playback epoch of the speaker's current connection */
    epochId: z.number().int().nonnegative(),
    state: SpeakerHealthStateSchema,
    /** Best estimate of the reserve, in milliseconds of audio delivered */
    reserveMs: z.number().int().optional(),
    /** Half the width of the interval the reserve is known to lie in, in milliseconds */
    reservePrecisionMs: z.number().int().nonnegative().optional(),
    /** Lowest the reserve fell to over the last 30 s window, in milliseconds */
    reserveMinMs: z.number().int().optional(),
    /** Level the reserve stayed above nine tenths of the last window; `low` is judged on this */
    reserveP10Ms: z.number().int().optional(),
    /** Whether `reserveMinMs` and `reserveP10Ms` are on audio the speaker acknowledged */
    reserveAcked: z.boolean(),
    /** The reserve the speaker settled at on this connection once its head start went out */
    targetMs: z.number().int().optional(),
    /** How much faster the speaker plays than audio arrives, in ppm; positive drains */
    clockPpm: z.number().optional(),
    /** Standard error of `clockPpm` */
    clockSePpm: z.number().nonnegative().optional(),
    /**
     * The speaker head start the connection was actually sent, in milliseconds
     * (PCM only): less than configured when the stream held too little audio
     * when the speaker connected
     */
    headStartMs: z.number().int().nonnegative().optional(),
    /** The speaker head start configured when the connection was made, in milliseconds (PCM only) */
    headStartConfiguredMs: z.number().int().nonnegative().optional(),
    /** The acknowledged reserve below which the speaker is `low`, in milliseconds (PCM only) */
    floorMs: z.number().int().nonnegative().optional(),
    /**
     * How far the worst acknowledgement lag of the window stood above its
     * median, in milliseconds: the audio a Wi-Fi stall held back
     */
    stallMs: z.number().int().nonnegative().optional(),
    /**
     * Seconds until the reserve reaches `floorMs` at the net rate the speaker
     * drains it (its clock less any drift correction applied), when it is
     * measurably draining it
     */
    timeToFloorS: z.number().int().nonnegative().optional(),
    /**
     * Clock drift correction mode the connection was made under (PCM only).
     * Absent from companions without drift correction; degraded to
     * `undefined` for a mode this build does not know.
     */
    driftMode: z.enum(['on', 'observe', 'off']).optional().catch(undefined),
    /**
     * Drift correction command in ppm, positive inserting audio: applied with
     * `on`, what it would be with `observe`. Absent with `off`.
     */
    commandPpm: z.number().optional(),
    /** Audio drift correction has inserted (positive) or removed so far, in milliseconds; only while it corrects */
    netInsertedMs: z.number().int().optional(),
    /**
     * What the user should be told about this speaker, decided by the
     * companion. Repeated in every report while it stands, under the same
     * `noticeId`. A notice this build cannot read is dropped rather than
     * failing the whole event.
     */
    notice: SpeakerNoticeSchema.optional().catch(undefined),
    /** Unix timestamp in milliseconds */
    timestamp: z.number(),
  }),
]);
export type NetworkEvent = z.infer<typeof NetworkEventSchema>;

/**
 * Broadcast event wrapper from desktop app.
 * Uses passthrough to allow the nested event fields.
 */
export const BroadcastEventSchema = z.union([
  z.object({ category: z.literal('sonos') }).passthrough(),
  z.object({ category: z.literal('stream') }).passthrough(),
  z.object({ category: z.literal('latency') }).passthrough(),
  z.object({ category: z.literal('network') }).passthrough(),
  z.object({ category: z.literal('topology') }).passthrough(),
]);

/**
 * Typed broadcast event (use type guards to narrow).
 */
export interface SonosBroadcastEvent {
  category: 'sonos';
  type: SonosEvent['type'];
  [key: string]: unknown;
}

export interface StreamBroadcastEvent {
  category: 'stream';
  type: StreamEvent['type'];
  [key: string]: unknown;
}

export interface LatencyUpdatedBroadcastEvent {
  category: 'latency';
  type: 'updated';
  streamId: string;
  speakerIp: string;
  epochId: number;
  latencyMs: number;
  jitterMs: number;
  confidence: number;
  timestamp: number;
}

export interface LatencyStaleBroadcastEvent {
  category: 'latency';
  type: 'stale';
  streamId: string;
  speakerIp: string;
  epochId: number;
  timestamp: number;
}

export type LatencyBroadcastEvent = LatencyUpdatedBroadcastEvent | LatencyStaleBroadcastEvent;

export type BroadcastEvent = SonosBroadcastEvent | StreamBroadcastEvent | LatencyBroadcastEvent;
