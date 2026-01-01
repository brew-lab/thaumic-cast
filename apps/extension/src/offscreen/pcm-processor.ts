/**
 * AudioWorkletProcessor for extracting raw PCM samples using zero-copy shared memory.
 *
 * Uses monotonic (ever-increasing) indices with unsigned math for correct
 * wrap-around handling over long sessions (>12 hours).
 *
 * Control indices (must match ring-buffer.ts):
 * [0] - Write Index (monotonic, interpreted as unsigned via >>> 0)
 * [1] - Read Index (monotonic, interpreted as unsigned via >>> 0)
 * [2] - Producer Dropped Samples (for diagnostics)
 */

// Control indices - must match ring-buffer.ts exports
const CTRL_WRITE_IDX = 0;
const CTRL_READ_IDX = 1;
const CTRL_DROPPED_SAMPLES = 2;

/**
 * Base class for audio worklet processors.
 */
declare class AudioWorkletProcessor {
  /** Message port for communicating with the main thread. */
  readonly port: MessagePort;
  /**
   * Processes audio frames.
   * @param inputs - Input audio data
   * @param outputs - Output audio data
   * @param parameters - Automation parameters
   * @returns True to keep the processor alive
   */
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

/**
 * Registers an audio worklet processor.
 * @param name - The processor name
 * @param processorCtor - The processor constructor
 */
declare function registerProcessor(name: string, processorCtor: typeof AudioWorkletProcessor): void;

/**
 * AudioWorkletProcessor for converting Float32 audio to Int16 PCM in shared memory.
 *
 * Uses monotonic indices that wrap at 32-bit boundary with unsigned interpretation.
 * Checks available space once per block and drops entire blocks when full.
 * Only notifies consumer on empty→non-empty transition.
 */
class PCMProcessor extends AudioWorkletProcessor {
  private sharedBuffer: Int16Array | null = null;
  private control: Int32Array | null = null;
  /** Bitmask for efficient buffer offset calculation (power-of-two optimization). */
  private bufferMask = 0;
  /** Ring buffer capacity in samples. */
  private capacity = 0;
  /** Number of audio channels (1 for mono, 2 for stereo). */
  private channels = 2;

  /**
   * Creates a new PCM processor instance.
   */
  constructor() {
    super();
    this.port.onmessage = (event) => {
      if (event.data.type === 'INIT_BUFFER') {
        const { buffer: sab, bufferMask, headerSize, channels } = event.data;
        this.sharedBuffer = new Int16Array(sab, headerSize * 4);
        this.control = new Int32Array(sab, 0, headerSize);
        this.bufferMask = bufferMask;
        this.capacity = bufferMask + 1; // Power of two: mask + 1 = size
        this.channels = channels;
      }
    };
  }

  /**
   * Processes audio frames and writes to shared memory ring buffer.
   * Checks available space once per block and drops entire blocks when full.
   * @param inputs - Input audio data from the graph
   * @returns Always true to keep the processor alive
   */
  process(inputs: Float32Array[][]): boolean {
    if (!this.sharedBuffer || !this.control) return true;

    const input = inputs[0];
    if (!input?.[0]) return true;

    const channel0 = input[0];
    const channel1 = input[1] || channel0; // Fall back to mono duplication
    const frameCount = channel0.length;
    const samplesToWrite = frameCount * this.channels;

    // Check available space ONCE per block
    const write = Atomics.load(this.control, CTRL_WRITE_IDX);
    const read = Atomics.load(this.control, CTRL_READ_IDX);
    const used = (write - read) >>> 0;
    const available = this.capacity - used;

    if (available < samplesToWrite) {
      // Drop entire block, track samples dropped (not blocks)
      Atomics.add(this.control, CTRL_DROPPED_SAMPLES, samplesToWrite);
      return true;
    }

    // Check if buffer was empty (for notification)
    const wasEmpty = write === read;

    // Write samples to ring buffer
    let writeIdx = write;

    if (this.channels === 1) {
      // Mono: write single channel
      for (let i = 0; i < frameCount; i++) {
        const offset = writeIdx & this.bufferMask;
        this.sharedBuffer[offset] = Math.max(-1, Math.min(1, channel0[i]!)) * 0x7fff;
        writeIdx = (writeIdx + 1) | 0;
      }
    } else {
      // Stereo: write interleaved L/R samples
      for (let i = 0; i < frameCount; i++) {
        const offsetL = writeIdx & this.bufferMask;
        const offsetR = (writeIdx + 1) & this.bufferMask;
        this.sharedBuffer[offsetL] = Math.max(-1, Math.min(1, channel0[i]!)) * 0x7fff;
        this.sharedBuffer[offsetR] = Math.max(-1, Math.min(1, channel1[i]!)) * 0x7fff;
        writeIdx = (writeIdx + 2) | 0;
      }
    }

    // Single atomic commit
    Atomics.store(this.control, CTRL_WRITE_IDX, writeIdx);

    // Only notify on empty→non-empty transition
    if (wasEmpty) {
      Atomics.notify(this.control, CTRL_WRITE_IDX, 1);
    }

    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);

// Empty export to make this a module (prevents TypeScript from treating as a script)
export {};
