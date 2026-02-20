/**
 * Audio Consumer Worker
 *
 * Consumes PCM samples from a SharedArrayBuffer ring buffer, encodes them,
 * and sends them over WebSocket. This keeps the entire real-time audio path
 * off the main thread, eliminating jitter from main thread blocking.
 *
 * Architecture:
 *   AudioWorklet → SharedArrayBuffer → Worker (drain + encode + websocket send)
 *                                         ↓
 *                              Main thread only for:
 *                              - Stats logging
 *                              - Control messages
 */

import {
  CTRL_WRITE_IDX,
  CTRL_READ_IDX,
  CTRL_DROPPED_SAMPLES,
  DATA_BYTE_OFFSET,
} from './ring-buffer';
import { createEncoder, type AudioEncoder } from './encoders';
import type { AudioCodec, EncoderConfig } from '@thaumic-cast/protocol';
import type { WorkerInboundMessage } from './worker-messages';
import { getStreamingPolicy, FRAME_DURATION_MS_DEFAULT } from '@thaumic-cast/protocol';
import { exponentialBackoff } from '../lib/backoff';
import {
  type WorkerState,
  createWorkerState,
  resetStatsCounters,
  postToMain,
  alignDown,
  yieldMacrotask,
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
} from './worker-base';

const s: WorkerState = createWorkerState('AudioWorker');

// ─────────────────────────────────────────────────────────────────────────────
// Codec-Aware Frame Sizing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the optimal frame size in samples for a given codec and sample rate.
 * Frame size is codec-aware for optimal efficiency:
 * - AAC: 1024 samples (spec-mandated per ISO/IEC 14496-3)
 * - FLAC: 4096 samples (larger frames improve compression ratio)
 * - Vorbis: 2048 samples (good balance for VBR encoding)
 * - PCM: Configurable duration (10ms, 20ms, or 40ms) - see frameDurationMs
 *
 * @param codec - The audio codec
 * @param sampleRate - The sample rate in Hz
 * @param frameDurationMs - Frame duration in milliseconds. Currently only used for PCM.
 * @returns Frame size in samples (mono frames, multiply by channels for interleaved)
 */
function getOptimalFrameSizeSamples(
  codec: AudioCodec,
  sampleRate: number,
  frameDurationMs: number = FRAME_DURATION_MS_DEFAULT,
): number {
  switch (codec) {
    case 'aac-lc':
    case 'he-aac':
    case 'he-aac-v2':
      return 1024;
    case 'flac':
      return 4096;
    case 'vorbis':
      return 2048;
    case 'pcm':
    default:
      return Math.round(sampleRate * (frameDurationMs / 1000));
  }
}

/**
 * Converts frame size in samples to duration in milliseconds.
 * @param frameSizeSamples - Frame size in mono samples
 * @param sampleRate - Sample rate in Hz
 * @returns Duration in milliseconds
 */
function frameSizeToMs(frameSizeSamples: number, sampleRate: number): number {
  return (frameSizeSamples / sampleRate) * 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Underflow Ramp Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ramp duration in milliseconds for fade-in/fade-out on underflow.
 * Short ramp (3ms) smooths discontinuities without audible delay.
 */
const RAMP_MS = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Worker-Specific State
// ─────────────────────────────────────────────────────────────────────────────

// Ring buffer state
let control: Int32Array | null = null;
let buffer: Float32Array | null = null;
let bufferSize = 0;
let bufferMask = 0;
let running = false;

// Frame accumulation
let frameSizeSamples = 0;
let frameBuffer: Float32Array | null = null;
let frameOffset = 0;

// Encoder
let encoder: AudioEncoder | null = null;

// Encode timing instrumentation
/** Frames encoded this stats interval. */
let framesEncodedThisInterval = 0;
/** Cumulative encode() time this stats interval in ms. */
let encodeTotalMs = 0;
/** Number of encode() calls this stats interval. */
let encodeCallCount = 0;

// Time-based pacing (computed from codec-aware frame size)
/** Next frame due time for time-based pacing (performance.now() timestamp). */
let nextFrameDueTime = 0;
/** Frame period in milliseconds (codec-dependent). */
let framePeriodMs = 0;
/** Maximum drift allowed before clamping frame timing (ms). ~6 frames of catch-up. */
let maxDriftMs = 0;

// Catch-up thresholds (computed from constants and sample rate)
let catchUpTargetSamples = 0;
let catchUpMaxSamples = 0;

// Underflow ramp state
/** Whether next frame needs a fade-in ramp after underflow. */
let needsRampIn = false;
/** Last sample value per channel for ramping from/to. */
let lastSamples: Float32Array | null = null;
/** Ramp length in interleaved samples (computed from RAMP_MS and sample rate). */
let rampSamples = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Underflow Ramp Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Applies a linear amplitude ramp to interleaved samples in-place.
 *
 * For fade-in: ramps from 0 to 1 over rampLen samples.
 * For fade-out: ramps from 1 to 0 over rampLen samples, starting from startSamples.
 *
 * @param buf - Interleaved Float32 samples to modify in-place
 * @param channels - Number of audio channels (1 or 2)
 * @param rampLen - Number of interleaved samples to ramp (clamped to buffer length)
 * @param fadeIn - True for fade-in (0→1), false for fade-out (1→0)
 * @param startSamples - Per-channel starting values for fade-out (ignored for fade-in)
 */
function applyRamp(
  buf: Float32Array,
  channels: number,
  rampLen: number,
  fadeIn: boolean,
  startSamples?: Float32Array,
): void {
  const len = Math.min(rampLen, buf.length);
  const frames = Math.floor(len / channels);
  if (frames === 0) return;

  const divisor = Math.max(frames - 1, 1);

  for (let frame = 0; frame < frames; frame++) {
    const t = fadeIn ? frame / divisor : 1 - frame / divisor;

    for (let ch = 0; ch < channels; ch++) {
      const idx = frame * channels + ch;
      if (fadeIn) {
        buf[idx] *= t;
      } else {
        const start = startSamples?.[ch] ?? 0;
        buf[idx] = start * t;
      }
    }
  }
}

/**
 * Captures the last sample value per channel from an interleaved buffer.
 * Used to track the final amplitude for smooth ramp transitions.
 *
 * @param buf - Interleaved Float32 samples
 * @param channels - Number of audio channels
 * @param length - Number of valid interleaved samples in buffer
 * @param target - Float32Array to store last samples (length >= channels)
 */
function captureLastSamples(
  buf: Float32Array,
  channels: number,
  length: number,
  target: Float32Array,
): void {
  if (length < channels) return;
  const lastFrameStart = length - channels;
  for (let ch = 0; ch < channels; ch++) {
    target[ch] = buf[lastFrameStart + ch] ?? 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bounded Latency Catch-up
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Performs catch-up if the ring buffer has accumulated too much data.
 * This bounds latency by dropping oldest audio when we fall behind.
 *
 * In quality mode (catchUpMaxMs === null), catch-up is disabled.
 * In realtime mode, when buffer exceeds catchUpMaxMs, we:
 * 1. Advance readIdx to (writeIdx - targetSamples) aligned to frame boundaries
 * 2. Reset frameOffset to discard any partial frame
 * 3. Advance encoder timestamp to keep audio time monotonic
 *
 * @returns The number of samples dropped, or 0 if no catch-up needed
 */
function performCatchUpIfNeeded(): number {
  if (!control || !encoder || !s.policy) return 0;

  // Quality mode: catch-up is disabled
  if (s.policy.catchUpMaxMs === null) return 0;

  const writeIdx = Atomics.load(control, CTRL_WRITE_IDX);
  const readIdx = Atomics.load(control, CTRL_READ_IDX);
  const available = (writeIdx - readIdx) >>> 0;

  if (available <= catchUpMaxSamples) {
    return 0;
  }

  const partialSamples = frameOffset;

  // Calculate new read position aligned to frame boundary
  const alignedTarget = alignDown(catchUpTargetSamples, frameSizeSamples);
  const newReadIdx = (writeIdx - alignedTarget) | 0;
  const droppedSamples = (newReadIdx - readIdx) >>> 0;
  const totalDroppedSamples = droppedSamples + partialSamples;

  // Advance read index
  Atomics.store(control, CTRL_READ_IDX, newReadIdx);

  // Reset partial frame - we're starting fresh
  frameOffset = 0;

  // Advance encoder timestamp to prevent time compression
  const channels = encoder.config.channels;
  const droppedFrames = totalDroppedSamples / channels;
  encoder.advanceTimestamp(droppedFrames);

  // Track for stats
  s.catchUpDroppedSamples += totalDroppedSamples;

  const droppedMs = (totalDroppedSamples / (encoder.config.sampleRate * channels)) * 1000;
  s.log.warn(`CATCH-UP: Dropped ${droppedMs.toFixed(0)}ms of audio to bound latency`);

  return totalDroppedSamples;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ring Buffer Reading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads available samples from the ring buffer into the frame buffer.
 * Uses monotonic indices with unsigned math and bitmask for buffer offset.
 * @returns The number of samples read, or 0 if none available
 */
function readFromRingBuffer(): number {
  if (!control || !buffer || !frameBuffer) return 0;

  const writeIdx = Atomics.load(control, CTRL_WRITE_IDX);
  let currentReadIdx = Atomics.load(control, CTRL_READ_IDX);

  let available = (writeIdx - currentReadIdx) >>> 0;

  if (available === 0) {
    return 0;
  }

  let samplesRead = 0;

  while (available > 0 && frameOffset < frameSizeSamples) {
    const samplesToRead = Math.min(available, frameSizeSamples - frameOffset);

    const readOffset = currentReadIdx & bufferMask;
    const endOffset = (currentReadIdx + samplesToRead) & bufferMask;

    if (readOffset < endOffset || samplesToRead === 0) {
      frameBuffer.set(buffer.subarray(readOffset, readOffset + samplesToRead), frameOffset);
    } else {
      const firstPart = bufferSize - readOffset;
      frameBuffer.set(buffer.subarray(readOffset, bufferSize), frameOffset);
      frameBuffer.set(buffer.subarray(0, samplesToRead - firstPart), frameOffset + firstPart);
    }

    frameOffset += samplesToRead;
    samplesRead += samplesToRead;
    currentReadIdx = (currentReadIdx + samplesToRead) | 0;
    available -= samplesToRead;
  }

  Atomics.store(control, CTRL_READ_IDX, currentReadIdx);

  return samplesRead;
}

// ─────────────────────────────────────────────────────────────────────────────
// Underflow Ramp Handling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handles underflow by flushing a partial frame with ramp-down to silence.
 *
 * When underflow occurs mid-frame (frameOffset > 0), this function:
 * 1. Captures the actual last samples from the partial frameBuffer
 * 2. Fills the remainder of the frame with a smooth ramp to zero
 * 3. Encodes and sends the frame
 * 4. Sets needsRampIn for smooth fade-in when audio resumes
 */
function handleUnderflowRamp(): void {
  if (
    !frameBuffer ||
    !encoder ||
    !s.socket ||
    s.socket.readyState !== WebSocket.OPEN ||
    !lastSamples
  ) {
    return;
  }

  const channels = encoder.config.channels;

  if (frameOffset < channels) {
    needsRampIn = true;
    return;
  }

  captureLastSamples(frameBuffer, channels, frameOffset, lastSamples);

  const remainingSamples = frameSizeSamples - frameOffset;
  const rampDownLen = Math.min(rampSamples, remainingSamples);

  if (rampDownLen >= channels) {
    applyRamp(
      frameBuffer.subarray(frameOffset, frameOffset + rampDownLen),
      channels,
      rampDownLen,
      false,
      lastSamples,
    );
  }

  const silenceStart = frameOffset + rampDownLen;
  if (silenceStart < frameSizeSamples) {
    frameBuffer.fill(0, silenceStart, frameSizeSamples);
  }

  frameOffset = frameSizeSamples;

  const encoded = encoder.encode(frameBuffer);
  if (encoded) {
    s.socket.send(encoded);
    s.framesSentThisInterval++;
  }

  frameOffset = 0;
  needsRampIn = true;

  s.log.debug('Flushed underflow frame with ramp-down');
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame Encoding and Sending
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encodes and sends/queues the accumulated frame if complete.
 *
 * Backpressure handling depends on streaming policy:
 * - Realtime mode: drop frames to maintain timing
 * - Quality mode: always encode, queue frames if WebSocket is backpressured
 */
function flushFrameIfReady(): void {
  if (!frameBuffer || frameOffset < frameSizeSamples) return;
  if (!encoder || !s.socket || s.socket.readyState !== WebSocket.OPEN || !s.policy) return;

  const channels = encoder.config.channels;

  // Encoder backpressure blocks both modes (can't bypass encoder)
  const encoderBackpressured = encoder.encodeQueueSize >= s.policy.maxEncodeQueue;

  if (encoderBackpressured) {
    if (s.policy.dropOnBackpressure) {
      s.droppedFrameCount++;
      encoder.advanceTimestamp(frameSizeSamples / channels);
      frameOffset = 0;
    }
    return;
  }

  // Apply fade-in ramp if resuming after discontinuity
  if (needsRampIn && rampSamples >= channels) {
    applyRamp(frameBuffer, channels, rampSamples, true);
    needsRampIn = false;
    s.log.debug('Applied fade-in ramp after discontinuity');
  }

  // Encode the frame (timed for instrumentation)
  const t0 = performance.now();
  const encoded = encoder.encode(frameBuffer);
  encodeTotalMs += performance.now() - t0;
  encodeCallCount++;
  framesEncodedThisInterval++;

  frameOffset = 0;

  if (!encoded) return;

  // WebSocket backpressure handling differs by mode
  const wsBackpressured = s.socket.bufferedAmount >= s.policy.wsBufferHighWater;

  if (wsBackpressured) {
    if (s.policy.dropOnBackpressure) {
      s.droppedFrameCount++;
    } else {
      enqueueFrame(s, new Uint8Array(encoded));
    }
    return;
  }

  s.socket.send(encoded);
  s.framesSentThisInterval++;
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow Control Helpers (Encoder-Aware)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks if the pipeline is backpressured (encoder + WebSocket).
 * @returns True if encoder queue or WebSocket buffer is overloaded
 */
function isBackpressured(): boolean {
  if (!s.policy) return false;
  return (
    (encoder?.encodeQueueSize ?? 0) >= s.policy.maxEncodeQueue ||
    (s.socket?.bufferedAmount ?? 0) >= s.policy.wsBufferHighWater
  );
}

/**
 * Checks if the encoder queue is backpressured (ignores WebSocket).
 * Used in quality mode where WebSocket backpressure is handled by frame queue.
 * @returns True if encoder queue is at or above threshold
 */
function isEncoderBackpressured(): boolean {
  return encoder !== null && encoder.encodeQueueSize >= (s.policy?.maxEncodeQueue ?? 16);
}

/**
 * Drains all available frames from the ring buffer in a single burst.
 *
 * Processes every sample the producer has written without imposing a time budget.
 * The loop breaks only when:
 * - The ring buffer is empty (readFromRingBuffer returns 0)
 * - Backpressure is detected (encoder or WebSocket, mode-dependent)
 *
 * @returns Number of complete frames drained
 */
function drainAvailable(): number {
  let framesProcessed = 0;

  while (true) {
    if (s.policy?.dropOnBackpressure) {
      if (isBackpressured()) break;
    } else {
      if (isEncoderBackpressured()) break;
    }

    const samplesRead = readFromRingBuffer();
    if (samplesRead === 0) break;

    s.totalSamplesRead += samplesRead;
    flushFrameIfReady();

    if (frameOffset === 0) {
      framesProcessed++;
    }
  }

  return framesProcessed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Consumption Loop
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main consumption loop with time-based pacing and backpressure-aware flow control.
 *
 * Uses performance.now() for rate control to pace frame production at codec-native
 * intervals, preventing burst processing and smoothing encoder/network load.
 *
 * Each scheduling slot drains ALL available data from the ring buffer in a single
 * burst via drainAvailable(), maximizing throughput when Chrome background-throttles
 * the worker.
 */
async function consumeLoop(): Promise<void> {
  if (!control) return;

  s.lastStatsTime = performance.now();
  s.lastProducerDroppedSamples = Atomics.load(control, CTRL_DROPPED_SAMPLES);

  while (running) {
    // BOUNDED LATENCY (realtime mode only)
    performCatchUpIfNeeded();

    // DETECT PRODUCER DROPS
    const currentDropped = Atomics.load(control, CTRL_DROPPED_SAMPLES);
    if (currentDropped !== s.prevProducerDroppedSamples) {
      const dropDelta = (currentDropped - s.prevProducerDroppedSamples) >>> 0;
      if (dropDelta > 0) {
        s.log.warn(`Producer dropped ${dropDelta} samples - marking for ramp-in`);
        needsRampIn = true;
      }
      s.prevProducerDroppedSamples = currentDropped;
    }

    // QUALITY MODE: Flush any queued frames before checking backpressure
    if (!s.policy?.dropOnBackpressure && s.frameQueue.length > 0) {
      const flushed = flushFrameQueue(s);
      if (flushed > 0) {
        s.log.debug(`Flushed ${flushed} queued frames`);
      }
    }

    // BACKPRESSURE HANDLING
    const shouldBackoff = s.policy?.dropOnBackpressure
      ? isBackpressured()
      : isEncoderBackpressured();

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
      maybePostStats(s, control, bufferSize, getCustomMetrics, resetCustomCounters);
      await yieldMacrotask(backoffMs);
      continue;
    }

    // Reset consecutive backpressure counter when pressure eases
    s.consecutiveBackpressureCycles = 0;

    // TIME-BASED PACING: Wait if we're ahead of schedule
    const now = performance.now();
    if (nextFrameDueTime > 0 && now < nextFrameDueTime) {
      const waitTime = nextFrameDueTime - now;
      if (waitTime > 1) {
        await yieldMacrotask(waitTime);
      }
    }

    // Drain all available frames
    const framesThisWake = drainAvailable();

    if (framesThisWake > 0) {
      s.wakeupCount++;

      // Update frame due time for time-based pacing
      if (nextFrameDueTime === 0) {
        nextFrameDueTime = performance.now();
      }
      nextFrameDueTime += framesThisWake * framePeriodMs;

      // Clamp: don't let due time fall more than maxDriftMs behind wall clock
      const nowAfterDrain = performance.now();
      if (nextFrameDueTime < nowAfterDrain - maxDriftMs) {
        nextFrameDueTime = nowAfterDrain - maxDriftMs;
      }

      // Clamp: don't let due time jump more than one frame period ahead
      if (nextFrameDueTime > nowAfterDrain + framePeriodMs) {
        nextFrameDueTime = nowAfterDrain + framePeriodMs;
      }
    }

    maybePostStats(s, control, bufferSize, getCustomMetrics, resetCustomCounters);

    // Check if buffer is empty
    const write = Atomics.load(control, CTRL_WRITE_IDX);
    const read = Atomics.load(control, CTRL_READ_IDX);
    const available = (write - read) >>> 0;

    if (available > 0) {
      await yieldMacrotask(0);
      continue;
    }

    // Buffer empty - wait for producer to write
    const waitResult = Atomics.waitAsync(control, CTRL_WRITE_IDX, write, WAIT_TIMEOUT_MS);
    if (waitResult.async) {
      const result = await waitResult.value;
      if (!running) break;
      if (result === 'timed-out') {
        s.underflowCount++;
        handleUnderflowRamp();
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
    encodeQueueSize: encoder?.encodeQueueSize ?? 0,
    framesProcessed: framesEncodedThisInterval,
    avgEncodeMs: encodeCallCount > 0 ? encodeTotalMs / encodeCallCount : 0,
  };
}

/**
 *
 */
function resetCustomCounters(): void {
  framesEncodedThisInterval = 0;
  encodeTotalMs = 0;
  encodeCallCount = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flushes any remaining samples, encoder buffer, and queued frames.
 */
function flushRemaining(): void {
  // Flush partial frame
  if (frameBuffer && frameOffset > 0 && encoder && s.socket?.readyState === WebSocket.OPEN) {
    const encoded = encoder.encode(frameBuffer.subarray(0, frameOffset));
    if (encoded) {
      s.socket.send(encoded);
    }
    frameOffset = 0;
  }

  // Flush encoder buffer
  if (encoder && s.socket?.readyState === WebSocket.OPEN) {
    const final = encoder.flush();
    if (final) {
      s.socket.send(final);
    }
  }

  // Flush queued frames
  flushQueuedFrames(s);
}

/**
 * Cleans up all resources.
 */
function cleanup(): void {
  running = false;

  flushRemaining();
  cleanupSharedState(s);

  if (encoder) {
    encoder.close();
    encoder = null;
  }

  // Reset ramp state
  needsRampIn = false;
  lastSamples = null;
  rampSamples = 0;
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
      sampleRate,
      encoderConfig,
      wsUrl,
    } = msg;

    try {
      if ((size & (size - 1)) !== 0 || mask !== size - 1) {
        throw new Error('Invalid ring buffer configuration (size must be power of two)');
      }

      // Initialize ring buffer views
      control = new Int32Array(sab, 0, headerSize);
      buffer = new Float32Array(sab, DATA_BYTE_OFFSET);
      bufferSize = size;
      bufferMask = mask;

      // Calculate codec-aware frame size
      const optimalFrameSamples = getOptimalFrameSizeSamples(
        encoderConfig.codec,
        sampleRate,
        encoderConfig.frameDurationMs ?? FRAME_DURATION_MS_DEFAULT,
      );
      frameSizeSamples = optimalFrameSamples * encoderConfig.channels;
      frameBuffer = new Float32Array(frameSizeSamples);
      frameOffset = 0;

      // Initialize underflow ramp state
      const rampSamplesPerChannel = Math.floor(sampleRate * (RAMP_MS / 1000));
      rampSamples = Math.min(rampSamplesPerChannel * encoderConfig.channels, frameSizeSamples);
      lastSamples = new Float32Array(encoderConfig.channels);
      needsRampIn = false;

      // Compute frame timing for pacing
      framePeriodMs = frameSizeToMs(optimalFrameSamples, sampleRate);
      maxDriftMs = framePeriodMs * 6;

      // Update encoderConfig with frame size for server handshake
      const configWithFrameSize: EncoderConfig = {
        ...encoderConfig,
        frameSizeSamples: optimalFrameSamples,
      };

      s.log.info(
        `Frame size: ${optimalFrameSamples} samples (${framePeriodMs.toFixed(1)}ms) for ${encoderConfig.codec}`,
      );

      // Initialize streaming policy from latency mode
      s.policy = getStreamingPolicy(encoderConfig.latencyMode);
      s.log.info(
        `Streaming policy: ${encoderConfig.latencyMode} mode ` +
          `(catchUp=${s.policy.catchUpMaxMs ?? 'disabled'}, dropOnBackpressure=${s.policy.dropOnBackpressure})`,
      );

      // Reset state
      resetStatsCounters(s);
      nextFrameDueTime = 0;
      framesEncodedThisInterval = 0;
      encodeTotalMs = 0;
      encodeCallCount = 0;
      resetFrameQueueState(s);

      // Compute catch-up thresholds
      const samplesPerMs = (sampleRate * encoderConfig.channels) / 1000;
      catchUpTargetSamples = Math.floor(s.policy.catchUpTargetMs * samplesPerMs);
      catchUpMaxSamples =
        s.policy.catchUpMaxMs !== null
          ? Math.floor(s.policy.catchUpMaxMs * samplesPerMs)
          : Infinity;

      // Create encoder
      s.log.info(`Creating encoder: ${encoderConfig.codec} @ ${encoderConfig.bitrate}kbps`);
      encoder = await createEncoder(configWithFrameSize);

      // Connect WebSocket
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
