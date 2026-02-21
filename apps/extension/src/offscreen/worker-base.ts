/**
 * Shared Worker Infrastructure
 *
 * Common functionality extracted from audio-consumer.worker.ts and
 * audio-relay.worker.ts to eliminate ~600 lines of duplication.
 *
 * Provides: WebSocket management, frame queue, stats/metrics, flow control
 * utilities, constants, and common message handling.
 *
 * Both workers import from this module and only contain their unique logic
 * (encoding/drain loops/ring buffer reading).
 */

import { CTRL_WRITE_IDX, CTRL_READ_IDX, CTRL_DROPPED_SAMPLES } from './ring-buffer';
import type { EncoderConfig, WsMessage } from '@thaumic-cast/protocol';
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
  MetricSnapshot,
} from './worker-messages';
import {
  WsMessageSchema,
  type StreamingPolicy,
  FRAME_QUEUE_HYSTERESIS_RATIO,
} from '@thaumic-cast/protocol';
import { createLogger, type Logger } from '@thaumic-cast/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Initial backpressure backoff delay (ms). */
export const BACKPRESSURE_BACKOFF_INITIAL_MS = 5;

/** Maximum backpressure backoff delay for realtime mode (ms). */
export const BACKPRESSURE_BACKOFF_MAX_MS = 40;

/** Maximum backpressure backoff delay for quality mode (ms). */
export const QUALITY_BACKOFF_MAX_MS = 50;

/** Timeout for waiting on producer (ms). Triggers underflow if exceeded. */
export const WAIT_TIMEOUT_MS = 200;

/** Interval for posting diagnostic stats to main thread (ms). */
export const STATS_INTERVAL_MS = 2000;

/** Heartbeat interval for WebSocket (ms). */
export const HEARTBEAT_INTERVAL_MS = 5000;

/** WebSocket connection timeout (ms). */
const WS_CONNECT_TIMEOUT_MS = 5000;

/** Handshake timeout (ms). */
const HANDSHAKE_TIMEOUT_MS = 5000;

/** Maximum frame queue size in bytes (~30 seconds of audio). */
export const FRAME_QUEUE_MAX_BYTES = 8 * 1024 * 1024;

/** Target frame queue size after overflow trimming. */
export const FRAME_QUEUE_TARGET_BYTES = Math.floor(
  FRAME_QUEUE_MAX_BYTES * FRAME_QUEUE_HYSTERESIS_RATIO,
);

/** Maximum metric snapshots to keep (300 entries x 2s = 10 minutes). */
const MAX_TIMELINE_ENTRIES = 300;

// ─────────────────────────────────────────────────────────────────────────────
// Worker State
// ─────────────────────────────────────────────────────────────────────────────

/** Mutable state shared across all worker-base functions. */
export interface WorkerState {
  // Logger
  log: Logger;

  // WebSocket
  socket: WebSocket | null;
  streamId: string | null;
  heartbeatInterval: ReturnType<typeof setInterval> | null;

  // Streaming policy
  policy: StreamingPolicy | null;

  // Stats counters
  underflowCount: number;
  droppedFrameCount: number;
  wakeupCount: number;
  totalSamplesRead: number;
  lastStatsTime: number;
  lastProducerDroppedSamples: number;
  catchUpDroppedSamples: number;
  backpressureCycles: number;
  consecutiveBackpressureCycles: number;

  // Metrics timeline
  metricTimeline: MetricSnapshot[];
  streamStartTime: number;
  framesSentThisInterval: number;

  // Frame queue
  frameQueue: Uint8Array[];
  frameQueueBytes: number;
  frameQueueOverflowDrops: number;
  prevProducerDroppedSamples: number;
}

/**
 * Creates a fresh WorkerState with all fields initialized.
 * @param logTag - Logger tag for this worker instance
 * @returns A new WorkerState
 */
export function createWorkerState(logTag: string): WorkerState {
  return {
    log: createLogger(logTag),
    socket: null,
    streamId: null,
    heartbeatInterval: null,
    policy: null,
    underflowCount: 0,
    droppedFrameCount: 0,
    wakeupCount: 0,
    totalSamplesRead: 0,
    lastStatsTime: 0,
    lastProducerDroppedSamples: 0,
    catchUpDroppedSamples: 0,
    backpressureCycles: 0,
    consecutiveBackpressureCycles: 0,
    metricTimeline: [],
    streamStartTime: 0,
    framesSentThisInterval: 0,
    frameQueue: [],
    frameQueueBytes: 0,
    frameQueueOverflowDrops: 0,
    prevProducerDroppedSamples: 0,
  };
}

/**
 * Resets stats counters to initial values for a new stream.
 * @param s - Worker state to reset
 */
export function resetStatsCounters(s: WorkerState): void {
  s.underflowCount = 0;
  s.droppedFrameCount = 0;
  s.catchUpDroppedSamples = 0;
  s.backpressureCycles = 0;
  s.consecutiveBackpressureCycles = 0;
  s.wakeupCount = 0;
  s.totalSamplesRead = 0;
  s.lastProducerDroppedSamples = 0;
  s.metricTimeline = [];
  s.streamStartTime = performance.now();
  s.framesSentThisInterval = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Posts a message to the main thread.
 * @param message - The outbound message to post
 */
export function postToMain(message: WorkerOutboundMessage): void {
  self.postMessage(message);
}

/**
 * Aligns a sample count down to the nearest frame boundary.
 * @param samples - Number of samples
 * @param frameSize - Frame size in samples
 * @returns Aligned sample count
 */
export function alignDown(samples: number, frameSize: number): number {
  return Math.floor(samples / frameSize) * frameSize;
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow Control: Yield
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reusable MessageChannel for zero-delay yields.
 * MessageChannel posts directly to the task queue with sub-millisecond latency,
 * unlike setTimeout(0) which has minimum 1-4ms delay due to browser throttling.
 */
const yieldChannel = new MessageChannel();
let yieldResolve: (() => void) | null = null;
yieldChannel.port2.onmessage = () => {
  yieldResolve?.();
  yieldResolve = null;
};

/**
 * Yields to the macrotask queue.
 * Unlike microtasks (Promise.resolve), this actually yields CPU time.
 * @param ms - Milliseconds to wait (use 0 to just yield without delay)
 * @returns A promise that resolves after the delay
 */
export function yieldMacrotask(ms: number): Promise<void> {
  if (ms === 0) {
    return new Promise((resolve) => {
      yieldResolve = resolve;
      yieldChannel.port1.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow Control: Backpressure
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks if the WebSocket is backpressured.
 * @param s - Worker state
 * @returns True if WebSocket buffer exceeds high water mark
 */
export function isWsBackpressured(s: WorkerState): boolean {
  if (!s.policy) return false;
  return (s.socket?.bufferedAmount ?? 0) >= s.policy.wsBufferHighWater;
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame Queue Management (Quality Mode)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adds a frame to the queue.
 * If queue exceeds bounds, trims oldest frames to target size.
 * @param s - Worker state
 * @param frame - Frame data to queue
 */
export function enqueueFrame(s: WorkerState, frame: Uint8Array): void {
  s.frameQueue.push(frame);
  s.frameQueueBytes += frame.byteLength;

  if (s.frameQueueBytes > FRAME_QUEUE_MAX_BYTES) {
    trimFrameQueue(s);
  }
}

/**
 * Trims the frame queue to target size, dropping oldest frames.
 * Uses hysteresis (FRAME_QUEUE_HYSTERESIS_RATIO) to prevent oscillation.
 * Uses splice() once instead of shift() in loop for O(n) vs O(n^2) performance.
 * @param s - Worker state
 */
function trimFrameQueue(s: WorkerState): void {
  let droppedBytes = 0;
  let droppedCount = 0;
  let bytesToDrop = s.frameQueueBytes - FRAME_QUEUE_TARGET_BYTES;

  while (droppedCount < s.frameQueue.length && bytesToDrop > 0) {
    const frameBytes = s.frameQueue[droppedCount]!.byteLength;
    droppedBytes += frameBytes;
    bytesToDrop -= frameBytes;
    droppedCount++;
  }

  if (droppedCount > 0) {
    s.frameQueue.splice(0, droppedCount);
    s.frameQueueBytes -= droppedBytes;
    s.frameQueueOverflowDrops += droppedCount;
    s.log.warn(
      `Frame queue overflow: dropped ${droppedCount} frames (${(droppedBytes / 1024).toFixed(1)}KB) ` +
        `to maintain ~30s bound`,
    );
  }
}

/**
 * Attempts to flush queued frames to WebSocket.
 * Respects WebSocket backpressure - stops when buffer exceeds high water mark.
 * Uses splice() once at end instead of shift() per frame for O(n) vs O(n^2) performance.
 * @param s - Worker state
 * @returns Number of frames sent
 */
export function flushFrameQueue(s: WorkerState): number {
  if (!s.socket || s.socket.readyState !== WebSocket.OPEN || !s.policy) {
    return 0;
  }

  let sentCount = 0;
  let sentBytes = 0;

  while (sentCount < s.frameQueue.length) {
    if (s.socket.bufferedAmount >= s.policy.wsBufferHighWater) {
      break;
    }

    const frame = s.frameQueue[sentCount]!;
    s.socket.send(frame);
    s.framesSentThisInterval++;
    sentBytes += frame.byteLength;
    sentCount++;
  }

  if (sentCount > 0) {
    s.frameQueue.splice(0, sentCount);
    s.frameQueueBytes -= sentBytes;
  }

  return sentCount;
}

/**
 * Resets frame queue state to initial values.
 * @param s - Worker state
 */
export function resetFrameQueueState(s: WorkerState): void {
  s.frameQueue = [];
  s.frameQueueBytes = 0;
  s.frameQueueOverflowDrops = 0;
  s.prevProducerDroppedSamples = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Connects to the WebSocket and performs handshake.
 * @param s - Worker state
 * @param wsUrl - The WebSocket URL to connect to
 * @param encoderConfig - The encoder configuration for the stream
 * @returns A promise resolving to the stream ID
 */
export async function connectWebSocket(
  s: WorkerState,
  wsUrl: string,
  encoderConfig: EncoderConfig,
): Promise<string> {
  return new Promise((resolve, reject) => {
    s.log.info(`Connecting to WebSocket: ${wsUrl}`);

    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    s.socket = ws;

    const connectTimeout = setTimeout(() => {
      ws.close();
      reject(new Error('WebSocket connection timeout'));
    }, WS_CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      clearTimeout(connectTimeout);
      s.log.info('WebSocket connected, sending handshake...');

      ws.send(
        JSON.stringify({
          type: 'HANDSHAKE',
          payload: { encoderConfig },
        }),
      );

      const handshakeTimeout = setTimeout(() => {
        ws.close();
        reject(new Error('Handshake timeout'));
      }, HANDSHAKE_TIMEOUT_MS);

      ws.onclose = (event: CloseEvent) => {
        clearTimeout(handshakeTimeout);
        reject(
          new Error(`WebSocket closed during handshake: ${event.reason || `Code ${event.code}`}`),
        );
      };

      const handshakeHandler = (event: MessageEvent) => {
        if (typeof event.data !== 'string') return;

        try {
          const raw = JSON.parse(event.data);

          if ('category' in raw || raw.type === 'INITIAL_STATE') return;

          const parsed = WsMessageSchema.safeParse(raw);
          if (!parsed.success) return;

          const message = parsed.data;

          if (message.type === 'HANDSHAKE_ACK') {
            clearTimeout(handshakeTimeout);
            ws.removeEventListener('message', handshakeHandler);
            s.streamId = message.payload.streamId;
            s.log.info(`Handshake complete, streamId: ${s.streamId}`);

            startHeartbeat(s);

            ws.onmessage = (ev) => handleWsMessage(s, ev);
            ws.onclose = (ev) => handleWsClose(s, ev);
            ws.onerror = () => handleWsError(s);

            resolve(message.payload.streamId);
          } else if (message.type === 'ERROR') {
            clearTimeout(handshakeTimeout);
            ws.removeEventListener('message', handshakeHandler);
            reject(new Error(message.payload.message));
          }
        } catch {
          // Ignore parse errors during handshake
        }
      };

      ws.addEventListener('message', handshakeHandler);
    };

    ws.onerror = () => {
      clearTimeout(connectTimeout);
      reject(new Error('WebSocket connection error'));
    };
  });
}

/**
 * Handles incoming WebSocket messages.
 * @param s - Worker state
 * @param event - The message event
 */
function handleWsMessage(s: WorkerState, event: MessageEvent): void {
  if (typeof event.data !== 'string') return;

  try {
    const raw = JSON.parse(event.data);

    if ('category' in raw || raw.type === 'INITIAL_STATE') return;

    const parsed = WsMessageSchema.safeParse(raw);
    if (!parsed.success) return;

    const message: WsMessage = parsed.data;

    switch (message.type) {
      case 'HEARTBEAT_ACK':
        break;

      case 'STREAM_READY':
        s.log.info(`Stream ready with ${message.payload.bufferSize} frames buffered`);
        postToMain({
          type: 'STREAM_READY',
          bufferSize: message.payload.bufferSize,
        });
        break;

      case 'PLAYBACK_STARTED':
        s.log.info(`Playback started on ${message.payload.speakerIp}`);
        postToMain({
          type: 'PLAYBACK_STARTED',
          speakerIp: message.payload.speakerIp,
          streamUrl: message.payload.streamUrl,
        });
        break;

      case 'PLAYBACK_RESULTS': {
        const results = message.payload.results;
        const successful = results.filter((r) => r.success).length;
        s.log.info(`Playback results: ${successful}/${results.length} speakers started`);
        postToMain({
          type: 'PLAYBACK_RESULTS',
          results,
        });
        break;
      }

      case 'PLAYBACK_ERROR':
        s.log.error(`Playback error: ${message.payload.message}`);
        postToMain({
          type: 'PLAYBACK_ERROR',
          message: message.payload.message,
        });
        break;

      case 'ERROR':
        s.log.error(`Server error: ${message.payload.message}`);
        postToMain({
          type: 'ERROR',
          message: message.payload.message,
        });
        break;

      default:
        break;
    }
  } catch {
    // Ignore parse errors
  }
}

/**
 * Handles WebSocket close.
 * @param s - Worker state
 * @param event - The close event
 */
function handleWsClose(s: WorkerState, event: CloseEvent): void {
  s.log.warn(`WebSocket closed: ${event.code} ${event.reason}`);
  stopHeartbeat(s);
  postToMain({
    type: 'DISCONNECTED',
    reason: event.reason || `Code ${event.code}`,
  });
}

/**
 * Handles WebSocket errors.
 * @param s - Worker state
 */
function handleWsError(s: WorkerState): void {
  s.log.error('WebSocket error');
}

/**
 * Starts the heartbeat timer.
 * @param s - Worker state
 */
export function startHeartbeat(s: WorkerState): void {
  stopHeartbeat(s);
  s.heartbeatInterval = setInterval(() => {
    if (s.socket?.readyState === WebSocket.OPEN) {
      s.socket.send(JSON.stringify({ type: 'HEARTBEAT' }));
    }
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * Stops the heartbeat timer.
 * @param s - Worker state
 */
export function stopHeartbeat(s: WorkerState): void {
  if (s.heartbeatInterval) {
    clearInterval(s.heartbeatInterval);
    s.heartbeatInterval = null;
  }
}

/**
 * Sends a message over WebSocket.
 * @param s - Worker state
 * @param message - The message object to send
 * @returns True if the message was sent, false otherwise
 */
export function sendWsMessage(s: WorkerState, message: object): boolean {
  if (!s.socket || s.socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  s.socket.send(JSON.stringify(message));
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats / Metrics
// ─────────────────────────────────────────────────────────────────────────────

/** Worker-specific metric fields injected into the shared stats logic. */
export interface CustomMetrics {
  /** Encoder queue depth (0 for relay worker). */
  encodeQueueSize: number;
  /** Frames processed this interval (encoded or read from SAB). */
  framesProcessed: number;
  /** Average encode time in ms (0 for relay worker). */
  avgEncodeMs: number;
}

/**
 * Posts diagnostic stats to main thread if the stats interval has elapsed.
 * Worker-specific metrics are injected via the getCustomMetrics callback.
 *
 * @param s - Worker state
 * @param control - Ring buffer control array
 * @param bufferCapacity - Ring buffer capacity in samples
 * @param getCustomMetrics - Returns worker-specific metric fields
 * @param resetCustomCounters - Called after posting stats to reset worker-specific counters
 */
export function maybePostStats(
  s: WorkerState,
  control: Int32Array,
  bufferCapacity: number,
  getCustomMetrics: () => CustomMetrics,
  resetCustomCounters?: () => void,
): void {
  const now = performance.now();
  if (now - s.lastStatsTime < STATS_INTERVAL_MS) return;

  // Compute producer dropped samples delta
  const totalDropped = Atomics.load(control, CTRL_DROPPED_SAMPLES);
  const producerDroppedSamples = (totalDropped - s.lastProducerDroppedSamples) >>> 0;
  s.lastProducerDroppedSamples = totalDropped;

  const avgSamplesPerWake = s.wakeupCount > 0 ? s.totalSamplesRead / s.wakeupCount : 0;

  // Compute ring buffer fill for snapshot
  const write = Atomics.load(control, CTRL_WRITE_IDX);
  const read = Atomics.load(control, CTRL_READ_IDX);
  const ringFillFraction = bufferCapacity > 0 ? ((write - read) >>> 0) / bufferCapacity : 0;

  const custom = getCustomMetrics();

  postToMain({
    type: 'STATS',
    underflows: s.underflowCount,
    producerDroppedSamples,
    consumerDroppedFrames: s.droppedFrameCount,
    catchUpDroppedSamples: s.catchUpDroppedSamples,
    backpressureCycles: s.backpressureCycles,
    wakeups: s.wakeupCount,
    avgSamplesPerWake,
    encodeQueueSize: custom.encodeQueueSize,
    wsBufferedAmount: s.socket?.bufferedAmount ?? 0,
    frameQueueSize: s.frameQueue.length,
    frameQueueBytes: s.frameQueueBytes,
    frameQueueOverflowDrops: s.frameQueueOverflowDrops,
  });

  // Push pipeline metric snapshot
  s.metricTimeline.push({
    elapsedMs: now - s.streamStartTime,
    ringFillFraction,
    overflowSamples: producerDroppedSamples,
    underflowCount: s.underflowCount,
    framesEncoded: custom.framesProcessed,
    avgEncodeMs: custom.avgEncodeMs,
    encodeQueueSize: custom.encodeQueueSize,
    framesSent: s.framesSentThisInterval,
    wsPressurePct:
      s.socket && s.policy ? (s.socket.bufferedAmount / s.policy.wsBufferHighWater) * 100 : 0,
    droppedFrames: s.droppedFrameCount,
    frameQueueBytes: s.frameQueueBytes,
  });
  if (s.metricTimeline.length > MAX_TIMELINE_ENTRIES) s.metricTimeline.shift();

  // Reset shared interval counters
  s.underflowCount = 0;
  s.droppedFrameCount = 0;
  s.catchUpDroppedSamples = 0;
  s.backpressureCycles = 0;
  s.frameQueueOverflowDrops = 0;
  s.wakeupCount = 0;
  s.totalSamplesRead = 0;
  s.framesSentThisInterval = 0;
  s.lastStatsTime = now;

  // Reset worker-specific counters
  resetCustomCounters?.();
}

// ─────────────────────────────────────────────────────────────────────────────
// Common Message Handling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handles common inbound messages (STOP, START_PLAYBACK, METADATA_UPDATE).
 * Returns true if the message was handled, false if it needs worker-specific handling (INIT).
 *
 * @param s - Worker state
 * @param msg - The inbound message
 * @param cleanup - Worker-specific cleanup function for STOP
 * @returns True if the message was handled
 */
export function handleCommonMessage(
  s: WorkerState,
  msg: WorkerInboundMessage,
  cleanup: () => void,
): boolean {
  if (msg.type === 'STOP') {
    cleanup();
    return true;
  }

  if (msg.type === 'START_PLAYBACK') {
    const { speakerIps, metadata, syncSpeakers = false, videoSyncEnabled } = msg;
    sendWsMessage(s, {
      type: 'START_PLAYBACK',
      payload: { speakerIps, metadata, syncSpeakers, videoSyncEnabled },
    });
    return true;
  }

  if (msg.type === 'METADATA_UPDATE') {
    sendWsMessage(s, {
      type: 'METADATA_UPDATE',
      payload: msg.metadata,
    });
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Performs common cleanup: dumps metrics, stops heartbeat, closes WebSocket,
 * resets frame queue and shared state.
 * @param s - Worker state
 */
export function cleanupSharedState(s: WorkerState): void {
  // Dump pipeline metrics timeline to main thread for structured logging
  if (s.metricTimeline.length > 0) {
    postToMain({ type: 'METRICS_DUMP', timeline: s.metricTimeline });
  }

  stopHeartbeat(s);

  if (s.socket) {
    s.socket.onopen = null;
    s.socket.onclose = null;
    s.socket.onerror = null;
    s.socket.onmessage = null;
    s.socket.close();
    s.socket = null;
  }

  s.streamId = null;
  s.policy = null;

  resetFrameQueueState(s);
}

/**
 * Flushes remaining queued frames on shutdown (no backpressure check).
 * @param s - Worker state
 */
export function flushQueuedFrames(s: WorkerState): void {
  if (s.frameQueue.length > 0 && s.socket?.readyState === WebSocket.OPEN) {
    const flushedCount = s.frameQueue.length;
    const flushedBytes = s.frameQueueBytes;
    for (const frame of s.frameQueue) {
      s.socket.send(frame);
    }
    s.log.info(
      `Flushed ${flushedCount} queued frames (${(flushedBytes / 1024).toFixed(1)}KB) on cleanup`,
    );
  }
}
