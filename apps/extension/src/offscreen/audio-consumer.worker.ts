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
import type { EncoderConfig, StreamMetadata, WsMessage } from '@thaumic-cast/protocol';
import { WsMessageSchema } from '@thaumic-cast/protocol';

/** Frame duration in seconds (20ms). */
const FRAME_DURATION_SEC = 0.02;

/** Maximum pending encode operations before dropping frames. */
const MAX_ENCODE_QUEUE = 3;

/** WebSocket buffer high water mark (512KB). Drop frames if exceeded. */
const WS_BUFFER_HIGH_WATER = 512000;

/** Macrotask yield duration (ms). Gives encoder thread CPU time. */
const YIELD_MS = 1;

/** Default frames per wake. 3 frames = ~60ms, balances latency vs CPU. */
const DEFAULT_FRAMES_PER_WAKE = 3;

/** Timeout for waiting on producer (ms). Triggers underflow if exceeded. */
const WAIT_TIMEOUT_MS = 100;

/** Interval for posting diagnostic stats to main thread (ms). */
const STATS_INTERVAL_MS = 1000;

/** Heartbeat interval for WebSocket (ms). */
const HEARTBEAT_INTERVAL_MS = 5000;

/** WebSocket connection timeout (ms). */
const WS_CONNECT_TIMEOUT_MS = 5000;

/** Handshake timeout (ms). */
const HANDSHAKE_TIMEOUT_MS = 5000;

// ─────────────────────────────────────────────────────────────────────────────
// Adaptive Latency (Thermostat) Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Window size for measuring dropped frames (ms). */
const THERMOSTAT_WINDOW_MS = 10000;

/** Threshold: downgrade to 'realtime' if this many frames dropped in window. */
const DOWNGRADE_THRESHOLD = 5;

/**
 * Threshold: upgrade back to 'quality' after this many consecutive stats
 * intervals (STATS_INTERVAL_MS) with no drops in the THERMOSTAT_WINDOW_MS.
 * With defaults: 3 consecutive 1-second checks where the 10-second window is clean.
 */
const UPGRADE_CLEAN_INTERVALS = 3;

/** Minimum time between mode switches to avoid oscillation (ms). */
const MODE_SWITCH_COOLDOWN_MS = 5000;

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
  speakerIp: string;
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

interface PlaybackErrorMessage {
  type: 'PLAYBACK_ERROR';
  message: string;
}

interface StatsMessage {
  type: 'STATS';
  underflows: number;
  producerDroppedSamples: number; // Samples dropped by worklet (buffer full)
  consumerDroppedFrames: number; // Frames dropped by worker (backpressure)
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
  | PlaybackErrorMessage
  | StatsMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Worker State
// ─────────────────────────────────────────────────────────────────────────────

// Ring buffer state
let control: Int32Array | null = null;
let buffer: Int16Array | null = null;
let bufferSize = 0;
let bufferMask = 0;
let running = false;

// Frame accumulation
let frameSizeSamples = 0;
let frameBuffer: Int16Array | null = null;
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

// Thermostat state (adaptive latency mode)
/** Timestamps of recent frame drops for rolling window analysis. */
let dropTimestamps: number[] = [];
/** Number of consecutive clean windows (no drops). */
let cleanWindowCount = 0;
/** Timestamp of last mode switch to enforce cooldown. */
let lastModeSwitchTime = 0;
/** Timestamp of last drop record (for rate-limiting to frame cadence). */
let lastDropRecordTime = 0;

// Backpressure tracking
/** Count of cycles where we skipped draining due to backpressure. */
let backpressureCycles = 0;

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

/**
 * Logs a message (forwarded to main thread for unified logging).
 * @param level
 * @param {...any} args
 */
function log(level: 'info' | 'warn' | 'error', ...args: unknown[]): void {
  const prefix = '[AudioWorker]';
  if (level === 'error') {
    console.error(prefix, ...args);
  } else if (level === 'warn') {
    console.warn(prefix, ...args);
  } else {
    console.info(prefix, ...args);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Adaptive Latency Thermostat
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum interval between drop records (frame cadence = 20ms). */
const DROP_RECORD_INTERVAL_MS = FRAME_DURATION_SEC * 1000;

/**
 * Records audio loss and evaluates whether to switch latency modes.
 * Rate-limited to frame cadence (max 1 record per 20ms) to prevent
 * rapid-fire calls from overwhelming the thermostat.
 */
function recordAudioLoss(): void {
  if (!encoder) return;

  const now = performance.now();

  // Rate-limit to frame cadence
  if (now - lastDropRecordTime < DROP_RECORD_INTERVAL_MS) {
    return;
  }
  lastDropRecordTime = now;

  dropTimestamps.push(now);

  // Reset clean window counter since we just had audio loss
  cleanWindowCount = 0;

  // Prune timestamps outside the window
  const windowStart = now - THERMOSTAT_WINDOW_MS;
  dropTimestamps = dropTimestamps.filter((t) => t >= windowStart);

  // Check if we should downgrade to realtime mode
  if (encoder.latencyMode === 'quality' && dropTimestamps.length >= DOWNGRADE_THRESHOLD) {
    // Enforce cooldown to prevent oscillation
    if (now - lastModeSwitchTime < MODE_SWITCH_COOLDOWN_MS) {
      return;
    }

    log(
      'warn',
      `⚡ THERMOSTAT: Downgrading to realtime mode ` +
        `(${dropTimestamps.length} drops in ${THERMOSTAT_WINDOW_MS / 1000}s window)`,
    );

    const flushed = encoder.reconfigure({ latencyMode: 'realtime' });
    if (flushed && socket?.readyState === WebSocket.OPEN) {
      socket.send(flushed);
    }

    lastModeSwitchTime = now;
    dropTimestamps = []; // Reset after mode switch
  }
}

/**
 * Evaluates whether to upgrade back to quality mode.
 * Called periodically (e.g., from stats reporting).
 */
function evaluateUpgrade(): void {
  if (!encoder || encoder.latencyMode !== 'realtime') return;

  const now = performance.now();

  // Enforce cooldown
  if (now - lastModeSwitchTime < MODE_SWITCH_COOLDOWN_MS) {
    return;
  }

  // Prune old timestamps
  const windowStart = now - THERMOSTAT_WINDOW_MS;
  dropTimestamps = dropTimestamps.filter((t) => t >= windowStart);

  // If no drops in this window, increment clean window counter
  if (dropTimestamps.length === 0) {
    cleanWindowCount++;

    if (cleanWindowCount >= UPGRADE_CLEAN_INTERVALS) {
      log(
        'info',
        `✨ THERMOSTAT: Upgrading to quality mode ` +
          `(${cleanWindowCount} clean windows, CPU recovered)`,
      );

      const flushed = encoder.reconfigure({ latencyMode: 'quality' });
      if (flushed && socket?.readyState === WebSocket.OPEN) {
        socket.send(flushed);
      }

      lastModeSwitchTime = now;
      cleanWindowCount = 0;
    }
  }
}

/**
 * Resets thermostat state. Called on initialization.
 */
function resetThermostat(): void {
  dropTimestamps = [];
  cleanWindowCount = 0;
  lastModeSwitchTime = 0;
  lastDropRecordTime = 0;
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
 * Implements backpressure by dropping frames when encoder queue or
 * WebSocket buffer is overloaded.
 */
function flushFrameIfReady(): void {
  if (!frameBuffer || frameOffset < frameSizeSamples) return;
  if (!encoder || !socket || socket.readyState !== WebSocket.OPEN) return;

  // Check backpressure before encoding
  if (
    encoder.encodeQueueSize >= MAX_ENCODE_QUEUE ||
    socket.bufferedAmount >= WS_BUFFER_HIGH_WATER
  ) {
    droppedFrameCount++;
    recordAudioLoss(); // Notify thermostat of consumer drop

    // Advance encoder timestamp to avoid time compression when we resume
    // frameSizeSamples is interleaved samples, divide by channels for frame count
    encoder.advanceTimestamp(frameSizeSamples / encoder.config.channels);

    // Reset frame buffer - data already drained from ring buffer
    frameOffset = 0;
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

  // Trigger thermostat on producer drops (audio loss at the source)
  if (producerDroppedSamples > 0) {
    recordAudioLoss();
  }

  const avgSamplesPerWake = wakeupCount > 0 ? totalSamplesRead / wakeupCount : 0;

  postToMain({
    type: 'STATS',
    underflows: underflowCount,
    producerDroppedSamples,
    consumerDroppedFrames: droppedFrameCount,
    backpressureCycles,
    wakeups: wakeupCount,
    avgSamplesPerWake,
    encodeQueueSize: encoder?.encodeQueueSize ?? 0,
    wsBufferedAmount: socket?.bufferedAmount ?? 0,
  });

  // Reset interval counters
  underflowCount = 0;
  droppedFrameCount = 0;
  backpressureCycles = 0;
  wakeupCount = 0;
  totalSamplesRead = 0;
  lastStatsTime = now;

  // Check if we can upgrade back to quality mode
  evaluateUpgrade();
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Connects to the WebSocket and performs handshake.
 * @param wsUrl
 * @param encoderConfig
 */
async function connectWebSocket(wsUrl: string, encoderConfig: EncoderConfig): Promise<string> {
  return new Promise((resolve, reject) => {
    log('info', `Connecting to WebSocket: ${wsUrl}`);

    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    socket = ws;

    const connectTimeout = setTimeout(() => {
      ws.close();
      reject(new Error('WebSocket connection timeout'));
    }, WS_CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      clearTimeout(connectTimeout);
      log('info', 'WebSocket connected, sending handshake...');

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
            log('info', `Handshake complete, streamId: ${streamId}`);

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
        log('info', `Stream ready with ${message.payload.bufferSize} frames buffered`);
        postToMain({
          type: 'STREAM_READY',
          bufferSize: message.payload.bufferSize,
        });
        break;

      case 'PLAYBACK_STARTED':
        log('info', `Playback started on ${message.payload.speakerIp}`);
        postToMain({
          type: 'PLAYBACK_STARTED',
          speakerIp: message.payload.speakerIp,
          streamUrl: message.payload.streamUrl,
        });
        break;

      case 'PLAYBACK_ERROR':
        log('error', `Playback error: ${message.payload.message}`);
        postToMain({
          type: 'PLAYBACK_ERROR',
          message: message.payload.message,
        });
        break;

      case 'ERROR':
        log('error', `Server error: ${message.payload.message}`);
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
  log('warn', `WebSocket closed: ${event.code} ${event.reason}`);
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
  log('error', 'WebSocket error');
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
 * @param message
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
 * @returns True if encoder queue or WebSocket buffer is overloaded
 */
function isBackpressured(): boolean {
  return (
    (encoder?.encodeQueueSize ?? 0) >= MAX_ENCODE_QUEUE ||
    (socket?.bufferedAmount ?? 0) >= WS_BUFFER_HIGH_WATER
  );
}

/**
 * Dynamically compute max frames based on backpressure.
 * Process fewer frames when encoder/network is struggling.
 * @returns Number of frames to process this wake cycle
 */
function getMaxFramesPerWake(): number {
  const queueSize = encoder?.encodeQueueSize ?? 0;
  const buffered = socket?.bufferedAmount ?? 0;

  // If encoder queue building up, process less per wake
  if (queueSize >= 2 || buffered >= WS_BUFFER_HIGH_WATER / 2) {
    return 1; // Minimal work, let encoder catch up
  }

  return DEFAULT_FRAMES_PER_WAKE;
}

/**
 * Yields to the macrotask queue via setTimeout.
 * Unlike microtasks (Promise.resolve), this actually yields CPU time.
 * @param ms - Milliseconds to wait
 */
function yieldMacrotask(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drains up to maxFrames complete frames from the ring buffer.
 * @param maxFrames - Maximum number of frames to drain
 * @returns Number of complete frames drained
 */
function drainWithLimit(maxFrames: number): number {
  let framesProcessed = 0;

  while (framesProcessed < maxFrames) {
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
 * Main consumption loop with backpressure-aware flow control.
 *
 * - If backpressured: skip reads entirely, letting the ring buffer fill
 *   and triggering producer-side drops naturally
 * - If data available: drain with bounded work, then yield via macrotask
 * - If buffer empty: wait on write index via Atomics.waitAsync
 */
async function consumeLoop(): Promise<void> {
  if (!control) return;

  lastStatsTime = performance.now();
  lastProducerDroppedSamples = Atomics.load(control, CTRL_DROPPED_SAMPLES);

  while (running) {
    // SHORT-CIRCUIT: If backpressured, don't drain - let buffer fill
    // This allows producer drops to kick in naturally
    // Note: We don't increment droppedFrameCount here - actual drops are
    // tracked in flushFrameIfReady() when we have a frame but can't encode it
    if (isBackpressured()) {
      backpressureCycles++;
      await yieldMacrotask(YIELD_MS);
      continue;
    }

    // Drain with bounded work per wake (dynamic based on backpressure)
    const framesThisWake = drainWithLimit(getMaxFramesPerWake());

    if (framesThisWake > 0) {
      wakeupCount++;
    }

    maybePostStats();

    // Check if buffer is empty
    const write = Atomics.load(control, CTRL_WRITE_IDX);
    const read = Atomics.load(control, CTRL_READ_IDX);
    const available = (write - read) >>> 0;

    if (available > 0) {
      // Data available - yield via macrotask to prevent encoder starvation
      // Microtasks don't yield CPU time; setTimeout(0) does
      await yieldMacrotask(YIELD_MS);
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
    const partial = new Int16Array(frameBuffer.subarray(0, frameOffset));
    const encoded = encoder.encode(partial);
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
      buffer = new Int16Array(sab, DATA_BYTE_OFFSET);
      bufferSize = size;
      bufferMask = mask;

      // Calculate frame size from sample rate and channels
      frameSizeSamples = Math.round(sampleRate * FRAME_DURATION_SEC) * encoderConfig.channels;
      frameBuffer = new Int16Array(frameSizeSamples);
      frameOffset = 0;

      // Reset state
      underflowCount = 0;
      droppedFrameCount = 0;
      backpressureCycles = 0;
      wakeupCount = 0;
      totalSamplesRead = 0;
      lastProducerDroppedSamples = 0;
      resetThermostat();

      // Create encoder
      log('info', `Creating encoder: ${encoderConfig.codec} @ ${encoderConfig.bitrate}kbps`);
      encoder = await createEncoder(encoderConfig);

      // Connect WebSocket
      const id = await connectWebSocket(wsUrl, encoderConfig);

      running = true;
      postToMain({ type: 'CONNECTED', streamId: id });

      // Start consumption loop
      consumeLoop().catch((err) => {
        log('error', 'consumeLoop error:', err);
        postToMain({ type: 'ERROR', message: String(err) });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('error', 'Initialization failed:', message);
      postToMain({ type: 'ERROR', message });
      cleanup();
    }
  }

  if (msg.type === 'STOP') {
    cleanup();
  }

  if (msg.type === 'START_PLAYBACK') {
    const { speakerIp, metadata } = msg;
    sendWsMessage({
      type: 'START_PLAYBACK',
      payload: { speakerIp, metadata },
    });
  }

  if (msg.type === 'METADATA_UPDATE') {
    sendWsMessage({
      type: 'METADATA_UPDATE',
      payload: msg.metadata,
    });
  }
};
