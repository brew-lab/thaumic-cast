/**
 * Audio Relay Worker
 *
 * Reads pre-encoded Int16 frames from a SharedArrayBuffer ring buffer and
 * relays them via WebSocket. The AudioWorklet has already performed the
 * Float32-to-Int16 conversion — this Worker simply reads complete frames
 * and sends them to the server.
 *
 * Architecture:
 *   AudioWorklet (encode) → SharedArrayBuffer (Int16) → Worker (relay via WebSocket)
 *                                                          ↓
 *                                               Main thread only for:
 *                                               - Stats logging
 *                                               - Control messages
 */

import {
  CTRL_WRITE_IDX,
  CTRL_READ_IDX,
  CTRL_DROPPED_SAMPLES,
  DATA_BYTE_OFFSET,
} from './ring-buffer';
import type { EncoderConfig } from '@thaumic-cast/protocol';
import type { WorkerInboundMessage } from './worker-messages';
import { getStreamingPolicy } from '@thaumic-cast/protocol';
import { exponentialBackoff } from '../lib/backoff';
import {
  type WorkerState,
  createWorkerState,
  resetStatsCounters,
  postToMain,
  alignDown,
  yieldMacrotask,
  isWsBackpressured,
  enqueueFrame,
  flushFrameQueue,
  resetFrameQueueState,
  connectWebSocket,
  handleCommonMessage,
  cleanupSharedState,
  flushQueuedFrames,
  maybePostStats,
  BACKPRESSURE_BACKOFF_INITIAL_MS,
  BACKPRESSURE_BACKOFF_MAX_MS,
  QUALITY_BACKOFF_MAX_MS,
  WAIT_TIMEOUT_MS,
  FRAME_QUEUE_MAX_BYTES,
} from './worker-base';

const s: WorkerState = createWorkerState('AudioRelayWorker');

// ─────────────────────────────────────────────────────────────────────────────
// Worker-Specific State
// ─────────────────────────────────────────────────────────────────────────────

// Ring buffer state
let control: Int32Array | null = null;
let dataInt16: Int16Array | null = null;
let bufferCapacity = 0;
let bufferMask = 0;
let running = false;

// Frame sizing
/** Number of interleaved Int16 samples per frame. */
let frameSizeInterleaved = 0;

// Pre-allocated temp buffer for wrap-around reads
let tempInt16: Int16Array | null = null;
let tempUint8: Uint8Array | null = null;

// Catch-up thresholds (computed from constants and sample rate)
let catchUpTargetSamples = 0;
let catchUpMaxSamples = 0;

/** Frames read from SAB this stats interval. */
let framesReadThisInterval = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Bounded Latency Catch-up
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Performs catch-up if the ring buffer has accumulated too much data.
 * This bounds latency by dropping oldest audio when we fall behind.
 *
 * In quality mode (catchUpMaxMs === null), catch-up is disabled.
 * In realtime mode, when buffer exceeds catchUpMaxMs, we advance readIdx
 * to (writeIdx - targetSamples) aligned to frame boundaries.
 *
 * @returns The number of samples dropped, or 0 if no catch-up needed
 */
function performCatchUpIfNeeded(): number {
  if (!control || !s.policy) return 0;

  // Quality mode: catch-up is disabled
  if (s.policy.catchUpMaxMs === null) return 0;

  const writeIdx = Atomics.load(control, CTRL_WRITE_IDX);
  const readIdx = Atomics.load(control, CTRL_READ_IDX);
  const available = (writeIdx - readIdx) >>> 0;

  if (available <= catchUpMaxSamples) {
    return 0;
  }

  // Calculate new read position aligned to frame boundary
  const alignedTarget = alignDown(catchUpTargetSamples, frameSizeInterleaved);
  const newReadIdx = (writeIdx - alignedTarget) | 0;
  const droppedSamples = (newReadIdx - readIdx) >>> 0;

  // Advance read index
  Atomics.store(control, CTRL_READ_IDX, newReadIdx);

  // Track for stats
  s.catchUpDroppedSamples += droppedSamples;

  s.log.warn(`CATCH-UP: Dropped ${droppedSamples} samples to bound latency`);

  return droppedSamples;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ring Buffer Reading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads one complete frame from the ring buffer.
 * Returns a Uint8Array view suitable for WebSocket.send(), or null if
 * fewer than frameSizeInterleaved samples are available.
 *
 * Always copies into a pre-allocated temp buffer because WebSocket.send()
 * rejects ArrayBufferViews backed by SharedArrayBuffer.
 *
 * @returns A Uint8Array of the frame bytes, or null if no complete frame available
 */
function readOneFrame(): Uint8Array | null {
  if (!control || !dataInt16 || !tempInt16 || !tempUint8) return null;

  const write = Atomics.load(control, CTRL_WRITE_IDX);
  const read = Atomics.load(control, CTRL_READ_IDX);
  const available = (write - read) >>> 0;

  if (available < frameSizeInterleaved) return null;

  const startOffset = read & bufferMask;

  if (startOffset + frameSizeInterleaved <= bufferCapacity) {
    // No wrap: single copy
    tempInt16.set(dataInt16.subarray(startOffset, startOffset + frameSizeInterleaved));
  } else {
    // Wrap: two-part copy
    const firstPart = bufferCapacity - startOffset;
    tempInt16.set(dataInt16.subarray(startOffset, bufferCapacity), 0);
    tempInt16.set(dataInt16.subarray(0, frameSizeInterleaved - firstPart), firstPart);
  }

  const frame = tempUint8;

  Atomics.store(control, CTRL_READ_IDX, (read + frameSizeInterleaved) | 0);
  s.totalSamplesRead += frameSizeInterleaved;

  return frame;
}

/**
 * Checks if at least one complete frame is available in the ring buffer.
 * @returns True if frameSizeInterleaved or more samples are available
 */
function hasAvailableFrame(): boolean {
  if (!control) return false;
  const write = Atomics.load(control, CTRL_WRITE_IDX);
  const read = Atomics.load(control, CTRL_READ_IDX);
  return (write - read) >>> 0 >= frameSizeInterleaved;
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame Send/Queue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sends a frame over WebSocket or queues it based on streaming policy.
 *
 * In realtime mode, drops frames when WebSocket is backpressured.
 * In quality mode, queues frames for later delivery.
 *
 * @param frame - The frame bytes to send
 */
function sendOrQueue(frame: Uint8Array): void {
  if (!s.socket || s.socket.readyState !== WebSocket.OPEN || !s.policy) return;

  const wsBackpressured = isWsBackpressured(s);

  if (wsBackpressured) {
    if (s.policy.dropOnBackpressure) {
      // Realtime mode: drop the frame
      s.droppedFrameCount++;
    } else {
      // Quality mode: queue the frame.
      // Must copy because frame may be a view into the temp buffer
      // that will be overwritten on the next read.
      enqueueFrame(s, new Uint8Array(frame));
    }
    return;
  }

  s.socket.send(frame);
  s.framesSentThisInterval++;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Consumption Loop
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main consumption loop that reads pre-encoded frames from the SAB and relays
 * them via WebSocket.
 *
 * Each scheduling slot drains ALL available complete frames from the ring buffer,
 * maximizing throughput when Chrome background-throttles the worker.
 *
 * Flow:
 * 1. Catch-up (realtime mode): drop old frames if buffer too deep
 * 2. Flush quality-mode frame queue if backpressure has eased
 * 3. Drain all available complete frames, sending or queuing each one
 * 4. Post stats periodically
 * 5. If data still available (backpressure limited drain): yield and retry
 * 6. If buffer empty: wait for producer via Atomics.waitAsync
 */
async function consumeLoop(): Promise<void> {
  if (!control) return;

  s.lastStatsTime = performance.now();
  s.lastProducerDroppedSamples = Atomics.load(control, CTRL_DROPPED_SAMPLES);

  while (running) {
    // BOUNDED LATENCY (realtime mode only): drop old data if buffer too deep
    performCatchUpIfNeeded();

    // DETECT PRODUCER DROPS: Check if AudioWorklet dropped samples
    const currentDropped = Atomics.load(control, CTRL_DROPPED_SAMPLES);
    if (currentDropped !== s.prevProducerDroppedSamples) {
      const dropDelta = (currentDropped - s.prevProducerDroppedSamples) >>> 0;
      if (dropDelta > 0) {
        s.log.warn(`Producer dropped ${dropDelta} samples`);
      }
      s.prevProducerDroppedSamples = currentDropped;
    }

    // QUALITY MODE: Flush any queued frames before draining more
    if (!s.policy?.dropOnBackpressure && s.frameQueue.length > 0) {
      const flushed = flushFrameQueue(s);
      if (flushed > 0) {
        s.log.debug(`Flushed ${flushed} queued frames`);
      }
    }

    // BACKPRESSURE HANDLING
    // Realtime mode: check WebSocket backpressure
    // Quality mode: WebSocket handled by frame queue, so only back off if queue is at max
    const shouldBackoff = s.policy?.dropOnBackpressure
      ? isWsBackpressured(s)
      : s.frameQueueBytes >= FRAME_QUEUE_MAX_BYTES;

    if (shouldBackoff) {
      s.backpressureCycles++;
      s.consecutiveBackpressureCycles++;
      const maxMs = s.policy?.dropOnBackpressure
        ? BACKPRESSURE_BACKOFF_MAX_MS
        : QUALITY_BACKOFF_MAX_MS;
      const backoffMs = exponentialBackoff(
        s.consecutiveBackpressureCycles,
        BACKPRESSURE_BACKOFF_INITIAL_MS,
        maxMs,
      );
      maybePostStats(s, control, bufferCapacity, getCustomMetrics, resetCustomCounters);
      await yieldMacrotask(backoffMs);
      continue;
    }

    // Reset consecutive backpressure counter when pressure eases
    s.consecutiveBackpressureCycles = 0;

    // Drain all available complete frames
    let framesDrained = 0;
    while (true) {
      if (isWsBackpressured(s) && s.policy?.dropOnBackpressure) break;

      const frame = readOneFrame();
      if (frame === null) break;

      framesReadThisInterval++;
      sendOrQueue(frame);
      framesDrained++;
    }

    if (framesDrained > 0) {
      s.wakeupCount++;
    }

    maybePostStats(s, control, bufferCapacity, getCustomMetrics, resetCustomCounters);

    // Check if data still available (backpressure limited the drain)
    if (hasAvailableFrame()) {
      await yieldMacrotask(0);
      continue;
    }

    // Buffer empty: wait for producer to write (with timeout for underflow detection)
    const write = Atomics.load(control, CTRL_WRITE_IDX);
    const waitResult = Atomics.waitAsync(control, CTRL_WRITE_IDX, write, WAIT_TIMEOUT_MS);
    if (waitResult.async) {
      const result = await waitResult.value;
      if (!running) break;
      if (result === 'timed-out') {
        s.underflowCount++;
        s.log.debug('Underflow: producer did not write within timeout');
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats Callbacks
// ─────────────────────────────────────────────────────────────────────────────

/**
 *
 */
function getCustomMetrics() {
  return {
    encodeQueueSize: 0,
    framesProcessed: framesReadThisInterval,
    avgEncodeMs: 0,
  };
}

/**
 *
 */
function resetCustomCounters(): void {
  framesReadThisInterval = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cleans up all resources.
 */
function cleanup(): void {
  running = false;

  flushQueuedFrames(s);
  cleanupSharedState(s);

  // Reset buffer state
  control = null;
  dataInt16 = null;
  tempInt16 = null;
  tempUint8 = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message Handler
// ─────────────────────────────────────────────────────────────────────────────

self.onmessage = async (event: MessageEvent<WorkerInboundMessage>) => {
  const msg = event.data;

  if (handleCommonMessage(s, msg, cleanup)) return;

  if (msg.type === 'INIT') {
    const {
      sab,
      bufferSize: size,
      bufferMask: mask,
      headerSize,
      encoderConfig,
      wsUrl,
      frameSizeInterleaved: initFrameSize,
    } = msg;

    try {
      if (msg.mode !== 'encode') {
        throw new Error('audio-relay.worker only supports mode "encode"');
      }

      if (!initFrameSize || initFrameSize <= 0) {
        throw new Error('frameSizeInterleaved is required and must be positive');
      }

      if ((size & (size - 1)) !== 0 || mask !== size - 1) {
        throw new Error('Invalid ring buffer configuration (size must be power of two)');
      }

      // Initialize ring buffer views
      control = new Int32Array(sab, 0, headerSize);
      dataInt16 = new Int16Array(sab, DATA_BYTE_OFFSET);
      bufferCapacity = size;
      bufferMask = mask;
      frameSizeInterleaved = initFrameSize;

      // Pre-allocate temp buffer for wrap-around reads
      tempInt16 = new Int16Array(frameSizeInterleaved);
      tempUint8 = new Uint8Array(tempInt16.buffer);

      // Initialize streaming policy from latency mode
      s.policy = getStreamingPolicy(encoderConfig.latencyMode);
      s.log.info(
        `Streaming policy: ${encoderConfig.latencyMode} mode ` +
          `(catchUp=${s.policy.catchUpMaxMs ?? 'disabled'}, dropOnBackpressure=${s.policy.dropOnBackpressure})`,
      );

      s.log.info(
        `Frame size: ${frameSizeInterleaved} interleaved Int16 samples ` +
          `(${frameSizeInterleaved * Int16Array.BYTES_PER_ELEMENT} bytes/frame)`,
      );

      // Reset state
      resetStatsCounters(s);
      framesReadThisInterval = 0;
      resetFrameQueueState(s);

      // Compute catch-up thresholds based on policy and sample rate
      const samplesPerMs = (encoderConfig.sampleRate * encoderConfig.channels) / 1000;
      catchUpTargetSamples = Math.floor(s.policy.catchUpTargetMs * samplesPerMs);
      catchUpMaxSamples =
        s.policy.catchUpMaxMs !== null
          ? Math.floor(s.policy.catchUpMaxMs * samplesPerMs)
          : Infinity;

      // Set frameSizeSamples for server handshake (per-channel, matching consumer worker behavior).
      const configWithFrameSize: EncoderConfig = {
        ...encoderConfig,
        frameSizeSamples: frameSizeInterleaved / encoderConfig.channels,
      };

      // Connect WebSocket (sends encoder config to server in handshake)
      const id = await connectWebSocket(s, wsUrl, configWithFrameSize);

      running = true;
      postToMain({ type: 'CONNECTED', streamId: id });

      // Start consumption loop
      consumeLoop().catch((err) => {
        s.log.error('consumeLoop error:', err);
        postToMain({ type: 'ERROR', message: String(err) });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      s.log.error('Initialization failed:', message);
      postToMain({ type: 'ERROR', message });
      cleanup();
    }
  }
};
