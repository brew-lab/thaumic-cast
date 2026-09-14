import { z } from 'zod';

import { TransportStateSchema, ZoneGroupSchema } from './sonos.js';

/**
 * Reasons for removing a speaker from an active cast session.
 * - `source_changed`: User switched Sonos to another source (Spotify, AirPlay, etc.)
 * - `playback_stopped`: Playback stopped on the speaker (system/network issue)
 * - `speaker_stopped`: Speaker stopped unexpectedly (e.g., stream killed due to underflow)
 * - `user_removed`: User explicitly removed the speaker via UI
 */
export const SpeakerRemovalReasonSchema = z.enum([
  'source_changed',
  'playback_stopped',
  'speaker_stopped',
  'speaker_taken_over',
  'user_removed',
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
 * Quality of the network path between the companion and one speaker, judged
 * from the TCP counters of the connection the speaker fetches audio over.
 *
 * - `good`: no latency spikes in the last minute.
 * - `degraded`: a few spikes; short dropouts are possible on a small buffer.
 * - `poor`: repeated spikes or failed round trips; audio will stutter unless
 *   the jitter buffer is large enough to ride them out.
 */
export const LinkQualitySchema = z.enum(['good', 'degraded', 'poor']);
export type LinkQuality = z.infer<typeof LinkQualitySchema>;

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
    type: z.literal('speakerLinkQuality'),
    /** IP address of the speaker the path leads to */
    speakerIp: z.string(),
    quality: LinkQualitySchema,
    /** Median round trip to the speaker over the last minute, in milliseconds */
    rttMedianMs: z.number().int().nonnegative(),
    /** Worst round trip over the last minute, in milliseconds */
    rttMaxMs: z.number().int().nonnegative(),
    /** Round trips over the spike threshold in the last minute */
    spikesPerMinute: z.number().int().nonnegative(),
    /** Retransmission timeouts in the last minute: stalls the kernel had to resend after */
    failuresPerMinute: z.number().int().nonnegative(),
    /** The jitter buffer the stream to this speaker runs with, in milliseconds */
    jitterBufferMs: z.number().int().nonnegative(),
    /**
     * The jitter buffer that would ride out the stalls seen in the last minute,
     * when raising it would help. Absent when the current buffer already covers
     * them or is at its maximum.
     */
    suggestedJitterBufferMs: z.number().int().nonnegative().optional(),
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
