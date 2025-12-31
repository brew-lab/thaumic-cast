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

import { CTRL_WRITE_IDX, CTRL_READ_IDX, CTRL_OVERFLOW, CTRL_DATA_SIGNAL } from './ring-buffer';
import { createEncoder, type AudioEncoder } from './encoders';
import type { EncoderConfig, StreamMetadata, WsMessage } from '@thaumic-cast/protocol';
import { WsMessageSchema } from '@thaumic-cast/protocol';

/** Frame duration in seconds (20ms). */
const FRAME_DURATION_SEC = 0.02;

/** Number of frames for low watermark (40ms = 2 frames). Don't sleep if above this. */
const LOW_WATER_FRAMES = 2;

/** Target latency in frames (100ms = 5 frames). Used for overflow recovery. */
const TARGET_LATENCY_FRAMES = 5;

/** Interval for posting diagnostic stats to main thread (ms). */
const STATS_INTERVAL_MS = 1000;

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
  overflows: number;
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
let running = false;

// Frame accumulation
let frameSizeSamples = 0;
let frameBuffer: Int16Array | null = null;
let frameOffset = 0;

// Watermarks (computed from frame size)
let lowWaterSamples = 0;
let targetLatencySamples = 0;

// Encoder and WebSocket
let encoder: AudioEncoder | null = null;
let socket: WebSocket | null = null;
let streamId: string | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

// Diagnostic counters
let underflowCount = 0;
let overflowCount = 0;
let wakeupCount = 0;
let totalSamplesRead = 0;
let lastStatsTime = 0;
let lastSignalValue = 0;

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
// Ring Buffer Reading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the number of samples available in the ring buffer.
 * @returns Number of available samples
 */
function getAvailableSamples(): number {
  if (!control) return 0;

  const writeIdx = Atomics.load(control, CTRL_WRITE_IDX);
  const readIdx = Atomics.load(control, CTRL_READ_IDX);

  if (writeIdx >= readIdx) {
    return writeIdx - readIdx;
  }
  return bufferSize - readIdx + writeIdx;
}

/**
 * Reads available samples from the ring buffer into the frame buffer.
 * @returns The number of samples read, or 0 if none available
 */
function readFromRingBuffer(): number {
  if (!control || !buffer || !frameBuffer) return 0;

  let writeIdx = Atomics.load(control, CTRL_WRITE_IDX);
  let currentReadIdx = Atomics.load(control, CTRL_READ_IDX);

  // Check for overflow flag - perform decisive skip to target latency
  if (Atomics.load(control, CTRL_OVERFLOW) === 1) {
    Atomics.store(control, CTRL_OVERFLOW, 0);
    overflowCount++;

    // Calculate available samples
    let available: number;
    if (writeIdx >= currentReadIdx) {
      available = writeIdx - currentReadIdx;
    } else {
      available = bufferSize - currentReadIdx + writeIdx;
    }

    // Skip ahead to leave only targetLatencySamples in buffer
    if (available > targetLatencySamples) {
      const samplesToSkip = available - targetLatencySamples;
      currentReadIdx = (currentReadIdx + samplesToSkip) % bufferSize;
      Atomics.store(control, CTRL_READ_IDX, currentReadIdx);

      // Discard partial frame to start fresh
      frameOffset = 0;

      log('warn', `Overflow: skipped ${samplesToSkip} samples to reach target latency`);
    }

    // Re-read write index after skip (producer may have advanced)
    writeIdx = Atomics.load(control, CTRL_WRITE_IDX);
  }

  // Calculate available samples
  let available: number;
  if (writeIdx >= currentReadIdx) {
    available = writeIdx - currentReadIdx;
  } else {
    available = bufferSize - currentReadIdx + writeIdx;
  }

  if (available === 0) {
    return 0;
  }

  // Read samples into frame accumulation buffer
  let samplesRead = 0;

  while (available > 0 && frameOffset < frameSizeSamples) {
    const samplesToRead = Math.min(available, frameSizeSamples - frameOffset);

    // Handle wrap-around
    if (currentReadIdx + samplesToRead <= bufferSize) {
      frameBuffer.set(buffer.subarray(currentReadIdx, currentReadIdx + samplesToRead), frameOffset);
    } else {
      const firstPart = bufferSize - currentReadIdx;
      frameBuffer.set(buffer.subarray(currentReadIdx, bufferSize), frameOffset);
      frameBuffer.set(buffer.subarray(0, samplesToRead - firstPart), frameOffset + firstPart);
    }

    frameOffset += samplesToRead;
    samplesRead += samplesToRead;
    currentReadIdx = (currentReadIdx + samplesToRead) % bufferSize;
    available -= samplesToRead;
  }

  // Update read pointer
  Atomics.store(control, CTRL_READ_IDX, currentReadIdx);

  return samplesRead;
}

/**
 * Encodes and sends the accumulated frame if complete.
 */
function flushFrameIfReady(): void {
  if (!frameBuffer || frameOffset < frameSizeSamples) return;
  if (!encoder || !socket || socket.readyState !== WebSocket.OPEN) return;

  // Encode the frame
  const encoded = encoder.encode(frameBuffer);
  if (encoded && socket.bufferedAmount < 1024 * 1024) {
    socket.send(encoded);
  }

  // Reset frame buffer for next accumulation
  frameOffset = 0;
}

/**
 * Posts diagnostic stats to main thread.
 */
function maybePostStats(): void {
  const now = performance.now();
  if (now - lastStatsTime < STATS_INTERVAL_MS) return;

  const avgSamplesPerWake = wakeupCount > 0 ? totalSamplesRead / wakeupCount : 0;

  postToMain({
    type: 'STATS',
    underflows: underflowCount,
    overflows: overflowCount,
    wakeups: wakeupCount,
    avgSamplesPerWake,
    encodeQueueSize: encoder?.encodeQueueSize ?? 0,
    wsBufferedAmount: socket?.bufferedAmount ?? 0,
  });

  // Reset counters for next interval
  underflowCount = 0;
  overflowCount = 0;
  wakeupCount = 0;
  totalSamplesRead = 0;
  lastStatsTime = now;
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
// Main Consumption Loop
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main consumption loop using Atomics.waitAsync() with watermark-based flow control.
 *
 * Only sleeps when buffer drops below LOW_WATER threshold, avoiding unnecessary
 * wait/wake cycles when data is plentiful.
 */
async function consumeLoop(): Promise<void> {
  if (!control) return;

  lastStatsTime = performance.now();
  lastSignalValue = Atomics.load(control, CTRL_DATA_SIGNAL);

  while (running) {
    // Drain all available data
    let samplesThisWake = 0;
    while (true) {
      const samplesRead = readFromRingBuffer();
      if (samplesRead === 0) break;
      samplesThisWake += samplesRead;
      flushFrameIfReady();
    }

    if (samplesThisWake > 0) {
      totalSamplesRead += samplesThisWake;
      wakeupCount++;
    }

    maybePostStats();

    // Check if we should sleep or keep spinning
    const available = getAvailableSamples();
    if (available >= lowWaterSamples) {
      // Buffer still has data above LOW_WATER, don't sleep
      continue;
    }

    // Buffer is low, wait for more data
    lastSignalValue = Atomics.load(control, CTRL_DATA_SIGNAL);
    const waitResult = Atomics.waitAsync(control, CTRL_DATA_SIGNAL, lastSignalValue);

    if (waitResult.async) {
      const result = await waitResult.value;
      if (!running) break;
      if (result === 'ok') {
        lastSignalValue = Atomics.load(control, CTRL_DATA_SIGNAL);
      }
    } else {
      // Synchronous result (value already changed)
      lastSignalValue = Atomics.load(control, CTRL_DATA_SIGNAL);
    }
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
    const { sab, bufferSize: size, headerSize, sampleRate, encoderConfig, wsUrl } = msg;

    try {
      // Initialize ring buffer views
      control = new Int32Array(sab, 0, headerSize);
      buffer = new Int16Array(sab, headerSize * 4);
      bufferSize = size;

      // Calculate frame size from sample rate
      frameSizeSamples = Math.round(sampleRate * FRAME_DURATION_SEC) * 2;
      frameBuffer = new Int16Array(frameSizeSamples);
      frameOffset = 0;

      // Compute watermarks from frame size
      lowWaterSamples = frameSizeSamples * LOW_WATER_FRAMES;
      targetLatencySamples = frameSizeSamples * TARGET_LATENCY_FRAMES;

      // Reset state
      underflowCount = 0;
      overflowCount = 0;
      wakeupCount = 0;
      totalSamplesRead = 0;
      lastSignalValue = 0;

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
