/**
 * Audio Relay Worker (MSTP path).
 *
 * Reads AudioData frames from a transferred ReadableStream, converts
 * f32-planar → interleaved Int16 with TPDF dither, and sends fixed-size
 * frames over WebSocket. Bypasses AudioContext to avoid the clock-domain
 * crossing that causes zero-filled blocks (crackling) in the SAB path.
 */

import {
  type WorkerState,
  type CustomMetrics,
  createWorkerState,
  connectWebSocket,
  maybePostStats,
  handleCommonMessage,
  cleanupSharedState,
  flushQueuedFrames,
  resetStatsCounters,
  resetFrameQueueState,
  postToMain,
  yieldMacrotask,
  enqueueFrame,
  flushFrameQueue,
  isWsBackpressured,
  BACKPRESSURE_BACKOFF_INITIAL_MS,
  BACKPRESSURE_BACKOFF_MAX_MS,
  QUALITY_BACKOFF_MAX_MS,
  FRAME_QUEUE_MAX_BYTES,
} from './worker-base';
import {
  getStreamingPolicy,
  tpdfDither,
  INT16_MAX,
  type EncoderConfig,
} from '@thaumic-cast/protocol';
import type { WorkerInboundMessage } from './worker-messages';
import { exponentialBackoff } from '../lib/backoff';

const s: WorkerState = createWorkerState('AudioRelayWorker');

let running = false;
let frameSizeInterleaved = 0;
let audioReader: ReadableStreamDefaultReader<AudioData> | null = null;
let channels = 2;

let ch0Temp: Float32Array | null = null;
let ch1Temp: Float32Array | null = null;
let maxFrameSamples = 0;

// Int16 accumulator. accumView is a persistent Uint8Array over accum.buffer
// (refreshed on grow) used for zero-copy sends: WebSocket.send() copies the
// bytes synchronously, so the backing buffer is safe to reuse next frame.
let accum: Int16Array | null = null;
let accumOffset = 0;
let accumView: Uint8Array<ArrayBuffer> | null = null;

// Gaps in AudioData timestamps represent clock reporting jitter, NOT missing
// audio — the capture device delivers continuous samples.
let expectedNextTimestamp = -1;
let loggedFirstFrame = false;

let gapCount = 0;
let gapDurationUs = 0;
let wakeupCount = 0;
let totalSamplesRead = 0;
let droppedFrameCount = 0;
let backpressureCycles = 0;
let consecutiveBackpressureCycles = 0;

/**
 * Grows per-channel f32 extraction buffers if an AudioData delivers more samples than seen before.
 * @param needed
 */
function ensureTempBuffers(needed: number): void {
  if (needed <= maxFrameSamples) return;
  maxFrameSamples = needed;
  ch0Temp = new Float32Array(needed);
  ch1Temp = new Float32Array(needed);
  s.log.info(`Grew temp buffers to ${needed} samples/channel`);
}

/** Rebuilds the persistent Uint8Array view over `accum.buffer` after an allocation change. */
function refreshAccumView(): void {
  if (!accum) return;
  // accum is allocated via `new Int16Array(number)`, so buffer is an ArrayBuffer
  accumView = new Uint8Array(accum.buffer as ArrayBuffer, accum.byteOffset, accum.byteLength);
}

/**
 * Doubles the accumulator capacity (or grows to `needed`, whichever is larger) and refreshes the view.
 * @param needed
 */
function growAccum(needed: number): void {
  if (!accum) return;
  const newSize = Math.max(accum.length * 2, needed);
  const grown = new Int16Array(newSize);
  grown.set(accum.subarray(0, accumOffset));
  accum = grown;
  refreshAccumView();
  s.log.info(`Grew frame accumulator to ${newSize} samples`);
}

/**
 * Fused: interleave + NaN-safe clamp to [-1, 1] + TPDF dither + Int16 saturate,
 * written directly into the accumulator. Emits complete frames as they fill.
 * @param srcCh0
 * @param srcCh1
 * @param count
 */
function emitFloat32Samples(
  srcCh0: Float32Array,
  srcCh1: Float32Array | null,
  count: number,
): void {
  if (!accum || !accumView) return;

  const interleavedCount = count * channels;
  if (accumOffset + interleavedCount > accum.length) {
    growAccum(accumOffset + interleavedCount);
  }

  let dst = accumOffset;
  if (channels === 1) {
    for (let i = 0; i < count; i++) {
      const l = srcCh0[i]!;
      // NaN-safe clamp: NaN comparisons return false, so NaN → 0
      const cl = l >= -1 ? (l <= 1 ? l : 1) : l === l ? -1 : 0;
      let ql = Math.round(cl * INT16_MAX + tpdfDither());
      if (ql < -32768) ql = -32768;
      else if (ql > 32767) ql = 32767;
      accum[dst++] = ql;
    }
  } else {
    for (let i = 0; i < count; i++) {
      const l = srcCh0[i]!;
      const r = srcCh1 ? srcCh1[i]! : l;
      const cl = l >= -1 ? (l <= 1 ? l : 1) : l === l ? -1 : 0;
      const cr = r >= -1 ? (r <= 1 ? r : 1) : r === r ? -1 : 0;
      let ql = Math.round(cl * INT16_MAX + tpdfDither());
      let qr = Math.round(cr * INT16_MAX + tpdfDither());
      if (ql < -32768) ql = -32768;
      else if (ql > 32767) ql = 32767;
      if (qr < -32768) qr = -32768;
      else if (qr > 32767) qr = 32767;
      accum[dst++] = ql;
      accum[dst++] = qr;
    }
  }
  accumOffset = dst;

  const frameBytes = frameSizeInterleaved * Int16Array.BYTES_PER_ELEMENT;
  while (accumOffset >= frameSizeInterleaved) {
    sendOrQueue(accumView.subarray(0, frameBytes));
    accumOffset -= frameSizeInterleaved;
    if (accumOffset > 0) {
      accum.copyWithin(0, frameSizeInterleaved, frameSizeInterleaved + accumOffset);
    }
  }
}

/**
 * Sends directly from the passed view when the socket has capacity; copies
 * into the persistent queue when in quality mode and backpressured.
 * @param frameView
 */
function sendOrQueue(frameView: Uint8Array<ArrayBuffer>): void {
  if (!s.socket || s.socket.readyState !== WebSocket.OPEN || !s.policy) return;

  if (isWsBackpressured(s)) {
    if (s.policy.dropOnBackpressure) {
      droppedFrameCount++;
    } else {
      enqueueFrame(s, new Uint8Array(frameView));
    }
    return;
  }

  s.socket.send(frameView);
}

/**
 * Processes a single AudioData frame: extracts planar f32, tracks timestamp gaps, and emits to the framing pipeline.
 * @param audioData
 */
function processAudioData(audioData: AudioData): void {
  try {
    const numFrames = audioData.numberOfFrames;
    const ts = audioData.timestamp;
    const sr = audioData.sampleRate;

    if (!loggedFirstFrame) {
      loggedFirstFrame = true;
      s.log.info(
        `First AudioData: format=${audioData.format}, frames=${numFrames}, ` +
          `channels=${audioData.numberOfChannels}, sampleRate=${sr}, ` +
          `duration=${audioData.duration}µs, timestamp=${ts}µs`,
      );
    }

    if (expectedNextTimestamp >= 0 && ts > 0) {
      const gap = ts - expectedNextTimestamp;
      if (Math.abs(gap) > 100) {
        gapCount++;
        gapDurationUs += Math.abs(gap);
      }
    }
    if (ts > 0 && sr > 0) {
      expectedNextTimestamp = ts + Math.round((numFrames / sr) * 1_000_000);
    }

    ensureTempBuffers(numFrames);
    audioData.copyTo(ch0Temp!, { planeIndex: 0 });
    const ch1 = channels >= 2 && audioData.numberOfChannels >= 2 ? ch1Temp : null;
    if (ch1) {
      audioData.copyTo(ch1!, { planeIndex: 1 });
    }

    emitFloat32Samples(ch0Temp!, ch1, numFrames);

    totalSamplesRead += numFrames * channels;
  } finally {
    audioData.close();
  }
}

/** Main loop: reads AudioData from the MSTP reader, handles backpressure, and posts periodic stats. */
async function consumeLoopMSTP(): Promise<void> {
  if (!audioReader) return;
  s.lastStatsTime = performance.now();

  while (running) {
    if (!s.policy?.dropOnBackpressure && s.frameQueue.length > 0) {
      flushFrameQueue(s);
    }

    const shouldBackoff = s.policy?.dropOnBackpressure
      ? isWsBackpressured(s)
      : s.frameQueueBytes >= FRAME_QUEUE_MAX_BYTES;

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
      maybePostStats(s, null, 0, getCustomMetrics, resetCustomCounters);
      await yieldMacrotask(backoffMs);
      continue;
    }

    consecutiveBackpressureCycles = 0;

    const { value: audioData, done } = await audioReader.read();
    if (done || !running) break;

    processAudioData(audioData);
    wakeupCount++;

    maybePostStats(s, null, 0, getCustomMetrics, resetCustomCounters);
  }
}

/**
 * Returns worker-specific metrics for the current stats interval.
 * @returns Metrics snapshot consumed by `maybePostStats`.
 */
function getCustomMetrics(): CustomMetrics {
  return {
    underflows: 0,
    consumerDroppedFrames: droppedFrameCount,
    catchUpDroppedSamples: 0,
    backpressureCycles,
    wakeups: wakeupCount,
    avgSamplesPerWake: wakeupCount > 0 ? totalSamplesRead / wakeupCount : 0,
    encodeQueueSize: 0,
  };
}

/** Resets per-interval counters after stats are posted; logs a debug line if timestamp gaps occurred. */
function resetCustomCounters(): void {
  if (gapCount > 0) {
    s.log.debug(`AudioData gaps: ${gapCount} gaps, ${(gapDurationUs / 1000).toFixed(1)}ms total`);
  }
  wakeupCount = 0;
  totalSamplesRead = 0;
  droppedFrameCount = 0;
  backpressureCycles = 0;
  gapCount = 0;
  gapDurationUs = 0;
}

/** Stops the consume loop, cancels the MSTP reader, releases buffers, and tears down shared WS state. */
function cleanup(): void {
  running = false;

  if (audioReader) {
    audioReader.cancel().catch(() => {
      /* ignore cancel errors during shutdown */
    });
    audioReader = null;
  }

  flushQueuedFrames(s);

  ch0Temp = null;
  ch1Temp = null;
  accum = null;
  accumOffset = 0;
  accumView = null;
  maxFrameSamples = 0;
  loggedFirstFrame = false;
  expectedNextTimestamp = -1;
  gapCount = 0;
  gapDurationUs = 0;

  cleanupSharedState(s);
}

self.onmessage = async (event: MessageEvent<WorkerInboundMessage>) => {
  const msg = event.data;
  if (handleCommonMessage(s, msg, cleanup)) return;

  if (msg.type === 'INIT') {
    try {
      const { encoderConfig, wsUrl, frameSizeInterleaved: initFrameSize } = msg;

      if (!initFrameSize || initFrameSize <= 0) {
        throw new Error('frameSizeInterleaved required for relay worker');
      }
      if (!msg.readable) {
        throw new Error('readable stream required for relay worker');
      }

      frameSizeInterleaved = initFrameSize;
      channels = msg.channels ?? 2;

      s.policy = getStreamingPolicy(encoderConfig.latencyMode);
      s.log.info(
        `Streaming policy: ${encoderConfig.latencyMode} mode ` +
          `(dropOnBackpressure=${s.policy.dropOnBackpressure})`,
      );

      resetStatsCounters(s);
      resetFrameQueueState(s);
      wakeupCount = 0;
      totalSamplesRead = 0;
      droppedFrameCount = 0;
      backpressureCycles = 0;
      consecutiveBackpressureCycles = 0;
      loggedFirstFrame = false;
      expectedNextTimestamp = -1;
      gapCount = 0;
      gapDurationUs = 0;

      // Chrome typically delivers ~480 samples at 48kHz
      maxFrameSamples = 1024;
      ch0Temp = new Float32Array(maxFrameSamples);
      ch1Temp = new Float32Array(maxFrameSamples);

      // 4x frame headroom for variable AudioData sizes
      accum = new Int16Array(frameSizeInterleaved * 4);
      accumOffset = 0;
      refreshAccumView();

      audioReader = msg.readable.getReader();

      const configWithFrameSize: EncoderConfig = {
        ...encoderConfig,
        frameSizeSamples: frameSizeInterleaved / channels,
      };

      const id = await connectWebSocket(s, wsUrl, {
        type: 'HANDSHAKE',
        payload: { encoderConfig: configWithFrameSize },
      });

      running = true;
      s.streamStartTime = performance.now();
      postToMain({ type: 'CONNECTED', streamId: id });

      consumeLoopMSTP().catch((err) => {
        s.log.error('consumeLoopMSTP error:', err);
        postToMain({ type: 'ERROR', message: String(err) });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      s.log.error('Initialization failed:', message);
      postToMain({ type: 'ERROR', message });
    }
  }
};
