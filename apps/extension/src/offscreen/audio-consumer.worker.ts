/**
 * Audio Consumer Worker
 *
 * Consumes PCM samples from a SharedArrayBuffer ring buffer using Atomics.waitAsync()
 * for efficient, low-latency synchronization with the AudioWorklet producer.
 *
 * This replaces the main-thread setInterval polling approach to avoid jitter
 * and underflows caused by main thread blocking.
 */

// Re-export ring buffer constants for use in this isolated worker context.
// Workers can't import from main bundle, so we duplicate these values.
// Must match ring-buffer.ts and pcm-processor.ts.
import { CTRL_WRITE_IDX, CTRL_READ_IDX, CTRL_OVERFLOW, CTRL_DATA_SIGNAL } from './ring-buffer';

/** Frame duration in seconds (20ms). */
const FRAME_DURATION_SEC = 0.02;

/** Frame size in stereo samples, derived from sample rate on init. */
let frameSizeSamples = 0;

/** Interval for posting diagnostic stats to main thread (ms). */
const STATS_INTERVAL_MS = 1000;

/** Message types received from main thread. */
interface InitMessage {
  type: 'INIT';
  sab: SharedArrayBuffer;
  bufferSize: number;
  headerSize: number;
  sampleRate: number;
}

interface StopMessage {
  type: 'STOP';
}

type WorkerMessage = InitMessage | StopMessage;

/** Message types sent to main thread. */
interface SamplesMessage {
  type: 'SAMPLES';
  samples: Int16Array;
}

interface StatsMessage {
  type: 'STATS';
  underflows: number;
  overflows: number;
  wakeups: number;
  avgSamplesPerWake: number;
}

interface ReadyMessage {
  type: 'READY';
}

type OutboundMessage = SamplesMessage | StatsMessage | ReadyMessage;

// Worker state
let control: Int32Array | null = null;
let buffer: Int16Array | null = null;
let bufferSize = 0;
let running = false;

// Frame accumulation buffer
let frameBuffer: Int16Array | null = null;
let frameOffset = 0;

// Diagnostic counters
let underflowCount = 0;
let overflowCount = 0;
let wakeupCount = 0;
let totalSamplesRead = 0;
let lastStatsTime = 0;
let lastSignalValue = 0;

/**
 * Posts a message to the main thread.
 * Uses the structured clone algorithm with optional transferable objects.
 * @param message - The message to post
 * @param transfer - Optional transferable objects
 */
function postToMain(message: OutboundMessage, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    // Use options form for proper TypeScript typing in worker context
    (
      self as unknown as { postMessage(msg: unknown, opts?: { transfer?: Transferable[] }): void }
    ).postMessage(message, { transfer });
  } else {
    self.postMessage(message);
  }
}

/**
 * Reads available samples from the ring buffer.
 * @returns The number of samples read into the frame buffer, or 0 if none available
 */
function readFromRingBuffer(): number {
  if (!control || !buffer || !frameBuffer) return 0;

  const writeIdx = Atomics.load(control, CTRL_WRITE_IDX);
  const readIdx = Atomics.load(control, CTRL_READ_IDX);

  // Check for overflow flag
  if (Atomics.load(control, CTRL_OVERFLOW) === 1) {
    overflowCount++;
    Atomics.store(control, CTRL_OVERFLOW, 0);
  }

  // Calculate available samples
  let available: number;
  if (writeIdx >= readIdx) {
    available = writeIdx - readIdx;
  } else {
    available = bufferSize - readIdx + writeIdx;
  }

  if (available === 0) {
    return 0;
  }

  // Read samples into frame accumulation buffer
  let samplesRead = 0;
  let currentReadIdx = readIdx;

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
 * Sends accumulated frame to main thread if complete.
 */
function flushFrameIfReady(): void {
  if (!frameBuffer || frameOffset < frameSizeSamples) return;

  // Create a copy to transfer (original buffer will be reused)
  const frameCopy = new Int16Array(frameBuffer);
  postToMain({ type: 'SAMPLES', samples: frameCopy }, [frameCopy.buffer]);

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
  });

  // Reset counters for next interval
  underflowCount = 0;
  overflowCount = 0;
  wakeupCount = 0;
  totalSamplesRead = 0;
  lastStatsTime = now;
}

/**
 * Main consumption loop using Atomics.waitAsync().
 */
async function consumeLoop(): Promise<void> {
  if (!control) return;

  lastStatsTime = performance.now();
  lastSignalValue = Atomics.load(control, CTRL_DATA_SIGNAL);

  while (running) {
    // Wait for the signal to change (producer increments it after writing)
    const waitResult = Atomics.waitAsync(control, CTRL_DATA_SIGNAL, lastSignalValue);

    if (waitResult.async) {
      // Wait for the promise to resolve
      const result = await waitResult.value;

      if (!running) break;

      if (result === 'ok') {
        // Signal changed, read the new value
        lastSignalValue = Atomics.load(control, CTRL_DATA_SIGNAL);
        wakeupCount++;

        // Drain all available data (handles coalesced wakeups)
        let samplesThisWake = 0;
        while (true) {
          const samplesRead = readFromRingBuffer();
          if (samplesRead === 0) break;
          samplesThisWake += samplesRead;
          flushFrameIfReady();
        }

        if (samplesThisWake === 0) {
          underflowCount++;
        } else {
          totalSamplesRead += samplesThisWake;
        }

        // Post stats periodically
        maybePostStats();
      }
      // 'timed-out' shouldn't happen with no timeout, 'not-equal' means value changed
    } else {
      // Synchronous result (value already changed)
      lastSignalValue = Atomics.load(control, CTRL_DATA_SIGNAL);
      wakeupCount++;

      // Drain all available data (handles coalesced wakeups)
      let samplesThisWake = 0;
      while (true) {
        const samplesRead = readFromRingBuffer();
        if (samplesRead === 0) break;
        samplesThisWake += samplesRead;
        flushFrameIfReady();
      }

      if (samplesThisWake === 0) {
        underflowCount++;
      } else {
        totalSamplesRead += samplesThisWake;
      }

      maybePostStats();
    }
  }
}

/**
 * Flushes any remaining samples in the frame buffer (partial frame).
 */
function flushRemaining(): void {
  if (!frameBuffer || frameOffset === 0) return;

  // Send partial frame
  const partial = new Int16Array(frameBuffer.subarray(0, frameOffset));
  postToMain({ type: 'SAMPLES', samples: partial }, [partial.buffer]);
  frameOffset = 0;
}

/**
 * Message handler for worker.
 * @param event
 */
self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;

  if (msg.type === 'INIT') {
    const { sab, bufferSize: size, headerSize, sampleRate } = msg;

    control = new Int32Array(sab, 0, headerSize);
    buffer = new Int16Array(sab, headerSize * 4);
    bufferSize = size;

    // Calculate frame size from sample rate (20ms * sampleRate * 2 channels)
    frameSizeSamples = Math.round(sampleRate * FRAME_DURATION_SEC) * 2;

    // Initialize frame accumulation buffer
    frameBuffer = new Int16Array(frameSizeSamples);
    frameOffset = 0;

    // Reset state
    underflowCount = 0;
    overflowCount = 0;
    wakeupCount = 0;
    totalSamplesRead = 0;
    lastSignalValue = 0;
    running = true;

    postToMain({ type: 'READY' });

    // Start the consumption loop
    consumeLoop().catch((err) => {
      console.error('[AudioConsumer] consumeLoop error:', err);
    });
  }

  if (msg.type === 'STOP') {
    running = false;
    flushRemaining();
  }
};
