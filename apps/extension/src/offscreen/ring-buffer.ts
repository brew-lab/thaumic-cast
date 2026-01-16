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
 *   availableWrite = RING_BUFFER_SIZE - availableRead
 *   bufferOffset = index & RING_BUFFER_MASK
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

/** Power-of-two buffer size for bitmask optimization. ~5.4 seconds at 48kHz stereo. */
export const RING_BUFFER_SIZE = 524288; // 2^19

/** Bitmask for efficient index wrapping (replaces costly modulo). */
export const RING_BUFFER_MASK = RING_BUFFER_SIZE - 1;

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

/**
 * Creates a SharedArrayBuffer for audio data.
 * @returns A new SharedArrayBuffer for the audio ring buffer
 */
export function createAudioRingBuffer(): SharedArrayBuffer {
  // Static assertions for configuration validity
  if ((RING_BUFFER_SIZE & (RING_BUFFER_SIZE - 1)) !== 0) {
    throw new Error('RING_BUFFER_SIZE must be a power of two for bitmask wrapping');
  }
  if (RING_BUFFER_MASK !== RING_BUFFER_SIZE - 1) {
    throw new Error('RING_BUFFER_MASK must be RING_BUFFER_SIZE - 1');
  }

  // Correct allocation: header uses Int32, data uses Float32
  // Float32 buffer is ~2x larger than Int16 but keeps full precision for 24-bit encoding
  const size = DATA_BYTE_OFFSET + RING_BUFFER_SIZE * Float32Array.BYTES_PER_ELEMENT;
  const sab = new SharedArrayBuffer(size);

  // Verify the Float32Array view will have exactly RING_BUFFER_SIZE elements
  const dataView = new Float32Array(sab, DATA_BYTE_OFFSET);
  if (dataView.length !== RING_BUFFER_SIZE) {
    throw new Error(
      `Ring buffer data view length mismatch: expected ${RING_BUFFER_SIZE}, got ${dataView.length}`,
    );
  }

  return sab;
}
