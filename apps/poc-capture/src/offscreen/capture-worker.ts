/**
 * Capture Worker — Core Diagnostic Engine
 *
 * Consumes AudioData frames from a MediaStreamTrackProcessor ReadableStream,
 * extracts Float32 PCM, detects gaps/overlaps/zero-blocks, records timing,
 * and accumulates raw samples for WAV export.
 *
 * No encoding, no server, no concealment — pure capture and diagnostics.
 */

import type {
  OffscreenToWorkerMessage,
  WorkerToOffscreenMessage,
  CaptureStats,
  DiagnosticEvent,
  CaptureConfig,
} from '../lib/messages';

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let running = false;
let config: CaptureConfig | null = null;
let actualSampleRate = 48000;
let actualChannels = 2;

// PCM accumulation (Float32 interleaved)
let pcmChunks: Float32Array[] = [];
let totalPcmBytes = 0;
const MAX_PCM_BYTES = 230 * 1024 * 1024; // ~10 min at 48kHz stereo f32

// Event log
const events: DiagnosticEvent[] = [];

// Per-frame timing (inter-read deltas in ms)
const timingDeltas: number[] = [];
let lastReadTime = 0;

// Pre-allocated temp buffers — sized on first frame, reused thereafter
let ch0Temp: Float32Array | null = null;
let ch1Temp: Float32Array | null = null;
let interleaveBuffer: Float32Array | null = null;
let allocatedFrameSize = 0;

// Gap detection
let expectedNextTimestamp = -1;
let recentEnergy = 0;
/** Cumulative per-channel samples written to PCM so far. */
let totalSamplesWritten = 0;

// Aggregate stats
let totalFrames = 0;
let totalDurationUs = 0;
let gapCount = 0;
let totalGapUs = 0;
let zeroBlockCount = 0;
let frameDurationMinMs = Infinity;
let frameDurationMaxMs = 0;
let frameDurationSumMs = 0;
let frameSizeMin = Infinity;
let frameSizeMax = 0;
let processingTimeSumUs = 0;
let processingTimeMaxUs = 0;
let captureStartTime = 0;
let lastStatsTime = 0;
let loggedFirstFrame = false;

/** Energy threshold for zero-block detection. */
const ZERO_BLOCK_ENERGY_THRESHOLD = 1e-10;
/** EMA alpha for energy tracking. */
const ENERGY_ALPHA = 0.1;
/** Minimum gap duration in µs to report. */
const GAP_THRESHOLD_US = 100;

/** Guards against double finishAndTransfer() calls. */
let finished = false;

// ─────────────────────────────────────────────────────────────────────────────
// Buffer Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensures temp buffers are large enough for the given per-channel frame count.
 * Re-allocates only if the frame size exceeds the current allocation.
 * @param numFrames - Number of per-channel samples needed
 */
function ensureTempBuffers(numFrames: number): void {
  if (numFrames <= allocatedFrameSize) return;

  console.debug(
    `[CaptureWorker] Frame size ${numFrames} exceeds allocation ${allocatedFrameSize}, re-allocating`,
  );
  allocatedFrameSize = numFrames;
  ch0Temp = new Float32Array(numFrames);
  ch1Temp = actualChannels >= 2 ? new Float32Array(numFrames) : null;
  interleaveBuffer = new Float32Array(numFrames * actualChannels);
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame Processing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Processes a single AudioData frame: gap detection, zero-block detection,
 * extraction, interleaving, and accumulation.
 * @param audioData - The AudioData frame from the MSTP ReadableStream
 * @param wallClockMs - Wall clock time relative to capture start (ms)
 */
function processFrame(audioData: AudioData, wallClockMs: number): void {
  try {
    const numFrames = audioData.numberOfFrames;
    if (numFrames === 0) return;

    // First-frame diagnostics
    if (!loggedFirstFrame) {
      loggedFirstFrame = true;
      console.log(
        `[CaptureWorker] First AudioData: format=${audioData.format} frames=${numFrames} ` +
          `channels=${audioData.numberOfChannels} sampleRate=${audioData.sampleRate} ` +
          `duration=${audioData.duration}us timestamp=${audioData.timestamp}`,
      );
      actualSampleRate = audioData.sampleRate;
      actualChannels = audioData.numberOfChannels;
    }

    // Track frame size stats
    if (numFrames < frameSizeMin) frameSizeMin = numFrames;
    if (numFrames > frameSizeMax) frameSizeMax = numFrames;

    // Track frame duration (from AudioData.duration in µs)
    const frameDurMs = audioData.duration / 1000;
    if (frameDurMs < frameDurationMinMs) frameDurationMinMs = frameDurMs;
    if (frameDurMs > frameDurationMaxMs) frameDurationMaxMs = frameDurMs;
    frameDurationSumMs += frameDurMs;
    totalDurationUs += audioData.duration;

    // ─── Gap / Overlap Detection ──────────────────────────────────────
    const ts = audioData.timestamp;
    const dur = audioData.duration;
    if (expectedNextTimestamp >= 0) {
      const gap = ts - expectedNextTimestamp;
      if (gap > GAP_THRESHOLD_US) {
        gapCount++;
        totalGapUs += gap;
        events.push({
          type: 'gap',
          wallClockMs,
          frameIndex: totalFrames,
          sampleOffset: totalSamplesWritten,
          durationUs: gap,
          expectedTimestamp: expectedNextTimestamp,
          actualTimestamp: ts,
        });
        console.warn(
          `[CaptureWorker] Gap: ${(gap / 1000).toFixed(1)}ms at frame ${totalFrames} ` +
            `(expected ts=${expectedNextTimestamp}us, got ${ts}us)`,
        );
      } else if (gap < -GAP_THRESHOLD_US) {
        events.push({
          type: 'overlap',
          wallClockMs,
          frameIndex: totalFrames,
          sampleOffset: totalSamplesWritten,
          durationUs: gap,
          expectedTimestamp: expectedNextTimestamp,
          actualTimestamp: ts,
        });
        console.warn(
          `[CaptureWorker] Overlap: ${(-gap / 1000).toFixed(1)}ms at frame ${totalFrames}`,
        );
      }
    }
    expectedNextTimestamp = ts + dur;

    // ─── Extract f32-planar channels ──────────────────────────────────
    ensureTempBuffers(numFrames);
    audioData.copyTo(ch0Temp!, { planeIndex: 0 });
    if (actualChannels >= 2) {
      audioData.copyTo(ch1Temp!, { planeIndex: 1 });
    }

    // ─── Zero-block detection (both channels) ─────────────────────────
    let frameEnergy = 0;
    for (let i = 0; i < numFrames; i++) {
      const s0 = ch0Temp![i]!;
      frameEnergy += s0 * s0;
    }
    if (actualChannels >= 2 && ch1Temp) {
      for (let i = 0; i < numFrames; i++) {
        const s1 = ch1Temp[i]!;
        frameEnergy += s1 * s1;
      }
      frameEnergy /= numFrames * 2;
    } else {
      frameEnergy /= numFrames;
    }

    if (
      frameEnergy < ZERO_BLOCK_ENERGY_THRESHOLD &&
      recentEnergy > ZERO_BLOCK_ENERGY_THRESHOLD * 100
    ) {
      zeroBlockCount++;
      events.push({
        type: 'zero_block',
        wallClockMs,
        frameIndex: totalFrames,
        sampleOffset: totalSamplesWritten,
        durationUs: dur,
        expectedTimestamp: ts,
        actualTimestamp: ts,
      });
    }

    recentEnergy = recentEnergy * (1 - ENERGY_ALPHA) + frameEnergy * ENERGY_ALPHA;

    // ─── Interleave and accumulate ────────────────────────────────────
    const interleavedCount = numFrames * actualChannels;
    for (let i = 0; i < numFrames; i++) {
      const s0 = ch0Temp![i]!;
      interleaveBuffer![i * actualChannels] = Math.max(-1, Math.min(1, s0 || 0));
      if (actualChannels >= 2 && ch1Temp) {
        const s1 = ch1Temp[i]!;
        interleaveBuffer![i * actualChannels + 1] = Math.max(-1, Math.min(1, s1 || 0));
      }
    }

    // Accumulate if under size limit
    const chunkBytes = interleavedCount * Float32Array.BYTES_PER_ELEMENT;
    if (totalPcmBytes + chunkBytes <= MAX_PCM_BYTES) {
      const chunk = new Float32Array(interleavedCount);
      chunk.set(interleaveBuffer!.subarray(0, interleavedCount));
      pcmChunks.push(chunk);
      totalPcmBytes += chunkBytes;
    }

    totalSamplesWritten += numFrames;
    totalFrames++;
  } finally {
    audioData.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Updates processing time statistics.
 * @param processingTimeUs - Time spent processing the frame in microseconds
 */
function updateProcessingStats(processingTimeUs: number): void {
  processingTimeSumUs += processingTimeUs;
  if (processingTimeUs > processingTimeMaxUs) {
    processingTimeMaxUs = processingTimeUs;
  }
}

/**
 * Builds the current CaptureStats snapshot.
 * @returns Current stats
 */
function buildStats(): CaptureStats {
  const elapsedSec = (performance.now() - captureStartTime) / 1000;
  return {
    totalFrames,
    totalDurationSec: totalDurationUs / 1_000_000,
    gapCount,
    totalGapMs: totalGapUs / 1000,
    zeroBlockCount,
    frameDurationMinMs: frameDurationMinMs === Infinity ? 0 : frameDurationMinMs,
    frameDurationMaxMs,
    frameDurationAvgMs: totalFrames > 0 ? frameDurationSumMs / totalFrames : 0,
    frameSizeMin: frameSizeMin === Infinity ? 0 : frameSizeMin,
    frameSizeMax,
    processingTimeAvgUs: totalFrames > 0 ? processingTimeSumUs / totalFrames : 0,
    processingTimeMaxUs,
    actualSampleRate,
    actualChannels,
    accumulatedBytes: totalPcmBytes,
    elapsedSec,
  };
}

/**
 * Posts stats to the offscreen main thread if >= 1 second has elapsed.
 */
function maybePostStats(): void {
  const now = performance.now();
  if (now - lastStatsTime < 1000) return;
  lastStatsTime = now;

  const msg: WorkerToOffscreenMessage = { type: 'STATS', stats: buildStats() };
  self.postMessage(msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// Consumption Loop
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main MSTP consumption loop. Reads AudioData frames from the transferred
 * ReadableStream and processes each one.
 * @param reader - The ReadableStream reader for AudioData frames
 */
async function consumeLoop(reader: ReadableStreamDefaultReader<AudioData>): Promise<void> {
  captureStartTime = performance.now();
  lastReadTime = captureStartTime;
  lastStatsTime = captureStartTime;

  while (running) {
    const { value: audioData, done } = await reader.read();
    const readTime = performance.now();
    if (done || !running) {
      audioData?.close();
      break;
    }

    // Record inter-read timing delta
    timingDeltas.push(readTime - lastReadTime);
    lastReadTime = readTime;

    const t0 = performance.now();
    processFrame(audioData, readTime - captureStartTime);
    const processingUs = (performance.now() - t0) * 1000;
    updateProcessingStats(processingUs);
    maybePostStats();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stop and Transfer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Concatenates all PCM chunks into a single ArrayBuffer and posts
 * the complete capture data to the offscreen thread.
 *
 * Guarded by `finished` flag to prevent double-call from the STOP handler
 * and consumeLoop's finally block racing.
 */
function finishAndTransfer(): void {
  if (finished) return;
  finished = true;

  // Concatenate PCM chunks
  const totalSamples = pcmChunks.reduce((sum, c) => sum + c.length, 0);
  const pcmCombined = new Float32Array(totalSamples);
  let offset = 0;
  for (const chunk of pcmChunks) {
    pcmCombined.set(chunk, offset);
    offset += chunk.length;
  }

  // Convert timing deltas to Float32Array
  const timingArray = new Float32Array(timingDeltas);

  const msg: WorkerToOffscreenMessage = {
    type: 'CAPTURE_COMPLETE',
    pcm: pcmCombined.buffer,
    events: [...events],
    timingDeltas: timingArray.buffer,
    sampleRate: actualSampleRate,
    channels: actualChannels,
  };

  self.postMessage(msg, {
    transfer: [pcmCombined.buffer, timingArray.buffer],
  });

  // Clear state
  pcmChunks = [];
  totalPcmBytes = 0;
  events.length = 0;
  timingDeltas.length = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message Handler
// ─────────────────────────────────────────────────────────────────────────────

let activeReader: ReadableStreamDefaultReader<AudioData> | null = null;

self.onmessage = (event: MessageEvent<OffscreenToWorkerMessage>) => {
  const msg = event.data;

  if (msg.type === 'INIT') {
    config = msg.config;
    actualSampleRate = msg.actualSampleRate;
    actualChannels = msg.actualChannels;

    // Pre-allocate buffers (Chrome typically delivers ~480 samples at 48kHz)
    allocatedFrameSize = 1024;
    ch0Temp = new Float32Array(allocatedFrameSize);
    ch1Temp = actualChannels >= 2 ? new Float32Array(allocatedFrameSize) : null;
    interleaveBuffer = new Float32Array(allocatedFrameSize * actualChannels);

    // Reset all state
    pcmChunks = [];
    totalPcmBytes = 0;
    events.length = 0;
    timingDeltas.length = 0;
    totalFrames = 0;
    totalDurationUs = 0;
    gapCount = 0;
    totalGapUs = 0;
    zeroBlockCount = 0;
    frameDurationMinMs = Infinity;
    frameDurationMaxMs = 0;
    frameDurationSumMs = 0;
    frameSizeMin = Infinity;
    frameSizeMax = 0;
    processingTimeSumUs = 0;
    processingTimeMaxUs = 0;
    expectedNextTimestamp = -1;
    recentEnergy = 0;
    totalSamplesWritten = 0;
    loggedFirstFrame = false;
    finished = false;

    running = true;
    const readyMsg: WorkerToOffscreenMessage = { type: 'READY' };
    self.postMessage(readyMsg);

    activeReader = msg.readable.getReader();
    consumeLoop(activeReader)
      .catch((err) => {
        console.error('[CaptureWorker] consumeLoop error:', err);
      })
      .finally(() => {
        running = false;
        finishAndTransfer();
      });
  }

  if (msg.type === 'STOP') {
    if (!config) {
      console.warn('[CaptureWorker] STOP received before INIT');
      return;
    }
    running = false;
    if (activeReader) {
      activeReader.cancel().catch(() => {});
      activeReader = null;
    }
    // finishAndTransfer will be called by consumeLoop's finally block,
    // or here if the loop already exited. The `finished` guard prevents double-call.
    finishAndTransfer();
  }
};
