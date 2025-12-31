/**
 * Shared memory structure for the zero-copy audio ring buffer.
 *
 * Control Layout (Int32Array):
 * [0] - Write Index (where the Worklet adds data)
 * [1] - Read Index (where the consumer Worker reads data)
 * [2] - Overflow Flag (0: OK, 1: Overflow occurred)
 * [3] - Data Available Signal (for Atomics.wait/notify synchronization)
 *
 * Data Layout (Int16Array starting at HEADER_SIZE * 4 bytes):
 * [0..N] - Interleaved PCM Int16 samples (L, R, L, R, ...)
 */

/** Power-of-two buffer size for bitmask optimization. ~2.7 seconds at 48kHz stereo. */
export const RING_BUFFER_SIZE = 262144; // 2^18

/** Bitmask for efficient index wrapping (replaces costly modulo). */
export const RING_BUFFER_MASK = RING_BUFFER_SIZE - 1;

/** Number of control integers at the start of the buffer. */
export const HEADER_SIZE = 4;

/** Control index for the write pointer. */
export const CTRL_WRITE_IDX = 0;
/** Control index for the read pointer. */
export const CTRL_READ_IDX = 1;
/** Control index for the overflow flag. */
export const CTRL_OVERFLOW = 2;
/** Control index for the data available signal (used with Atomics.wait/notify). */
export const CTRL_DATA_SIGNAL = 3;

/** Byte offset where Int16 audio data begins. */
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

  // Correct allocation: header uses Int32, data uses Int16
  const size = DATA_BYTE_OFFSET + RING_BUFFER_SIZE * Int16Array.BYTES_PER_ELEMENT;
  const sab = new SharedArrayBuffer(size);

  // Verify the Int16Array view will have exactly RING_BUFFER_SIZE elements
  const dataView = new Int16Array(sab, DATA_BYTE_OFFSET);
  if (dataView.length !== RING_BUFFER_SIZE) {
    throw new Error(
      `Ring buffer data view length mismatch: expected ${RING_BUFFER_SIZE}, got ${dataView.length}`,
    );
  }

  return sab;
}
