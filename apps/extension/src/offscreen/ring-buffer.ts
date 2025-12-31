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
export const RING_BUFFER_SIZE = 48000 * 2 * 2; // 2 seconds of stereo 48k audio
export const HEADER_SIZE = 4; // Control integers at the start

/** Control index for the write pointer. */
export const CTRL_WRITE_IDX = 0;
/** Control index for the read pointer. */
export const CTRL_READ_IDX = 1;
/** Control index for the overflow flag. */
export const CTRL_OVERFLOW = 2;
/** Control index for the data available signal (used with Atomics.wait/notify). */
export const CTRL_DATA_SIGNAL = 3;

/**
 * Creates a SharedArrayBuffer for audio data.
 * @returns A new SharedArrayBuffer for the audio ring buffer
 */
export function createAudioRingBuffer(): SharedArrayBuffer {
  // Size = (Header + BufferSize) * 2 bytes (for Int16)
  const size = (HEADER_SIZE + RING_BUFFER_SIZE) * 2;
  const sab = new SharedArrayBuffer(size);
  return sab;
}
