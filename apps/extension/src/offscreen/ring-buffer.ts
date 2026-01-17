/**
 * Shared memory structure for the zero-copy audio ring buffer.
 *
 * Control Layout (Int32Array - required for Atomics.waitAsync):
 * [0] - Write Index (monotonic, ever-increasing, interpreted as unsigned)
 * [1] - Read Index (monotonic, ever-increasing, interpreted as unsigned)
 * [2] - Producer Dropped Samples (for diagnostics)
 *
 * IMPORTANT: Must use Int32Array (not Uint32Array) because
 * Atomics.waitAsync only works with Int32Array/BigInt64Array.
 *
 * Bit Operation Conventions:
 *   | 0   - Truncates to signed 32-bit int. Use when storing to Int32Array
 *           via Atomics.store() to ensure the value fits.
 *   >>> 0 - Interprets as unsigned 32-bit int. Use for arithmetic/comparisons
 *           to handle wrap-around correctly (e.g., availability calculation).
 *
 * Availability Calculation:
 *   availableRead = (writeIdx - readIdx) >>> 0
 *   availableWrite = bufferSize - availableRead
 *   bufferOffset = index & bufferMask
 *
 * The unsigned subtraction (>>> 0) handles 32-bit wrap correctly
 * for sessions >12 hours at 48kHz stereo.
 *
 * Data Layout (Float32Array starting at HEADER_SIZE * 4 bytes):
 * [0..N] - Interleaved PCM Float32 samples (L, R, L, R, ...)
 *
 * Float32 samples are kept throughout the pipeline until final quantization
 * at the encoder level, allowing for 24-bit FLAC encoding without precision loss.
 */

import type { LatencyMode } from '@thaumic-cast/protocol';
import { getStreamingPolicy } from '@thaumic-cast/protocol';

/** Number of control integers at the start of the buffer. */
export const HEADER_SIZE = 3;

/** Control index for the write pointer. */
export const CTRL_WRITE_IDX = 0;
/** Control index for the read pointer. */
export const CTRL_READ_IDX = 1;
/** Control index for the producer dropped samples count (diagnostics). */
export const CTRL_DROPPED_SAMPLES = 2;

/** Byte offset where Float32 audio data begins. */
export const DATA_BYTE_OFFSET = HEADER_SIZE * Int32Array.BYTES_PER_ELEMENT;

/** Result of creating an audio ring buffer. */
export interface RingBufferConfig {
  /** The SharedArrayBuffer containing the ring buffer. */
  sab: SharedArrayBuffer;
  /** Power-of-two buffer size in samples. */
  size: number;
  /** Bitmask for efficient index wrapping (size - 1). */
  mask: number;
}

/**
 * Calculates the power-of-two buffer size for a given audio configuration.
 * Buffer duration varies by latency mode:
 * - 'quality': ~10 seconds for music/podcasts
 * - 'realtime': ~3 seconds for low-latency sync
 *
 * @param sampleRate - Audio sample rate in Hz
 * @param channels - Number of audio channels
 * @param latencyMode - The latency mode (affects buffer duration)
 * @returns Power-of-two buffer size in samples
 */
function calculateBufferSize(
  sampleRate: number,
  channels: number,
  latencyMode: LatencyMode = 'quality',
): number {
  const policy = getStreamingPolicy(latencyMode);
  const minSamples = sampleRate * channels * policy.ringBufferSeconds;
  return 1 << Math.ceil(Math.log2(minSamples));
}

/**
 * Creates a SharedArrayBuffer for audio data, sized for the given audio configuration.
 * Buffer duration varies by latency mode:
 * - 'quality': ~10 seconds for music/podcasts
 * - 'realtime': ~3 seconds for low-latency sync
 *
 * @param sampleRate - Audio sample rate in Hz
 * @param channels - Number of audio channels
 * @param latencyMode - The latency mode (affects buffer sizing)
 * @returns Ring buffer configuration with SharedArrayBuffer, size, and mask
 */
export function createAudioRingBuffer(
  sampleRate: number,
  channels: number,
  latencyMode: LatencyMode = 'quality',
): RingBufferConfig {
  const size = calculateBufferSize(sampleRate, channels, latencyMode);
  const mask = size - 1;

  // Verify power-of-two (should always pass given calculateBufferSize implementation)
  if ((size & (size - 1)) !== 0) {
    throw new Error('Buffer size must be a power of two for bitmask wrapping');
  }

  // Allocate: header uses Int32, data uses Float32
  const byteLength = DATA_BYTE_OFFSET + size * Float32Array.BYTES_PER_ELEMENT;
  const sab = new SharedArrayBuffer(byteLength);

  // Verify the Float32Array view has the expected size
  const dataView = new Float32Array(sab, DATA_BYTE_OFFSET);
  if (dataView.length !== size) {
    throw new Error(
      `Ring buffer data view length mismatch: expected ${size}, got ${dataView.length}`,
    );
  }

  return { sab, size, mask };
}
