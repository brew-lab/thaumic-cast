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

/** Number of process() calls between heartbeat messages (~1 second at 128 samples/block). */
const HEARTBEAT_INTERVAL_BLOCKS = 375; // ~375 blocks * 2.67ms ≈ 1 second

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
 * Uses bulk TypedArray.set() for efficient writes with wrap handling.
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
  /** Pre-allocated buffer for Float32→Int16 conversion (avoids per-frame allocation). */
  private conversionBuffer: Int16Array | null = null;
  /** Counter for heartbeat interval. */
  private blockCount = 0;

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
   * Uses bulk conversion and TypedArray.set() for efficient writes.
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

    // Ensure conversion buffer exists with adequate size
    if (!this.conversionBuffer || this.conversionBuffer.length < samplesToWrite) {
      this.conversionBuffer = new Int16Array(samplesToWrite);
    }

    // Bulk convert Float32 to Int16 (no atomics in this loop)
    if (this.channels === 1) {
      // Mono output: average both channels for proper downmix
      // If input is already mono (channel1 === channel0), this still works correctly
      const hasSecondChannel = input[1] !== undefined;
      if (hasSecondChannel) {
        // Proper stereo-to-mono downmix: average both channels
        for (let i = 0; i < frameCount; i++) {
          const avg = (channel0[i]! + channel1[i]!) * 0.5;
          this.conversionBuffer[i] = Math.max(-1, Math.min(1, avg)) * 0x7fff;
        }
      } else {
        // Input is already mono, just convert
        for (let i = 0; i < frameCount; i++) {
          this.conversionBuffer[i] = Math.max(-1, Math.min(1, channel0[i]!)) * 0x7fff;
        }
      }
    } else {
      // Stereo output
      for (let i = 0; i < frameCount; i++) {
        this.conversionBuffer[i * 2] = Math.max(-1, Math.min(1, channel0[i]!)) * 0x7fff;
        this.conversionBuffer[i * 2 + 1] = Math.max(-1, Math.min(1, channel1[i]!)) * 0x7fff;
      }
    }

    // Write to ring buffer with wrap handling
    const startOffset = write & this.bufferMask;
    const endOffset = startOffset + samplesToWrite;

    if (endOffset <= this.capacity) {
      // No wrap - single set
      this.sharedBuffer.set(this.conversionBuffer.subarray(0, samplesToWrite), startOffset);
    } else {
      // Wrap - two sets
      const firstPart = this.capacity - startOffset;
      this.sharedBuffer.set(this.conversionBuffer.subarray(0, firstPart), startOffset);
      this.sharedBuffer.set(this.conversionBuffer.subarray(firstPart, samplesToWrite), 0);
    }

    // Single atomic commit
    Atomics.store(this.control, CTRL_WRITE_IDX, (write + samplesToWrite) | 0);

    // Only notify on empty→non-empty transition
    if (wasEmpty) {
      Atomics.notify(this.control, CTRL_WRITE_IDX, 1);
    }

    // Send periodic heartbeat to main thread
    this.blockCount++;
    if (this.blockCount >= HEARTBEAT_INTERVAL_BLOCKS) {
      this.blockCount = 0;
      this.port.postMessage({ type: 'HEARTBEAT' });
    }

    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);

// Empty export to make this a module (prevents TypeScript from treating as a script)
export {};
