/**
 * Audio Consumer Worker
 *
 * Consumes PCM samples from a SharedArrayBuffer ring buffer, encodes them,
 * and sends them over WebSocket. This keeps the entire real-time audio path
 * off the main thread, eliminating jitter from main thread blocking.
 *
 * Architecture:
 *   AudioWorklet -> SharedArrayBuffer -> Worker (drain + encode + websocket send)
 *                                         |
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
  type CustomMetrics,
  createWorkerState,
  resetFrameQueueState,
  postToMain,
  alignDown,
  yieldMacrotask,
  isWsBackpressured,
  enqueueFrame,
  flushFrameQueue,
  flushQueuedFrames,
  maybePostStats,
  connectWebSocket,
  handleCommonMessage,
  cleanupSharedState,
  BACKPRESSURE_BACKOFF_INITIAL_MS,
  BACKPRESSURE_BACKOFF_MAX_MS,
  QUALITY_BACKOFF_MAX_MS,
  WAIT_TIMEOUT_MS,
} from './worker-base';

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
 * Frame duration varies by sample rate (e.g., AAC 1024 samples = 21ms at 48kHz, 128ms at 8kHz).
 * Server limits: MIN_FRAME_SIZE_SAMPLES=64, MAX_FRAME_SIZE_SAMPLES=8192.
 * See packages/thaumic-core/src/protocol_constants.rs for Rust-side constants.
 *
 * @param codec - The audio codec
 * @param sampleRate - The sample rate in Hz
 * @param frameDurationMs - Frame duration in milliseconds (10, 20, or 40). Currently only used for PCM.
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
      // AAC's native frame size is always 1024 samples (spec-mandated)
      return 1024;
    case 'flac':
      // Larger frames improve FLAC compression ratio
      return 4096;
    case 'vorbis':
      // Vorbis uses variable block sizes internally; 2048 is a good batching choice
      return 2048;
    case 'pcm':
    default:
      // PCM: configurable frame duration for balancing latency vs. stability
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
// Worker-Specific Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Time budget for processing frames per wake cycle (ms).
 * Stay under typical browser timer quantum (~4ms) to avoid timer coalescing issues.
 * Per web.dev/articles/audio-scheduling: setTimeout can be skewed by 10ms+ from
 * layout, rendering, and GC, so we busy-poll within budget instead.
 */
const PROCESS_BUDGET_MS = 4;

// ─────────────────────────────────────────────────────────────────────────────
// Underflow Ramp Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ramp duration in milliseconds for fade-in/fade-out on underflow.
 * Short ramp (3ms) smooths discontinuities without audible delay.
 */
const RAMP_MS = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Shared Worker State
// ─────────────────────────────────────────────────────────────────────────────

const s: WorkerState = createWorkerState('AudioWorker');

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

// Diagnostic counters (worker-specific, reset per stats interval)
let underflowCount = 0;
let droppedFrameCount = 0;
let wakeupCount = 0;
let totalSamplesRead = 0;

// Bounded latency catch-up tracking
/** Samples dropped by consumer catch-up logic this stats interval. */
let catchUpDroppedSamples = 0;

// Backpressure tracking
/** Count of cycles where we skipped draining due to backpressure. */
let backpressureCycles = 0;
/** Consecutive backpressure cycles for adaptive backoff calculation. */
let consecutiveBackpressureCycles = 0;

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
 * @param buffer - Interleaved Float32 samples to modify in-place
 * @param channels - Number of audio channels (1 or 2)
 * @param rampLen - Number of interleaved samples to ramp (clamped to buffer length)
 * @param fadeIn - True for fade-in (0->1), false for fade-out (1->0)
 * @param startSamples - Per-channel starting values for fade-out (ignored for fade-in)
 */
function applyRamp(
  buffer: Float32Array,
  channels: number,
  rampLen: number,
  fadeIn: boolean,
  startSamples?: Float32Array,
): void {
  const len = Math.min(rampLen, buffer.length);
  const frames = Math.floor(len / channels);
  if (frames === 0) return;

  // Divisor for interpolation: (frames-1) to span [0,1], minimum 1 to avoid division by zero
  const divisor = Math.max(frames - 1, 1);

  for (let frame = 0; frame < frames; frame++) {
    // Linear ramp coefficient:
    // Fade-in: 0->1 (first sample at silence, last at full amplitude)
    // Fade-out: 1->0 (first sample at full amplitude, last at silence)
    const t = fadeIn ? frame / divisor : 1 - frame / divisor;

    for (let ch = 0; ch < channels; ch++) {
      const idx = frame * channels + ch;
      if (fadeIn) {
        // Fade-in: scale sample toward full amplitude
        buffer[idx] *= t;
      } else {
        // Fade-out: interpolate from startSample toward zero
        const start = startSamples?.[ch] ?? 0;
        buffer[idx] = start * t;
      }
    }
  }
}

/**
 * Captures the last sample value per channel from an interleaved buffer.
 * Used to track the final amplitude for smooth ramp transitions.
 *
 * @param buffer - Interleaved Float32 samples
 * @param channels - Number of audio channels
 * @param length - Number of valid interleaved samples in buffer
 * @param target - Float32Array to store last samples (length >= channels)
 */
function captureLastSamples(
  buffer: Float32Array,
  channels: number,
  length: number,
  target: Float32Array,
): void {
  if (length < channels) return;
  const lastFrameStart = length - channels;
  for (let ch = 0; ch < channels; ch++) {
    target[ch] = buffer[lastFrameStart + ch] ?? 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bounded Latency Catch-up
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Performs catch-up if the ring buffer has accumulated too much data.
 * This bounds latency by dropping oldest audio when we fall behind.
 *
 * In quality mode (catchUpMaxMs === null), catch-up is disabled to prevent
 * any audio drops. In realtime mode, when buffer exceeds catchUpMaxMs, we:
 * 1. Advance readIdx to (writeIdx - targetSamples) aligned to frame boundaries
 * 2. Reset frameOffset to discard any partial frame
 * 3. Advance encoder timestamp to keep audio time monotonic
 * 4. Log the dropped duration for diagnostics
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
    return 0; // Buffer is within bounds
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
  // totalDroppedSamples is interleaved, so divide by channels for frame count
  const channels = encoder.config.channels;
  const droppedFrames = totalDroppedSamples / channels;
  encoder.advanceTimestamp(droppedFrames);

  // Track for stats
  catchUpDroppedSamples += totalDroppedSamples;

  // Log the event
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

  // Calculate available samples using unsigned subtraction
  let available = (writeIdx - currentReadIdx) >>> 0;

  if (available === 0) {
    return 0;
  }

  // Read samples into frame accumulation buffer
  let samplesRead = 0;

  while (available > 0 && frameOffset < frameSizeSamples) {
    const samplesToRead = Math.min(available, frameSizeSamples - frameOffset);

    // Buffer offset uses bitmask on monotonic index
    const readOffset = currentReadIdx & bufferMask;
    const endOffset = (currentReadIdx + samplesToRead) & bufferMask;

    // Handle wrap-around at buffer boundary.
    // When the read wraps around the buffer end, endOffset will be small
    // (wrapped to start), making readOffset > endOffset. This triggers
    // the two-part copy branch.
    if (readOffset < endOffset || samplesToRead === 0) {
      // No wrap: simple contiguous copy
      frameBuffer.set(buffer.subarray(readOffset, readOffset + samplesToRead), frameOffset);
    } else {
      // Wrap-around: copy in two parts
      const firstPart = bufferSize - readOffset;
      frameBuffer.set(buffer.subarray(readOffset, bufferSize), frameOffset);
      frameBuffer.set(buffer.subarray(0, samplesToRead - firstPart), frameOffset + firstPart);
    }

    frameOffset += samplesToRead;
    samplesRead += samplesToRead;
    // Monotonic index: just add, don't mask
    currentReadIdx = (currentReadIdx + samplesToRead) | 0;
    available -= samplesToRead;
  }

  // Update read pointer (monotonic, not wrapped)
  Atomics.store(control, CTRL_READ_IDX, currentReadIdx);

  return samplesRead;
}

/**
 * Handles underflow by flushing a partial frame with ramp-down to silence.
 *
 * When underflow occurs mid-frame (frameOffset > 0), this function:
 * 1. Captures the actual last samples from the partial frameBuffer
 * 2. Fills the remainder of the frame with a smooth ramp to zero
 * 3. Encodes and sends the frame
 * 4. Sets needsRampIn for smooth fade-in when audio resumes
 *
 * This prevents audible clicks at the point of underflow by smoothly
 * transitioning to silence rather than abruptly stopping.
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
    // No complete sample set in partial frame - just mark for ramp-in
    needsRampIn = true;
    return;
  }

  // Capture last samples from the actual partial frame into reusable buffer
  // This ensures continuity: ramp starts exactly where the audio stopped
  captureLastSamples(frameBuffer, channels, frameOffset, lastSamples);

  const remainingSamples = frameSizeSamples - frameOffset;
  const rampDownLen = Math.min(rampSamples, remainingSamples);

  // Apply fade-out ramp using shared utility (DRY)
  // subarray() returns a view, so applyRamp modifies frameBuffer in-place
  if (rampDownLen >= channels) {
    applyRamp(
      frameBuffer.subarray(frameOffset, frameOffset + rampDownLen),
      channels,
      rampDownLen,
      false, // fadeIn = false (fade-out)
      lastSamples,
    );
  }

  // Fill remainder with silence
  const silenceStart = frameOffset + rampDownLen;
  if (silenceStart < frameSizeSamples) {
    frameBuffer.fill(0, silenceStart, frameSizeSamples);
  }

  // Mark frame as complete
  frameOffset = frameSizeSamples;

  // Encode and send (skip backpressure check for underflow frame)
  const encoded = encoder.encode(frameBuffer);
  if (encoded) {
    s.socket.send(encoded);
  }

  // Reset for next frame
  frameOffset = 0;
  needsRampIn = true;

  s.log.debug('Flushed underflow frame with ramp-down');
}

/**
 * Encodes and sends/queues the accumulated frame if complete.
 *
 * Backpressure handling depends on streaming policy:
 * - Realtime mode: drop frames to maintain timing
 * - Quality mode: always encode, queue frames if WebSocket is backpressured
 *
 * Also handles recovery by applying fade-in ramp when resuming after:
 * - Underflow events (buffer empty)
 * - Producer drops (buffer full on worklet side)
 */
function flushFrameIfReady(): void {
  if (!frameBuffer || frameOffset < frameSizeSamples) return;
  if (!encoder || !s.socket || s.socket.readyState !== WebSocket.OPEN || !s.policy) return;

  const channels = encoder.config.channels;

  // Encoder backpressure blocks both modes (can't bypass encoder)
  const encoderBackpressured = encoder.encodeQueueSize >= s.policy.maxEncodeQueue;

  if (encoderBackpressured) {
    if (s.policy.dropOnBackpressure) {
      // Realtime mode: drop frame to maintain timing
      droppedFrameCount++;
      encoder.advanceTimestamp(frameSizeSamples / channels);
      frameOffset = 0;
    }
    // Quality mode: keep frame data for later (don't reset frameOffset)
    // consumeLoop will retry on next iteration
    return;
  }

  // Apply fade-in ramp if resuming after discontinuity (underflow or producer drop)
  if (needsRampIn && rampSamples >= channels) {
    applyRamp(frameBuffer, channels, rampSamples, true);
    needsRampIn = false;
    s.log.debug('Applied fade-in ramp after discontinuity');
  }

  // Encode the frame
  const encoded = encoder.encode(frameBuffer);

  // Reset frame buffer for next accumulation
  frameOffset = 0;

  if (!encoded) return;

  // WebSocket backpressure handling differs by mode
  const wsBackpressured = isWsBackpressured(s);

  if (wsBackpressured) {
    if (s.policy.dropOnBackpressure) {
      // Realtime mode: drop the encoded frame
      droppedFrameCount++;
    } else {
      // Quality mode: queue the frame instead of blocking ring buffer drain
      enqueueFrame(s, encoded);
    }
    return;
  }

  // No backpressure: send directly
  s.socket.send(encoded);
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom Metrics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns worker-specific metrics for stats reporting.
 */
function getCustomMetrics(): CustomMetrics {
  return {
    underflows: underflowCount,
    consumerDroppedFrames: droppedFrameCount,
    catchUpDroppedSamples,
    backpressureCycles,
    wakeups: wakeupCount,
    avgSamplesPerWake: wakeupCount > 0 ? totalSamplesRead / wakeupCount : 0,
    encodeQueueSize: encoder?.encodeQueueSize ?? 0,
  };
}

/**
 * Resets worker-specific interval counters after stats are posted.
 */
function resetCustomCounters(): void {
  underflowCount = 0;
  droppedFrameCount = 0;
  catchUpDroppedSamples = 0;
  backpressureCycles = 0;
  wakeupCount = 0;
  totalSamplesRead = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow Control
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks if the pipeline is backpressured.
 * Uses thresholds from the current streaming policy.
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
 * Drains frames from the ring buffer within a time budget.
 * Uses busy-polling to avoid timer coalescing issues with setTimeout.
 *
 * Backpressure handling differs by mode:
 * - Quality mode: only check encoder backpressure (WebSocket handled by frame queue)
 * - Realtime mode: check both encoder and WebSocket backpressure
 *
 * @returns Number of complete frames drained
 */
function drainWithTimeBudget(): number {
  let framesProcessed = 0;
  const budgetStart = performance.now();

  while (performance.now() - budgetStart < PROCESS_BUDGET_MS) {
    // Check backpressure before processing each frame
    // Quality mode: only block on encoder (WebSocket handled by frame queue)
    // Realtime mode: block on both encoder and WebSocket
    if (s.policy?.dropOnBackpressure) {
      if (isBackpressured()) break;
    } else {
      // Quality mode: only check encoder backpressure
      if (isEncoderBackpressured()) break;
    }

    const samplesRead = readFromRingBuffer();
    if (samplesRead === 0) break;

    totalSamplesRead += samplesRead;
    flushFrameIfReady();

    // frameOffset resets to 0 after flushing a complete frame
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
 * Uses performance.now() for rate control to pace frame production at ~20ms intervals,
 * preventing burst processing and smoothing encoder/network load. Avoids setTimeout
 * timer coalescing issues by busy-polling within a ~4ms time budget per wake cycle.
 *
 * Flow control varies by streaming policy:
 * - Quality mode: pause encoding on backpressure (no drops), resume with hysteresis
 * - Realtime mode: drop frames on backpressure, maintain bounded latency
 *
 * Common flow:
 * - If ahead of schedule: yield until next frame is due
 * - If data available: drain within time budget, update frame timing, yield thread
 * - If buffer empty: wait on write index via Atomics.waitAsync
 *
 * Drift handling:
 * - Allows burst catch-up of ~6 frames when recovering from stalls
 * - Clamps drift to prevent unbounded catch-up after long pauses
 */
async function consumeLoop(): Promise<void> {
  if (!control) return;

  s.lastStatsTime = performance.now();
  s.prevProducerDroppedSamples = Atomics.load(control, CTRL_DROPPED_SAMPLES);

  while (running) {
    // BOUNDED LATENCY (realtime mode only): Check if buffer has grown too large
    // Quality mode skips this - catch-up is disabled
    performCatchUpIfNeeded();

    // DETECT PRODUCER DROPS: Check if AudioWorklet dropped samples
    // This happens when ring buffer fills faster than we drain (rare in quality mode with frame queue)
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

    // BACKPRESSURE HANDLING: Differs by mode
    // Realtime mode: check encoder + WebSocket backpressure
    // Quality mode: only check encoder (WebSocket handled by frame queue)
    const shouldBackoff = s.policy?.dropOnBackpressure
      ? isBackpressured()
      : isEncoderBackpressured();

    if (shouldBackoff) {
      backpressureCycles++;
      consecutiveBackpressureCycles++;
      const maxMs = s.policy?.dropOnBackpressure
        ? BACKPRESSURE_BACKOFF_MAX_MS
        : QUALITY_BACKOFF_MAX_MS;
      const backoffMs = exponentialBackoff(
        consecutiveBackpressureCycles,
        BACKPRESSURE_BACKOFF_INITIAL_MS,
        maxMs,
      );
      maybePostStats(s, control, bufferSize, getCustomMetrics, resetCustomCounters);
      await yieldMacrotask(backoffMs);
      continue;
    }

    // Reset consecutive backpressure counter when pressure eases
    consecutiveBackpressureCycles = 0;

    // TIME-BASED PACING: Wait if we're ahead of schedule
    // This prevents burst processing and smooths encoder/network load
    const now = performance.now();
    if (nextFrameDueTime > 0 && now < nextFrameDueTime) {
      const waitTime = nextFrameDueTime - now;
      if (waitTime > 1) {
        await yieldMacrotask(waitTime);
      }
    }

    // Drain frames within time budget, checking backpressure between frames
    const framesThisWake = drainWithTimeBudget();

    if (framesThisWake > 0) {
      wakeupCount++;

      // Update frame due time for time-based pacing
      if (nextFrameDueTime === 0) {
        // First frame - initialize due time to now
        nextFrameDueTime = performance.now();
      }
      nextFrameDueTime += framesThisWake * framePeriodMs;

      // Clamp: don't let due time fall more than maxDriftMs behind wall clock
      // This allows burst catch-up but prevents unbounded drift accumulation
      const nowAfterDrain = performance.now();
      if (nextFrameDueTime < nowAfterDrain - maxDriftMs) {
        nextFrameDueTime = nowAfterDrain - maxDriftMs;
      }
    }

    maybePostStats(s, control, bufferSize, getCustomMetrics, resetCustomCounters);

    // Check if buffer is empty
    const write = Atomics.load(control, CTRL_WRITE_IDX);
    const read = Atomics.load(control, CTRL_READ_IDX);
    const available = (write - read) >>> 0;

    if (available > 0) {
      // Data available but we've exhausted our time budget
      // Just yield the thread (setTimeout(0)), time-based pacing handles the wait
      await yieldMacrotask(0);
      continue;
    }

    // Buffer empty - wait for producer to write (with timeout for underflow detection)
    const waitResult = Atomics.waitAsync(control, CTRL_WRITE_IDX, write, WAIT_TIMEOUT_MS);
    if (waitResult.async) {
      const result = await waitResult.value;
      if (!running) break;
      if (result === 'timed-out') {
        // Producer didn't write within timeout - underflow condition
        underflowCount++;
        // Flush partial frame with ramp-down and prepare for ramp-in on resume
        handleUnderflowRamp();
      }
      // 'ok' = notified, 'not-equal' = value changed before wait
    }
    // Producer notified us on empty->non-empty transition
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flushes any remaining samples, encoder buffer, and queued frames.
 */
function flushRemaining(): void {
  // Flush partial frame
  if (frameBuffer && frameOffset > 0 && encoder && s.socket?.readyState === WebSocket.OPEN) {
    // subarray() returns a view, no copy needed
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

  // Flush queued frames (quality mode may have buffered frames during backpressure)
  flushQueuedFrames(s);
}

/**
 * Cleans up all resources.
 */
function cleanup(): void {
  running = false;

  if (!s.browserCaptureMode) {
    flushRemaining();
  }

  if (!s.browserCaptureMode && encoder) {
    encoder.close();
    encoder = null;
  }

  cleanupSharedState(s);

  if (!s.browserCaptureMode) {
    // Reset audio-specific state
    needsRampIn = false;
    lastSamples = null;
    rampSamples = 0;
    resetFrameQueueState(s);
  }

  s.browserCaptureMode = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message Handler
// ─────────────────────────────────────────────────────────────────────────────

self.onmessage = async (event: MessageEvent<WorkerInboundMessage>) => {
  const msg = event.data;

  // Delegate common messages (STOP, START_PLAYBACK, METADATA_UPDATE)
  if (handleCommonMessage(s, msg, cleanup)) {
    return;
  }

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
      // Validate SAB fields are present (now optional in WorkerInitMessage for MSTP path)
      if (!sab || size === undefined || mask === undefined || headerSize === undefined) {
        throw new Error('SAB path requires sab, bufferSize, bufferMask, and headerSize');
      }

      if ((size & (size - 1)) !== 0 || mask !== size - 1) {
        throw new Error('Invalid ring buffer configuration (size must be power of two)');
      }

      // Initialize ring buffer views
      control = new Int32Array(sab, 0, headerSize);
      buffer = new Float32Array(sab, DATA_BYTE_OFFSET);
      bufferSize = size;
      bufferMask = mask;

      // Calculate codec-aware frame size for optimal encoder efficiency
      const optimalFrameSamples = getOptimalFrameSizeSamples(
        encoderConfig.codec,
        sampleRate,
        encoderConfig.frameDurationMs ?? FRAME_DURATION_MS_DEFAULT,
      );
      frameSizeSamples = optimalFrameSamples * encoderConfig.channels;
      frameBuffer = new Float32Array(frameSizeSamples);
      frameOffset = 0;

      // Initialize underflow ramp state
      // Ramp length clamped to fit within a single frame
      const rampSamplesPerChannel = Math.floor(sampleRate * (RAMP_MS / 1000));
      rampSamples = Math.min(rampSamplesPerChannel * encoderConfig.channels, frameSizeSamples);
      lastSamples = new Float32Array(encoderConfig.channels);
      needsRampIn = false;

      // Compute frame timing for pacing
      framePeriodMs = frameSizeToMs(optimalFrameSamples, sampleRate);
      maxDriftMs = framePeriodMs * 6; // Allow ~6 frames of burst catch-up

      // Update encoderConfig with frame size for server handshake
      // Send samples (integer) instead of duration (float) to avoid rounding errors
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
      underflowCount = 0;
      droppedFrameCount = 0;
      catchUpDroppedSamples = 0;
      backpressureCycles = 0;
      consecutiveBackpressureCycles = 0;
      nextFrameDueTime = 0;
      wakeupCount = 0;
      totalSamplesRead = 0;
      s.prevProducerDroppedSamples = 0;

      resetFrameQueueState(s);

      // Compute catch-up thresholds based on policy and sample rate
      // These define the bounded latency window (only used in realtime mode)
      const samplesPerMs = (sampleRate * encoderConfig.channels) / 1000;
      catchUpTargetSamples = Math.floor(s.policy.catchUpTargetMs * samplesPerMs);
      catchUpMaxSamples =
        s.policy.catchUpMaxMs !== null
          ? Math.floor(s.policy.catchUpMaxMs * samplesPerMs)
          : Infinity; // Quality mode: effectively disable catch-up

      // Create encoder
      s.log.info(`Creating encoder: ${encoderConfig.codec} @ ${encoderConfig.bitrate}kbps`);
      encoder = await createEncoder(configWithFrameSize);

      // Connect WebSocket (sends frame size to server in handshake)
      const id = await connectWebSocket(s, wsUrl, {
        type: 'HANDSHAKE',
        payload: { encoderConfig: configWithFrameSize },
      });

      running = true;
      s.streamStartTime = performance.now();
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

  if (msg.type === 'INIT_BROWSER_CAPTURE') {
    const { wsUrl, encoderConfig, browserName } = msg;
    try {
      s.browserCaptureMode = true;

      // No ring buffer, no encoder, no consumeLoop --
      // server captures audio via WASAPI, Worker just manages WS lifecycle
      const id = await connectWebSocket(s, wsUrl, {
        type: 'START_BROWSER_CAPTURE',
        payload: { browserName: browserName ?? null, encoderConfig },
      });

      running = true;
      s.streamStartTime = performance.now();
      postToMain({ type: 'CONNECTED', streamId: id });
      // Worker is now idle -- WS message handler + heartbeat do all the work
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      s.log.error('Browser capture init failed:', message);
      postToMain({ type: 'ERROR', message });
      cleanup();
    }
  }
};
