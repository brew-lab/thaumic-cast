import { z } from 'zod';

import { TransportStateSchema, ZoneGroupSchema } from './sonos.js';

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
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('playbackStopFailed'),
    streamId: z.string(),
    speakerIp: z.string(),
    error: z.string(),
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
 * Broadcast event wrapper from desktop app.
 * Uses passthrough to allow the nested event fields.
 */
export const BroadcastEventSchema = z.union([
  z.object({ category: z.literal('sonos') }).passthrough(),
  z.object({ category: z.literal('stream') }).passthrough(),
  z.object({ category: z.literal('latency') }).passthrough(),
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
