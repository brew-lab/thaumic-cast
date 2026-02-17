import { z } from 'zod';

import { EncoderConfigSchema } from './encoder.js';
import { SpeakerRemovalReasonSchema } from './events.js';
import { InitialStatePayloadSchema } from './sonos.js';
import { StreamMetadataSchema } from './stream.js';

/**
 * WebSocket Message Payloads
 */
export const WsHandshakePayloadSchema = z.object({
  encoderConfig: EncoderConfigSchema,
});
export type WsHandshakePayload = z.infer<typeof WsHandshakePayloadSchema>;

export const WsHandshakeAckPayloadSchema = z.object({
  streamId: z.string(),
});
export type WsHandshakeAckPayload = z.infer<typeof WsHandshakeAckPayloadSchema>;

export const WsErrorPayloadSchema = z.object({
  message: z.string(),
});
export type WsErrorPayload = z.infer<typeof WsErrorPayloadSchema>;

/**
 * WebSocket Message Types
 */
export const WsMessageTypeSchema = z.enum([
  'HANDSHAKE',
  'HANDSHAKE_ACK',
  'HEARTBEAT',
  'HEARTBEAT_ACK',
  'STOP_STREAM',
  'METADATA_UPDATE',
  'ERROR',
  // Stream lifecycle messages
  'STREAM_READY',
  'START_PLAYBACK',
  'PLAYBACK_STARTED',
  'PLAYBACK_ERROR',
]);
export type WsMessageType = z.infer<typeof WsMessageTypeSchema>;

/**
 * Individual WebSocket message schemas for discriminated union.
 */
export const WsHandshakeMessageSchema = z.object({
  type: z.literal('HANDSHAKE'),
  payload: WsHandshakePayloadSchema,
});
export type WsHandshakeMessage = z.infer<typeof WsHandshakeMessageSchema>;

export const WsHandshakeAckMessageSchema = z.object({
  type: z.literal('HANDSHAKE_ACK'),
  payload: WsHandshakeAckPayloadSchema,
});
export type WsHandshakeAckMessage = z.infer<typeof WsHandshakeAckMessageSchema>;

export const WsHeartbeatMessageSchema = z.object({
  type: z.literal('HEARTBEAT'),
});
export type WsHeartbeatMessage = z.infer<typeof WsHeartbeatMessageSchema>;

export const WsHeartbeatAckMessageSchema = z.object({
  type: z.literal('HEARTBEAT_ACK'),
});
export type WsHeartbeatAckMessage = z.infer<typeof WsHeartbeatAckMessageSchema>;

export const WsStopStreamMessageSchema = z.object({
  type: z.literal('STOP_STREAM'),
});
export type WsStopStreamMessage = z.infer<typeof WsStopStreamMessageSchema>;

export const WsMetadataUpdateMessageSchema = z.object({
  type: z.literal('METADATA_UPDATE'),
  payload: StreamMetadataSchema,
});
export type WsMetadataUpdateMessage = z.infer<typeof WsMetadataUpdateMessageSchema>;

export const WsErrorMessageSchema = z.object({
  type: z.literal('ERROR'),
  payload: WsErrorPayloadSchema,
});
export type WsErrorMessage = z.infer<typeof WsErrorMessageSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Stream Lifecycle Messages
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sent by server when the stream has received its first audio frame
 * and is ready for playback. Client should wait for this before
 * requesting playback to avoid race conditions.
 */
export const WsStreamReadyPayloadSchema = z.object({
  /** Number of frames currently buffered. */
  bufferSize: z.number().int().nonnegative(),
});
export type WsStreamReadyPayload = z.infer<typeof WsStreamReadyPayloadSchema>;

export const WsStreamReadyMessageSchema = z.object({
  type: z.literal('STREAM_READY'),
  payload: WsStreamReadyPayloadSchema,
});
export type WsStreamReadyMessage = z.infer<typeof WsStreamReadyMessageSchema>;

/**
 * Sent by client to request playback on a Sonos speaker.
 * Must be sent after receiving STREAM_READY.
 */
export const WsStartPlaybackPayloadSchema = z.object({
  /** IP address of the Sonos speaker/coordinator. */
  speakerIp: z.string(),
  /** Whether the client has video sync enabled (gates server-side latency monitoring). */
  videoSyncEnabled: z.boolean().optional(),
});
export type WsStartPlaybackPayload = z.infer<typeof WsStartPlaybackPayloadSchema>;

export const WsStartPlaybackMessageSchema = z.object({
  type: z.literal('START_PLAYBACK'),
  payload: WsStartPlaybackPayloadSchema,
});
export type WsStartPlaybackMessage = z.infer<typeof WsStartPlaybackMessageSchema>;

/**
 * Sent by server when playback has successfully started on the speaker.
 */
export const WsPlaybackStartedPayloadSchema = z.object({
  /** IP address of the speaker that started playback. */
  speakerIp: z.string(),
  /** The stream URL being played. */
  streamUrl: z.string(),
});
export type WsPlaybackStartedPayload = z.infer<typeof WsPlaybackStartedPayloadSchema>;

export const WsPlaybackStartedMessageSchema = z.object({
  type: z.literal('PLAYBACK_STARTED'),
  payload: WsPlaybackStartedPayloadSchema,
});
export type WsPlaybackStartedMessage = z.infer<typeof WsPlaybackStartedMessageSchema>;

/**
 * Sent by server when playback failed to start.
 */
export const WsPlaybackErrorPayloadSchema = z.object({
  /** Error message describing the failure. */
  message: z.string(),
});
export type WsPlaybackErrorPayload = z.infer<typeof WsPlaybackErrorPayloadSchema>;

export const WsPlaybackErrorMessageSchema = z.object({
  type: z.literal('PLAYBACK_ERROR'),
  payload: WsPlaybackErrorPayloadSchema,
});
export type WsPlaybackErrorMessage = z.infer<typeof WsPlaybackErrorMessageSchema>;

/**
 * Payload for multi-group playback results message.
 * Contains per-speaker success/failure information.
 */
export const WsPlaybackResultsPayloadSchema = z.object({
  results: z.array(
    z.object({
      speakerIp: z.string(),
      success: z.boolean(),
      streamUrl: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
});
export type WsPlaybackResultsPayload = z.infer<typeof WsPlaybackResultsPayloadSchema>;

export const WsPlaybackResultsMessageSchema = z.object({
  type: z.literal('PLAYBACK_RESULTS'),
  payload: WsPlaybackResultsPayloadSchema,
});
export type WsPlaybackResultsMessage = z.infer<typeof WsPlaybackResultsMessageSchema>;

/**
 * Discriminated union for all WebSocket messages with typed payloads.
 */
export const WsMessageSchema = z.discriminatedUnion('type', [
  WsHandshakeMessageSchema,
  WsHandshakeAckMessageSchema,
  WsHeartbeatMessageSchema,
  WsHeartbeatAckMessageSchema,
  WsStopStreamMessageSchema,
  WsMetadataUpdateMessageSchema,
  WsErrorMessageSchema,
  // Stream lifecycle
  WsStreamReadyMessageSchema,
  WsStartPlaybackMessageSchema,
  WsPlaybackStartedMessageSchema,
  WsPlaybackResultsMessageSchema,
  WsPlaybackErrorMessageSchema,
]);
export type WsMessage = z.infer<typeof WsMessageSchema>;

/**
 * Initial state message sent by desktop on WebSocket connect.
 */
export const WsInitialStateMessageSchema = z.object({
  type: z.literal('INITIAL_STATE'),
  payload: InitialStatePayloadSchema,
});
export type WsInitialStateMessage = z.infer<typeof WsInitialStateMessageSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Control Commands (extension → desktop)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Control commands sent from extension to desktop app via WebSocket.
 * Must match the Rust `WsIncoming` enum format (SCREAMING_SNAKE_CASE type tag).
 */
export const WsControlCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('SET_VOLUME'),
    payload: z.object({
      ip: z.string(),
      volume: z.number().int().min(0).max(100),
      /** When true, sets volume for the entire sync group via the coordinator. */
      group: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('SET_MUTE'),
    payload: z.object({
      ip: z.string(),
      mute: z.boolean(),
      /** When true, sets mute for the entire sync group via the coordinator. */
      group: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('GET_VOLUME'),
    payload: z.object({ ip: z.string() }),
  }),
  z.object({
    type: z.literal('GET_MUTE'),
    payload: z.object({ ip: z.string() }),
  }),
  z.object({
    type: z.literal('STOP_PLAYBACK_SPEAKER'),
    payload: z.object({
      streamId: z.string(),
      ip: z.string(),
      /** Reason for stopping (optional for backward compat) */
      reason: SpeakerRemovalReasonSchema.optional(),
    }),
  }),
]);
export type WsControlCommand = z.infer<typeof WsControlCommandSchema>;
