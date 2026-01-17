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
import type { AudioCodec, EncoderConfig, StreamMetadata, WsMessage } from '@thaumic-cast/protocol';
import { WsMessageSchema, getStreamingPolicy, type StreamingPolicy } from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';
import { exponentialBackoff } from '../lib/backoff';

const log = createLogger('AudioWorker');

// ─────────────────────────────────────────────────────────────────────────────
// Codec-Aware Frame Sizing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the optimal frame size in samples for a given codec and sample rate.
 * Frame size is codec-aware for optimal efficiency:
 * - AAC: 1024 samples (spec-mandated per ISO/IEC 14496-3)
 * - FLAC: 4096 samples (larger frames improve compression ratio)
 * - Vorbis: 2048 samples (good balance for VBR encoding)
 * - PCM: 10ms worth of samples (low latency for real-time streaming)
 *
 * Frame duration varies by sample rate (e.g., AAC 1024 samples = 21ms at 48kHz, 128ms at 8kHz).
 * Server limits: MIN_FRAME_DURATION_MS=5, MAX_FRAME_DURATION_MS=150.
 * See packages/thaumic-core/src/protocol_constants.rs for Rust-side constants.
 *
 * @param codec - The audio codec
 * @param sampleRate - The sample rate in Hz
 * @returns Frame size in samples (mono frames, multiply by channels for interleaved)
 */
function getOptimalFrameSizeSamples(codec: AudioCodec, sampleRate: number): number {
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
      // PCM: prioritize low latency with 10ms frames
      return Math.round(sampleRate * 0.01);
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
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Time budget for processing frames per wake cycle (ms).
 * Stay under typical browser timer quantum (~4ms) to avoid timer coalescing issues.
 * Per web.dev/articles/audio-scheduling: setTimeout can be skewed by 10ms+ from
 * layout, rendering, and GC, so we busy-poll within budget instead.
 */
const PROCESS_BUDGET_MS = 4;

/** Initial backpressure backoff delay (ms). */
const BACKPRESSURE_BACKOFF_INITIAL_MS = 5;

/** Maximum backpressure backoff delay for realtime mode (ms). */
const BACKPRESSURE_BACKOFF_MAX_MS = 40;

/** Maximum backpressure backoff delay for quality mode (ms). */
const QUALITY_BACKOFF_MAX_MS = 50;

/** Timeout for waiting on producer (ms). Triggers underflow if exceeded. 200ms = 20 frames of headroom. */
const WAIT_TIMEOUT_MS = 200;

/** Interval for posting diagnostic stats to main thread (ms). */
const STATS_INTERVAL_MS = 2000;

/** Heartbeat interval for WebSocket (ms). */
const HEARTBEAT_INTERVAL_MS = 5000;

/** WebSocket connection timeout (ms). */
const WS_CONNECT_TIMEOUT_MS = 5000;

/** Handshake timeout (ms). */
const HANDSHAKE_TIMEOUT_MS = 5000;

// ─────────────────────────────────────────────────────────────────────────────
// Message Types
// ─────────────────────────────────────────────────────────────────────────────

/** Message types received from main thread. */
interface InitMessage {
  type: 'INIT';
  sab: SharedArrayBuffer;
  bufferSize: number;
  bufferMask: number;
  headerSize: number;
  sampleRate: number;
  encoderConfig: EncoderConfig;
  wsUrl: string;
}

interface StopMessage {
  type: 'STOP';
}

interface StartPlaybackMessage {
  type: 'START_PLAYBACK';
  speakerIps: string[];
  metadata?: StreamMetadata;
}

interface MetadataUpdateMessage {
  type: 'METADATA_UPDATE';
  metadata: StreamMetadata;
}

type InboundMessage = InitMessage | StopMessage | StartPlaybackMessage | MetadataUpdateMessage;

/** Message types sent to main thread. */
interface ReadyMessage {
  type: 'READY';
}

interface ConnectedMessage {
  type: 'CONNECTED';
  streamId: string;
}

interface DisconnectedMessage {
  type: 'DISCONNECTED';
  reason: string;
}

interface ErrorMessage {
  type: 'ERROR';
  message: string;
}

interface StreamReadyMessage {
  type: 'STREAM_READY';
  bufferSize: number;
}

interface PlaybackStartedMessage {
  type: 'PLAYBACK_STARTED';
  speakerIp: string;
  streamUrl: string;
}

interface PlaybackResultsMessage {
  type: 'PLAYBACK_RESULTS';
  results: Array<{
    speakerIp: string;
    success: boolean;
    streamUrl?: string;
    error?: string;
  }>;
}

interface PlaybackErrorMessage {
  type: 'PLAYBACK_ERROR';
  message: string;
}

interface StatsMessage {
  type: 'STATS';
  underflows: number;
  producerDroppedSamples: number; // Samples dropped by worklet (buffer full)
  consumerDroppedFrames: number; // Frames dropped by worker (backpressure)
  catchUpDroppedSamples: number; // Samples dropped by catch-up logic (bounded latency)
  backpressureCycles: number; // Cycles where drain was skipped due to backpressure
  wakeups: number;
  avgSamplesPerWake: number;
  encodeQueueSize: number;
  wsBufferedAmount: number;
}

type OutboundMessage =
  | ReadyMessage
  | ConnectedMessage
  | DisconnectedMessage
  | ErrorMessage
  | StreamReadyMessage
  | PlaybackStartedMessage
  | PlaybackResultsMessage
  | PlaybackErrorMessage
  | StatsMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Worker State
// ─────────────────────────────────────────────────────────────────────────────

// Streaming policy (derived from latencyMode)
let policy: StreamingPolicy | null = null;

// Pause state for quality mode backpressure handling
let isPaused = false;
let pauseStartTime = 0;

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

// Encoder and WebSocket
let encoder: AudioEncoder | null = null;
let socket: WebSocket | null = null;
let streamId: string | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

// Diagnostic counters
let underflowCount = 0;
let droppedFrameCount = 0;
let wakeupCount = 0;
let totalSamplesRead = 0;
let lastStatsTime = 0;
/** Last reported value of CTRL_DROPPED_SAMPLES for computing delta. */
let lastProducerDroppedSamples = 0;

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

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Posts a message to the main thread.
 * @param message
 */
function postToMain(message: OutboundMessage): void {
  self.postMessage(message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bounded Latency Catch-up
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aligns a sample count down to the nearest frame boundary.
 * @param samples - Number of samples
 * @param frameSize - Frame size in samples
 * @returns Aligned sample count
 */
function alignDown(samples: number, frameSize: number): number {
  return Math.floor(samples / frameSize) * frameSize;
}

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
  if (!control || !encoder || !policy) return 0;

  // Quality mode: catch-up is disabled
  if (policy.catchUpMaxMs === null) return 0;

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
  log.warn(`⏩ CATCH-UP: Dropped ${droppedMs.toFixed(0)}ms of audio to bound latency`);

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
 * Encodes and sends the accumulated frame if complete.
 *
 * Backpressure handling depends on streaming policy:
 * - Realtime mode: drop frames to maintain timing
 * - Quality mode: frames are held (not dropped) - pause is handled by consumeLoop
 */
function flushFrameIfReady(): void {
  if (!frameBuffer || frameOffset < frameSizeSamples) return;
  if (!encoder || !socket || socket.readyState !== WebSocket.OPEN || !policy) return;

  // Check backpressure
  const isBackpressured =
    encoder.encodeQueueSize >= policy.maxEncodeQueue ||
    socket.bufferedAmount >= policy.wsBufferHighWater;

  if (isBackpressured) {
    if (policy.dropOnBackpressure) {
      // Realtime mode: drop frame to maintain timing
      droppedFrameCount++;

      // Advance encoder timestamp to avoid time compression when we resume
      // frameSizeSamples is interleaved samples, divide by channels for frame count
      encoder.advanceTimestamp(frameSizeSamples / encoder.config.channels);

      // Reset frame buffer - data already drained from ring buffer
      frameOffset = 0;
    }
    // Quality mode: keep frame data for later (don't reset frameOffset)
    // consumeLoop will pause and retry
    return;
  }

  // Encode the frame
  const encoded = encoder.encode(frameBuffer);
  if (encoded) {
    socket.send(encoded);
  }

  // Reset frame buffer for next accumulation
  frameOffset = 0;
}

/**
 * Posts diagnostic stats to main thread.
 */
function maybePostStats(): void {
  if (!control) return;

  const now = performance.now();
  if (now - lastStatsTime < STATS_INTERVAL_MS) return;

  // Compute producer dropped samples delta
  const totalDropped = Atomics.load(control, CTRL_DROPPED_SAMPLES);
  const producerDroppedSamples = (totalDropped - lastProducerDroppedSamples) >>> 0;
  lastProducerDroppedSamples = totalDropped;

  const avgSamplesPerWake = wakeupCount > 0 ? totalSamplesRead / wakeupCount : 0;

  postToMain({
    type: 'STATS',
    underflows: underflowCount,
    producerDroppedSamples,
    consumerDroppedFrames: droppedFrameCount,
    catchUpDroppedSamples,
    backpressureCycles,
    wakeups: wakeupCount,
    avgSamplesPerWake,
    encodeQueueSize: encoder?.encodeQueueSize ?? 0,
    wsBufferedAmount: socket?.bufferedAmount ?? 0,
  });

  // Reset interval counters
  underflowCount = 0;
  droppedFrameCount = 0;
  catchUpDroppedSamples = 0;
  backpressureCycles = 0;
  wakeupCount = 0;
  totalSamplesRead = 0;
  lastStatsTime = now;
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Connects to the WebSocket and performs handshake.
 * @param wsUrl - The WebSocket URL to connect to
 * @param encoderConfig - The encoder configuration for the stream
 * @returns A promise resolving to the stream ID
 */
async function connectWebSocket(wsUrl: string, encoderConfig: EncoderConfig): Promise<string> {
  return new Promise((resolve, reject) => {
    log.info(`Connecting to WebSocket: ${wsUrl}`);

    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    socket = ws;

    const connectTimeout = setTimeout(() => {
      ws.close();
      reject(new Error('WebSocket connection timeout'));
    }, WS_CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      clearTimeout(connectTimeout);
      log.info('WebSocket connected, sending handshake...');

      // Send handshake
      ws.send(
        JSON.stringify({
          type: 'HANDSHAKE',
          payload: { encoderConfig },
        }),
      );

      // Wait for handshake response
      const handshakeTimeout = setTimeout(() => {
        ws.close();
        reject(new Error('Handshake timeout'));
      }, HANDSHAKE_TIMEOUT_MS);

      // Handle clean close during handshake (overwritten by handleWsClose on success)
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
            streamId = message.payload.streamId;
            log.info(`Handshake complete, streamId: ${streamId}`);

            // Start heartbeat
            startHeartbeat();

            // Set up persistent message handler
            ws.onmessage = handleWsMessage;
            ws.onclose = handleWsClose;
            ws.onerror = handleWsError;

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
 * @param event
 */
function handleWsMessage(event: MessageEvent): void {
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
        // Heartbeat acknowledged, connection is alive
        break;

      case 'STREAM_READY':
        log.info(`Stream ready with ${message.payload.bufferSize} frames buffered`);
        postToMain({
          type: 'STREAM_READY',
          bufferSize: message.payload.bufferSize,
        });
        break;

      case 'PLAYBACK_STARTED':
        log.info(`Playback started on ${message.payload.speakerIp}`);
        postToMain({
          type: 'PLAYBACK_STARTED',
          speakerIp: message.payload.speakerIp,
          streamUrl: message.payload.streamUrl,
        });
        break;

      case 'PLAYBACK_RESULTS': {
        const results = message.payload.results;
        const successful = results.filter((r) => r.success).length;
        log.info(`Playback results: ${successful}/${results.length} speakers started`);
        postToMain({
          type: 'PLAYBACK_RESULTS',
          results,
        });
        break;
      }

      case 'PLAYBACK_ERROR':
        log.error(`Playback error: ${message.payload.message}`);
        postToMain({
          type: 'PLAYBACK_ERROR',
          message: message.payload.message,
        });
        break;

      case 'ERROR':
        log.error(`Server error: ${message.payload.message}`);
        postToMain({
          type: 'ERROR',
          message: message.payload.message,
        });
        break;

      default:
        // Ignore other message types
        break;
    }
  } catch {
    // Ignore parse errors
  }
}

/**
 * Handles WebSocket close.
 * @param event
 */
function handleWsClose(event: CloseEvent): void {
  log.warn(`WebSocket closed: ${event.code} ${event.reason}`);
  stopHeartbeat();
  postToMain({
    type: 'DISCONNECTED',
    reason: event.reason || `Code ${event.code}`,
  });
}

/**
 * Handles WebSocket errors.
 */
function handleWsError(): void {
  log.error('WebSocket error');
}

/**
 * Starts the heartbeat timer.
 */
function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'HEARTBEAT' }));
    }
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * Stops the heartbeat timer.
 */
function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

/**
 * Sends a message over WebSocket.
 * @param message - The message object to send
 * @returns True if the message was sent, false otherwise
 */
function sendWsMessage(message: object): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  socket.send(JSON.stringify(message));
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow Control Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks if the pipeline is backpressured.
 * Uses thresholds from the current streaming policy.
 * @returns True if encoder queue or WebSocket buffer is overloaded
 */
function isBackpressured(): boolean {
  if (!policy) return false;
  return (
    (encoder?.encodeQueueSize ?? 0) >= policy.maxEncodeQueue ||
    (socket?.bufferedAmount ?? 0) >= policy.wsBufferHighWater
  );
}

/**
 * Checks if encoding should be paused (quality mode only).
 * Implements hysteresis: pause at high water mark, resume at lower threshold.
 *
 * In realtime mode, this always returns false (drops instead of pausing).
 * In quality mode, pauses encoding until backpressure eases.
 *
 * @returns True if encoding should be paused
 */
function shouldPause(): boolean {
  if (!policy || policy.dropOnBackpressure) return false; // Realtime mode never pauses

  const encodeQueue = encoder?.encodeQueueSize ?? 0;
  const wsBuffer = socket?.bufferedAmount ?? 0;

  if (isPaused) {
    // Resume with hysteresis - need both conditions to clear
    if (encodeQueue < policy.maxEncodeQueue / 2 && wsBuffer < policy.wsBufferResumeThreshold) {
      isPaused = false;
      const duration = (performance.now() - pauseStartTime) / 1000;
      log.info(`Resumed after ${duration.toFixed(1)}s pause`);
      return false;
    }
    return true;
  } else {
    // Check if we should pause
    if (encodeQueue >= policy.maxEncodeQueue || wsBuffer >= policy.wsBufferHighWater) {
      isPaused = true;
      pauseStartTime = performance.now();
      log.warn(`PAUSED: encodeQueue=${encodeQueue}, wsBuffer=${wsBuffer}`);
      return true;
    }
    return false;
  }
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
 * @param ms - Milliseconds to wait (use 0 to just yield without delay)
 * @returns A promise that resolves after the delay
 */
function yieldMacrotask(ms: number): Promise<void> {
  if (ms === 0) {
    // Use MessageChannel for zero-delay yield - faster than setTimeout(0)
    return new Promise((resolve) => {
      yieldResolve = resolve;
      yieldChannel.port1.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drains frames from the ring buffer within a time budget.
 * Uses busy-polling to avoid timer coalescing issues with setTimeout.
 * Checks backpressure between frames to avoid overloading encoder/network.
 *
 * @returns Number of complete frames drained
 */
function drainWithTimeBudget(): number {
  let framesProcessed = 0;
  const budgetStart = performance.now();

  while (performance.now() - budgetStart < PROCESS_BUDGET_MS) {
    // Check backpressure before processing each frame
    if (isBackpressured()) break;

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

  lastStatsTime = performance.now();
  lastProducerDroppedSamples = Atomics.load(control, CTRL_DROPPED_SAMPLES);

  while (running) {
    // BOUNDED LATENCY (realtime mode only): Check if buffer has grown too large
    // Quality mode skips this - catch-up is disabled
    performCatchUpIfNeeded();

    // QUALITY MODE: Check if we should pause encoding
    // shouldPause() handles hysteresis for pause/resume transitions
    if (shouldPause()) {
      backpressureCycles++;
      consecutiveBackpressureCycles++;
      // Adaptive backoff: 5ms → 10ms → 20ms → 40ms → 50ms (capped)
      // Responds faster than fixed 100ms when backpressure clears quickly
      const backoffMs = exponentialBackoff(
        consecutiveBackpressureCycles,
        BACKPRESSURE_BACKOFF_INITIAL_MS,
        QUALITY_BACKOFF_MAX_MS,
      );
      maybePostStats();
      await yieldMacrotask(backoffMs);
      continue;
    }

    // REALTIME MODE: Check backpressure for adaptive backoff
    // Actual frame drops happen in flushFrameIfReady()
    if (isBackpressured()) {
      backpressureCycles++;
      consecutiveBackpressureCycles++;
      // Adaptive backoff: 5ms → 10ms → 20ms → 40ms (capped)
      // Pressure won't ease in 1ms, so back off to reduce CPU spinning
      const backoffMs = exponentialBackoff(
        consecutiveBackpressureCycles,
        BACKPRESSURE_BACKOFF_INITIAL_MS,
        BACKPRESSURE_BACKOFF_MAX_MS,
      );
      maybePostStats();
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

    maybePostStats();

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
      }
      // 'ok' = notified, 'not-equal' = value changed before wait
    }
    // Producer notified us on empty→non-empty transition
  }
}

/**
 * Flushes any remaining samples and encoder buffer.
 */
function flushRemaining(): void {
  // Flush partial frame
  if (frameBuffer && frameOffset > 0 && encoder && socket?.readyState === WebSocket.OPEN) {
    // subarray() returns a view, no copy needed
    const encoded = encoder.encode(frameBuffer.subarray(0, frameOffset));
    if (encoded) {
      socket.send(encoded);
    }
    frameOffset = 0;
  }

  // Flush encoder buffer
  if (encoder && socket?.readyState === WebSocket.OPEN) {
    const final = encoder.flush();
    if (final) {
      socket.send(final);
    }
  }
}

/**
 * Cleans up all resources.
 */
function cleanup(): void {
  running = false;

  flushRemaining();

  stopHeartbeat();

  if (encoder) {
    encoder.close();
    encoder = null;
  }

  if (socket) {
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.close();
    socket = null;
  }

  streamId = null;
  policy = null;
  isPaused = false;
  pauseStartTime = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message Handler
// ─────────────────────────────────────────────────────────────────────────────

self.onmessage = async (event: MessageEvent<InboundMessage>) => {
  const msg = event.data;

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

      // Calculate codec-aware frame size for optimal encoder efficiency
      const optimalFrameSamples = getOptimalFrameSizeSamples(encoderConfig.codec, sampleRate);
      frameSizeSamples = optimalFrameSamples * encoderConfig.channels;
      frameBuffer = new Float32Array(frameSizeSamples);
      frameOffset = 0;

      // Compute frame timing for pacing
      framePeriodMs = frameSizeToMs(optimalFrameSamples, sampleRate);
      maxDriftMs = framePeriodMs * 6; // Allow ~6 frames of burst catch-up

      // Update encoderConfig with computed frame duration for server handshake
      // Round to integer - server expects u32, and sub-millisecond precision isn't needed for scheduling
      const configWithFrameDuration: EncoderConfig = {
        ...encoderConfig,
        frameDurationMs: Math.round(framePeriodMs),
      };

      log.info(
        `Frame size: ${optimalFrameSamples} samples (${framePeriodMs.toFixed(1)}ms) for ${encoderConfig.codec}`,
      );

      // Initialize streaming policy from latency mode
      policy = getStreamingPolicy(encoderConfig.latencyMode);
      log.info(
        `Streaming policy: ${encoderConfig.latencyMode} mode ` +
          `(catchUp=${policy.catchUpMaxMs ?? 'disabled'}, dropOnBackpressure=${policy.dropOnBackpressure})`,
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
      lastProducerDroppedSamples = 0;
      isPaused = false;
      pauseStartTime = 0;

      // Compute catch-up thresholds based on policy and sample rate
      // These define the bounded latency window (only used in realtime mode)
      const samplesPerMs = (sampleRate * encoderConfig.channels) / 1000;
      catchUpTargetSamples = Math.floor(policy.catchUpTargetMs * samplesPerMs);
      catchUpMaxSamples =
        policy.catchUpMaxMs !== null ? Math.floor(policy.catchUpMaxMs * samplesPerMs) : Infinity; // Quality mode: effectively disable catch-up

      // Create encoder
      log.info(`Creating encoder: ${encoderConfig.codec} @ ${encoderConfig.bitrate}kbps`);
      encoder = await createEncoder(configWithFrameDuration);

      // Connect WebSocket (sends frame duration to server in handshake)
      const id = await connectWebSocket(wsUrl, configWithFrameDuration);

      running = true;
      postToMain({ type: 'CONNECTED', streamId: id });

      // Start consumption loop
      consumeLoop().catch((err) => {
        log.error('consumeLoop error:', err);
        postToMain({ type: 'ERROR', message: String(err) });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Initialization failed:', message);
      postToMain({ type: 'ERROR', message });
      cleanup();
    }
  }

  if (msg.type === 'STOP') {
    cleanup();
  }

  if (msg.type === 'START_PLAYBACK') {
    const { speakerIps, metadata } = msg;
    sendWsMessage({
      type: 'START_PLAYBACK',
      payload: { speakerIps, metadata },
    });
  }

  if (msg.type === 'METADATA_UPDATE') {
    sendWsMessage({
      type: 'METADATA_UPDATE',
      payload: msg.metadata,
    });
  }
};
