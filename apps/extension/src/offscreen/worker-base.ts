/**
 * Shared Worker Infrastructure
 *
 * Extracted from audio-consumer.worker.ts to enable reuse across worker types.
 * Contains WebSocket management, frame queue, stats, flow control, and cleanup
 * logic shared between the SAB-based audio consumer worker and the MSTP
 * (MediaStreamTrackProcessor) relay worker.
 */

import type { WsMessage } from '@thaumic-cast/protocol';
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
import { createLogger, Logger } from '@thaumic-cast/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Initial backpressure backoff delay (ms). */
export const BACKPRESSURE_BACKOFF_INITIAL_MS = 5;

/** Maximum backpressure backoff delay for realtime mode (ms). */
export const BACKPRESSURE_BACKOFF_MAX_MS = 40;

/** Maximum backpressure backoff delay for quality mode (ms). */
export const QUALITY_BACKOFF_MAX_MS = 50;

/** Timeout for waiting on producer (ms). Triggers underflow if exceeded. 200ms = 20 frames of headroom. */
export const WAIT_TIMEOUT_MS = 200;

/** Interval for posting diagnostic stats to main thread (ms). */
export const STATS_INTERVAL_MS = 2000;

/** Heartbeat interval for WebSocket (ms). */
export const HEARTBEAT_INTERVAL_MS = 5000;

/**
 * Maximum frame queue size in bytes (~30 seconds of audio).
 * At 48kHz/16-bit stereo PCM: ~5.76MB for 30s. With headroom: 8MB.
 */
export const FRAME_QUEUE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Target frame queue size after overflow trimming.
 * Uses hysteresis ratio from streaming policy to prevent oscillation.
 */
export const FRAME_QUEUE_TARGET_BYTES = Math.floor(
  FRAME_QUEUE_MAX_BYTES * FRAME_QUEUE_HYSTERESIS_RATIO,
);

/** WebSocket connection timeout (ms). */
const WS_CONNECT_TIMEOUT_MS = 5000;

/** Handshake timeout (ms). */
const HANDSHAKE_TIMEOUT_MS = 5000;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Worker-specific metrics returned by the getCustomMetrics callback.
 * Each worker provides its own implementation of these fields.
 */
export interface CustomMetrics {
  /** Underflow events (buffer empty when reading). */
  underflows: number;
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
}

/**
 * Shared state for worker infrastructure.
 * Contains WebSocket, streaming policy, counters, frame queue, metrics timeline,
 * and logger. Does NOT include worker-specific state like SAB control arrays,
 * encoders, or ring buffers.
 */
export interface WorkerState {
  /** WebSocket connection to the desktop app. */
  socket: WebSocket | null;
  /** Stream identifier assigned by the server handshake. */
  streamId: string | null;
  /** Heartbeat interval timer handle. */
  heartbeatInterval: ReturnType<typeof setInterval> | null;
  /** Current streaming policy (realtime vs quality mode). */
  policy: StreamingPolicy | null;

  // Diagnostic counters
  /** Last time stats were posted (performance.now timestamp). */
  lastStatsTime: number;

  // Frame queue (quality mode backpressure decoupling)
  /** Queue of encoded frames waiting to be sent. Frames must be ArrayBuffer-backed for WebSocket.send(). */
  frameQueue: Uint8Array<ArrayBuffer>[];
  /** Total bytes currently in frameQueue. */
  frameQueueBytes: number;
  /** Count of frames dropped from queue due to overflow. */
  frameQueueOverflowDrops: number;
  /** Previous value of producer dropped samples for delta computation. */
  prevProducerDroppedSamples: number;

  // Metrics timeline
  /** Time-series of metric snapshots for post-mortem analysis. */
  metricTimeline: MetricSnapshot[];
  /** Timestamp of stream start for relative timing (performance.now). */
  streamStartTime: number;

  /** Logger instance for this worker. */
  log: Logger;

  /** Whether the worker is in browser capture mode (no local audio pipeline). */
  browserCaptureMode: boolean;
}

/** Handshake message to send on WS connect. */
interface HandshakeMessage {
  type: string;
  payload: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// State Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a fresh WorkerState with all fields initialized to defaults.
 * @param name - Logger name for this worker instance
 * @returns A new WorkerState
 */
export function createWorkerState(name: string): WorkerState {
  return {
    socket: null,
    streamId: null,
    heartbeatInterval: null,
    policy: null,
    lastStatsTime: 0,
    frameQueue: [],
    frameQueueBytes: 0,
    frameQueueOverflowDrops: 0,
    prevProducerDroppedSamples: 0,
    metricTimeline: [],
    streamStartTime: 0,
    log: createLogger(name),
    browserCaptureMode: false,
  };
}

/**
 * Resets diagnostic stat counters that are interval-scoped.
 * Called after posting stats to main thread.
 * @param s - Worker state
 */
export function resetStatsCounters(s: WorkerState): void {
  s.frameQueueOverflowDrops = 0;
  s.lastStatsTime = performance.now();
}

/**
 * Resets frame queue state to initial values.
 * Used during cleanup and initialization.
 * @param s - Worker state
 */
export function resetFrameQueueState(s: WorkerState): void {
  s.frameQueue = [];
  s.frameQueueBytes = 0;
  s.frameQueueOverflowDrops = 0;
  s.prevProducerDroppedSamples = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow Control Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Posts a message to the main thread.
 * @param message - The outbound message to post
 */
export function postToMain(message: WorkerOutboundMessage): void {
  self.postMessage(message);
}

/**
 * Aligns a value down to the nearest multiple of alignment.
 * @param value - The value to align
 * @param alignment - The alignment boundary
 * @returns Aligned value
 */
export function alignDown(value: number, alignment: number): number {
  return Math.floor(value / alignment) * alignment;
}

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
 * @param delayMs - Milliseconds to wait (use 0 to just yield without delay)
 * @returns A promise that resolves after the delay
 */
export function yieldMacrotask(delayMs: number = 0): Promise<void> {
  if (delayMs === 0) {
    // Use MessageChannel for zero-delay yield - faster than setTimeout(0)
    return new Promise((resolve) => {
      yieldResolve = resolve;
      yieldChannel.port1.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Checks if the WebSocket is backpressured (buffered amount exceeds high water mark).
 * @param s - Worker state
 * @returns True if WebSocket buffer is overloaded
 */
export function isWsBackpressured(s: WorkerState): boolean {
  if (!s.policy || !s.socket) return false;
  return s.socket.bufferedAmount >= s.policy.wsBufferHighWater;
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame Queue Management (Quality Mode)
// ─────────────────────────────────────────────────────────────────────────────

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
 * Adds an encoded frame to the queue.
 * If queue exceeds bounds, trims oldest frames to target size.
 * @param s - Worker state
 * @param frame - Encoded frame data to queue
 */
export function enqueueFrame(s: WorkerState, frame: Uint8Array<ArrayBuffer>): void {
  s.frameQueue.push(frame);
  s.frameQueueBytes += frame.byteLength;

  if (s.frameQueueBytes > FRAME_QUEUE_MAX_BYTES) {
    trimFrameQueue(s);
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
 * Flushes all remaining queued frames to WebSocket without backpressure checks.
 * Used during cleanup/shutdown when we want to drain everything.
 * @param s - Worker state
 */
export function flushQueuedFrames(s: WorkerState): void {
  if (s.frameQueue.length === 0 || !s.socket || s.socket.readyState !== WebSocket.OPEN) {
    return;
  }

  const flushedCount = s.frameQueue.length;
  const flushedBytes = s.frameQueueBytes;

  for (const frame of s.frameQueue) {
    s.socket.send(frame);
  }

  s.log.info(
    `Flushed ${flushedCount} queued frames (${(flushedBytes / 1024).toFixed(1)}KB) on cleanup`,
  );

  s.frameQueue = [];
  s.frameQueueBytes = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats & Metrics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Posts diagnostic stats to main thread if the stats interval has elapsed.
 *
 * Captures a MetricSnapshot into the timeline and posts a STATS message.
 * The `control` parameter is nullable: when null (MSTP mode), producer drops
 * and ring fill fraction are reported as 0.
 *
 * @param s - Worker state
 * @param control - Int32Array for SAB ring buffer header, or null for MSTP mode
 * @param bufferCapacity - Ring buffer capacity in samples (0 if no ring buffer)
 * @param getCustomMetrics - Callback returning worker-specific metric fields
 * @param resetCustomCounters - Optional callback to reset worker-specific interval counters
 */
export function maybePostStats(
  s: WorkerState,
  control: Int32Array | null,
  bufferCapacity: number,
  getCustomMetrics: () => CustomMetrics,
  resetCustomCounters?: () => void,
): void {
  const now = performance.now();
  if (now - s.lastStatsTime < STATS_INTERVAL_MS) return;

  // Compute producer dropped samples delta (SAB mode only)
  let producerDroppedSamples = 0;
  let ringFillFraction = 0;

  if (control) {
    const { CTRL_DROPPED_SAMPLES, CTRL_WRITE_IDX, CTRL_READ_IDX } = getCtrlIndices();
    const totalDropped = Atomics.load(control, CTRL_DROPPED_SAMPLES);
    producerDroppedSamples = (totalDropped - s.prevProducerDroppedSamples) >>> 0;
    s.prevProducerDroppedSamples = totalDropped;

    if (bufferCapacity > 0) {
      const writeIdx = Atomics.load(control, CTRL_WRITE_IDX);
      const readIdx = Atomics.load(control, CTRL_READ_IDX);
      const available = (writeIdx - readIdx) >>> 0;
      ringFillFraction = available / bufferCapacity;
    }
  }

  const custom = getCustomMetrics();

  // Capture metric snapshot
  const snapshot: MetricSnapshot = {
    t: now - s.streamStartTime,
    fill: ringFillFraction,
    wsBuf: s.socket?.bufferedAmount ?? 0,
    uf: custom.underflows,
    pDrop: producerDroppedSamples,
    cDrop: custom.consumerDroppedFrames,
    cuDrop: custom.catchUpDroppedSamples,
    bp: custom.backpressureCycles,
    fq: s.frameQueue.length,
    fqB: s.frameQueueBytes,
    fqDrop: s.frameQueueOverflowDrops,
  };
  s.metricTimeline.push(snapshot);

  postToMain({
    type: 'STATS',
    underflows: custom.underflows,
    producerDroppedSamples,
    consumerDroppedFrames: custom.consumerDroppedFrames,
    catchUpDroppedSamples: custom.catchUpDroppedSamples,
    backpressureCycles: custom.backpressureCycles,
    wakeups: custom.wakeups,
    avgSamplesPerWake: custom.avgSamplesPerWake,
    encodeQueueSize: custom.encodeQueueSize,
    wsBufferedAmount: s.socket?.bufferedAmount ?? 0,
    frameQueueSize: s.frameQueue.length,
    frameQueueBytes: s.frameQueueBytes,
    frameQueueOverflowDrops: s.frameQueueOverflowDrops,
  });

  // Reset shared interval counters
  s.frameQueueOverflowDrops = 0;
  s.lastStatsTime = now;

  // Reset worker-specific interval counters
  resetCustomCounters?.();
}

/**
 * Returns ring buffer control indices.
 * Lazily imported to avoid circular dependency with ring-buffer module.
 */
function getCtrlIndices(): {
  CTRL_WRITE_IDX: number;
  CTRL_READ_IDX: number;
  CTRL_DROPPED_SAMPLES: number;
} {
  // These constants are stable (0, 1, 2) — inline them to avoid import coupling.
  // Matches ring-buffer.ts: CTRL_WRITE_IDX=0, CTRL_READ_IDX=1, CTRL_DROPPED_SAMPLES=2
  return { CTRL_WRITE_IDX: 0, CTRL_READ_IDX: 1, CTRL_DROPPED_SAMPLES: 2 };
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Starts the heartbeat timer for a worker state.
 * @param s - Worker state
 */
function startHeartbeat(s: WorkerState): void {
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
function stopHeartbeat(s: WorkerState): void {
  if (s.heartbeatInterval) {
    clearInterval(s.heartbeatInterval);
    s.heartbeatInterval = null;
  }
}

/**
 * Handles incoming WebSocket messages after handshake.
 * Dispatches server messages (STREAM_READY, PLAYBACK_STARTED, errors, etc.) to main thread.
 * @param s - Worker state
 * @param event - MessageEvent from WebSocket
 */
function handleWsMessage(s: WorkerState, event: MessageEvent): void {
  if (typeof event.data !== 'string') return;

  try {
    const raw = JSON.parse(event.data);

    // Skip broadcast events
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

      case 'BROWSER_CAPTURE_ERROR':
        s.log.error(`Browser capture error: ${message.payload.error} (${message.payload.reason})`);
        postToMain({
          type: 'BROWSER_CAPTURE_ERROR',
          error: message.payload.error,
          reason: message.payload.reason,
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
 * Handles WebSocket close events.
 * @param s - Worker state
 * @param event - CloseEvent from WebSocket
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
 * Connects to the WebSocket and performs handshake.
 * Sends a handshake message (encoder config), waits for HANDSHAKE_ACK with stream ID
 * and STREAM_READY, then sets up persistent message handlers.
 *
 * @param s - Worker state (socket and streamId are set on success)
 * @param wsUrl - The WebSocket URL to connect to
 * @param handshake - The handshake message to send on connect
 * @returns A promise resolving to the stream ID
 */
export async function connectWebSocket(
  s: WorkerState,
  wsUrl: string,
  handshake: HandshakeMessage,
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

      ws.send(JSON.stringify(handshake));

      const handshakeTimeout = setTimeout(() => {
        ws.close();
        reject(new Error('Handshake timeout'));
      }, HANDSHAKE_TIMEOUT_MS);

      // Handle clean close during handshake
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

          // Skip broadcast events
          if ('category' in raw || raw.type === 'INITIAL_STATE') return;

          const parsed = WsMessageSchema.safeParse(raw);
          if (!parsed.success) return;

          const message = parsed.data;

          if (message.type === 'HANDSHAKE_ACK') {
            clearTimeout(handshakeTimeout);
            ws.removeEventListener('message', handshakeHandler);
            s.streamId = message.payload.streamId;
            s.log.info(`Handshake complete, streamId: ${s.streamId}`);

            // Persist companion version metadata for the popup/options to display
            // and to drive the out-of-date warning. Pre-0.4.0 companions omit
            // these fields; we silently skip persistence so those builds continue
            // to work without triggering a false-positive warning.
            //
            // `appType` is intentionally allowed to be absent — a future companion
            // variant (e.g. `"cli"`) will be dropped to undefined by the schema's
            // `.catch(undefined)`, and we still want the About surface and the
            // warning to work using the version fields we *did* receive.
            //
            // Fire-and-forget: the popup's useStorageListener picks up the write
            // via chrome.storage.local.onChanged on cold open, so a brief gap
            // before storage lands is self-correcting.
            const { appVersion, protocolVersion, appType } = message.payload;
            if (appVersion && protocolVersion) {
              chrome.storage.local
                .set({
                  companionInfo: { appVersion, protocolVersion, appType },
                })
                .catch((err: unknown) => {
                  s.log.warn('Failed to persist companion info', err);
                });
            }

            startHeartbeat(s);

            // Set up persistent message handlers bound to this state
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
 * Sends a JSON message over the WebSocket.
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
// Message Handling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handles messages common to all worker types: STOP, START_PLAYBACK, METADATA_UPDATE.
 * Returns true if the message was handled, false if the worker should handle it.
 *
 * @param s - Worker state
 * @param msg - Inbound message from main thread
 * @param cleanup - Worker-specific cleanup function to call on STOP
 * @returns True if the message was handled
 */
export function handleCommonMessage(
  s: WorkerState,
  msg: WorkerInboundMessage,
  cleanup: () => void,
): boolean {
  switch (msg.type) {
    case 'STOP':
      cleanup();
      return true;

    case 'START_PLAYBACK': {
      const { speakerIps, metadata, syncSpeakers = false, videoSyncEnabled } = msg;
      sendWsMessage(s, {
        type: 'START_PLAYBACK',
        payload: { speakerIps, metadata, syncSpeakers, videoSyncEnabled },
      });
      return true;
    }

    case 'METADATA_UPDATE':
      sendWsMessage(s, {
        type: 'METADATA_UPDATE',
        payload: msg.metadata,
      });
      return true;

    default:
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dumps the metrics timeline and cleans up shared infrastructure state.
 * Stops heartbeat, posts metrics dump, and closes WebSocket.
 * Does NOT handle worker-specific cleanup (encoder, ring buffer, etc.).
 *
 * @param s - Worker state
 */
export function cleanupSharedState(s: WorkerState): void {
  // Dump metrics timeline
  if (s.metricTimeline.length > 0) {
    postToMain({
      type: 'METRICS_DUMP',
      timeline: s.metricTimeline,
    });
    s.metricTimeline = [];
  }

  stopHeartbeat(s);

  if (s.socket) {
    // Send stop message in browser capture mode
    if (s.browserCaptureMode && s.socket.readyState === WebSocket.OPEN) {
      try {
        s.socket.send(JSON.stringify({ type: 'STOP_BROWSER_CAPTURE' }));
      } catch {
        /* ignore send errors during shutdown */
      }
    }
    s.socket.onopen = null;
    s.socket.onclose = null;
    s.socket.onerror = null;
    s.socket.onmessage = null;
    s.socket.close();
    s.socket = null;
  }

  s.streamId = null;
  s.policy = null;
}
