/**
 * Message types for communication between StreamSession and AudioConsumerWorker.
 *
 * All types are prefixed with "Worker" to avoid naming collisions with
 * Chrome extension messages in lib/message-schemas.ts.
 *
 * Inbound messages flow from StreamSession to Worker.
 * Outbound messages flow from Worker to StreamSession.
 */

import type { EncoderConfig, StreamMetadata } from '@thaumic-cast/protocol';

// ─────────────────────────────────────────────────────────────────────────────
// Inbound Messages (StreamSession → Worker)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initializes the worker with buffer and encoder configuration.
 *
 * - `'passthrough'` mode (default): The worker drains Float32 samples from the SAB,
 *   encodes them, and sends encoded frames via WebSocket. Used for compressed codecs.
 * - `'encode'` mode: The AudioWorklet has already encoded PCM to Int16 in the SAB.
 *   The worker reads complete Int16 frames and relays them directly via WebSocket.
 */
export interface WorkerInitMessage {
  type: 'INIT';
  sab: SharedArrayBuffer;
  bufferSize: number;
  bufferMask: number;
  headerSize: number;
  sampleRate: number;
  encoderConfig: EncoderConfig;
  wsUrl: string;
  /** Pipeline mode. Defaults to 'passthrough' for backward compatibility. */
  mode?: 'encode' | 'passthrough';
  /** Number of interleaved Int16 samples per frame. Required when mode is 'encode'. */
  frameSizeInterleaved?: number;
}

/** Stops the worker and cleans up resources. */
export interface WorkerStopMessage {
  type: 'STOP';
}

/** Starts playback on the specified speakers. */
export interface WorkerStartPlaybackMessage {
  type: 'START_PLAYBACK';
  speakerIps: string[];
  metadata?: StreamMetadata;
  /** Whether to synchronize multi-speaker playback (default: false). */
  syncSpeakers?: boolean;
  /** Whether the client has video sync enabled (gates server-side latency monitoring). */
  videoSyncEnabled: boolean;
}

/** Updates stream metadata on all connected speakers. */
export interface WorkerMetadataUpdateMessage {
  type: 'METADATA_UPDATE';
  metadata: StreamMetadata;
}

/** Union of all messages that can be sent to the worker. */
export type WorkerInboundMessage =
  | WorkerInitMessage
  | WorkerStopMessage
  | WorkerStartPlaybackMessage
  | WorkerMetadataUpdateMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Outbound Messages (Worker → StreamSession)
// ─────────────────────────────────────────────────────────────────────────────

/** Worker is ready to receive configuration. */
export interface WorkerReadyMessage {
  type: 'READY';
}

/** WebSocket connected to desktop app. */
export interface WorkerConnectedMessage {
  type: 'CONNECTED';
  streamId: string;
}

/** WebSocket disconnected from desktop app. */
export interface WorkerDisconnectedMessage {
  type: 'DISCONNECTED';
  reason: string;
}

/** Error occurred in the worker. */
export interface WorkerErrorMessage {
  type: 'ERROR';
  message: string;
}

/** Stream is ready for playback (buffer threshold reached). */
export interface WorkerStreamReadyMessage {
  type: 'STREAM_READY';
  bufferSize: number;
}

/** Playback started on a speaker. */
export interface WorkerPlaybackStartedMessage {
  type: 'PLAYBACK_STARTED';
  speakerIp: string;
  streamUrl: string;
}

/** Results of playback start attempts. */
export interface WorkerPlaybackResultsMessage {
  type: 'PLAYBACK_RESULTS';
  results: Array<{
    speakerIp: string;
    success: boolean;
    streamUrl?: string;
    error?: string;
  }>;
}

/** Playback error occurred. */
export interface WorkerPlaybackErrorMessage {
  type: 'PLAYBACK_ERROR';
  message: string;
}

/** Periodic statistics from the worker. */
export interface WorkerStatsMessage {
  type: 'STATS';
  /** Underflow events (buffer empty when reading). */
  underflows: number;
  /** Samples dropped by worklet (ring buffer full). */
  producerDroppedSamples: number;
  /** Frames dropped by worker (backpressure in realtime mode). */
  consumerDroppedFrames: number;
  /** Samples dropped by catch-up logic (bounded latency). */
  catchUpDroppedSamples: number;
  /** Cycles where drain was skipped due to backpressure. */
  backpressureCycles: number;
  /** Number of wakeups in this stats interval. */
  wakeups: number;
  /** Average samples read per wakeup. */
  avgSamplesPerWake: number;
  /** Current encoder queue depth. */
  encodeQueueSize: number;
  /** Current WebSocket buffered amount. */
  wsBufferedAmount: number;
  /** Number of encoded frames waiting to send (quality mode). */
  frameQueueSize: number;
  /** Total bytes in frame queue. */
  frameQueueBytes: number;
  /** Frames dropped due to queue overflow. */
  frameQueueOverflowDrops: number;
}

/** Timestamped snapshot of pipeline health metrics, captured every stats interval. */
export interface MetricSnapshot {
  /** Milliseconds since stream start. */
  elapsedMs: number;
  // Ring buffer (Metric 1)
  /** Ring buffer fill level (0.0 = empty, 1.0 = full). */
  ringFillFraction: number;
  /** Samples dropped by producer overflow this interval. */
  overflowSamples: number;
  /** Underflow events this interval. */
  underflowCount: number;
  // Encoder (Metric 2)
  /** Frames encoded this interval. */
  framesEncoded: number;
  /** Average encode() time in ms this interval. */
  avgEncodeMs: number;
  /** Instantaneous encoder queue depth. */
  encodeQueueSize: number;
  // WebSocket (Metric 3)
  /** Frames sent over WebSocket this interval. */
  framesSent: number;
  /** WebSocket bufferedAmount as % of high-water mark. */
  wsPressurePct: number;
  /** Frames dropped (backpressure) this interval. */
  droppedFrames: number;
  /** Quality mode frame queue bytes (instantaneous). */
  frameQueueBytes: number;
}

/** Full pipeline metrics timeline, posted on stream end. */
export interface WorkerMetricsDumpMessage {
  type: 'METRICS_DUMP';
  timeline: MetricSnapshot[];
}

/** Union of all messages that can be sent from the worker. */
export type WorkerOutboundMessage =
  | WorkerReadyMessage
  | WorkerConnectedMessage
  | WorkerDisconnectedMessage
  | WorkerErrorMessage
  | WorkerStreamReadyMessage
  | WorkerPlaybackStartedMessage
  | WorkerPlaybackResultsMessage
  | WorkerPlaybackErrorMessage
  | WorkerStatsMessage
  | WorkerMetricsDumpMessage;
