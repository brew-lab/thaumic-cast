/**
 * Shared memory structure for the zero-copy audio ring buffer.
 *
 * Layout:
 * [0] - Write Index (where the Worklet adds data)
 * [1] - Read Index (where the Main thread reads data)
 * [2] - Buffer Status (0: OK, 1: Overflow)
 * [3..N] - Interleaved PCM Int16 samples
 */
export const RING_BUFFER_SIZE = 48000 * 2; // 1 second of stereo 48k audio
export const HEADER_SIZE = 4; // Control integers at the start

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
