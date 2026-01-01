/**
 * AudioWorkletProcessor for extracting raw PCM samples using zero-copy shared memory.
 * Uses Atomics for thread-safe access to control indices.
 *
 * Control indices (must match ring-buffer.ts):
 * [0] - Write Index
 * [1] - Read Index
 * [2] - Overflow Flag
 * [3] - Data Available Signal (for Atomics.wait/notify)
 */

// Control indices - must match ring-buffer.ts exports
const CTRL_WRITE_IDX = 0;
const CTRL_READ_IDX = 1;
const CTRL_OVERFLOW = 2;
const CTRL_DATA_SIGNAL = 3;

/**
 * Notification threshold duration in seconds (10ms).
 * Batches notifications to reduce Worker wakeups from ~375/sec to ~100/sec.
 * Worker consumes 20ms frames, so notifying at 10ms gives buffer for timing variance.
 */
const NOTIFY_DURATION_SEC = 0.01;

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
 */
class PCMProcessor extends AudioWorkletProcessor {
  private sharedBuffer: Int16Array | null = null;
  private control: Int32Array | null = null;
  /** Bitmask for efficient index wrapping (power-of-two optimization). */
  private bufferMask = 0;
  /** Number of audio channels (1 for mono, 2 for stereo). */
  private channels = 2;
  /** Accumulated samples since last notification (for batching). */
  private accumulatedSamples = 0;
  /** Notification threshold in samples, derived from sample rate and channels. */
  private notifyThreshold = 0;

  /**
   * Creates a new PCM processor instance.
   */
  constructor() {
    super();
    this.port.onmessage = (event) => {
      if (event.data.type === 'INIT_BUFFER') {
        const { buffer: sab, bufferMask, headerSize, sampleRate, channels } = event.data;
        this.sharedBuffer = new Int16Array(sab, headerSize * 4);
        this.control = new Int32Array(sab, 0, headerSize);
        this.bufferMask = bufferMask;
        this.channels = channels;
        // Calculate notify threshold from sample rate (10ms * sampleRate * channels)
        this.notifyThreshold = Math.round(sampleRate * NOTIFY_DURATION_SEC) * channels;
      }
    };
  }

  /**
   * Processes audio frames and writes to shared memory ring buffer.
   * Supports both mono and stereo input.
   * @param inputs - Input audio data from the graph
   * @returns Always true to keep the processor alive
   */
  process(inputs: Float32Array[][]): boolean {
    if (!this.sharedBuffer || !this.control || !this.bufferMask) return true;

    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channel0 = input[0];
    if (!channel0) return true;

    let writeIdx = Atomics.load(this.control, CTRL_WRITE_IDX);
    const readIdx = Atomics.load(this.control, CTRL_READ_IDX);
    let samplesWritten = 0;

    const frameCount = channel0.length;
    const channels = this.channels;

    if (channels === 1) {
      // Mono: write single channel
      for (let i = 0; i < frameCount; i++) {
        const nextIdx = (writeIdx + 1) & this.bufferMask;
        if (nextIdx === readIdx) {
          Atomics.store(this.control, CTRL_OVERFLOW, 1);
          break;
        }
        this.sharedBuffer[writeIdx] = Math.max(-1, Math.min(1, channel0[i]!)) * 0x7fff;
        writeIdx = nextIdx;
        samplesWritten += 1;
      }
    } else {
      // Stereo: write interleaved L/R samples
      const channel1 = input[1] || channel0; // Fall back to mono duplication
      for (let i = 0; i < frameCount; i++) {
        const nextIdx = (writeIdx + 2) & this.bufferMask;
        if (nextIdx === readIdx) {
          Atomics.store(this.control, CTRL_OVERFLOW, 1);
          break;
        }
        this.sharedBuffer[writeIdx] = Math.max(-1, Math.min(1, channel0[i]!)) * 0x7fff;
        this.sharedBuffer[writeIdx + 1] = Math.max(-1, Math.min(1, channel1[i]!)) * 0x7fff;
        writeIdx = nextIdx;
        samplesWritten += 2;
      }
    }

    if (samplesWritten > 0) {
      Atomics.store(this.control, CTRL_WRITE_IDX, writeIdx);

      // Batch notifications to reduce Worker wakeups
      this.accumulatedSamples += samplesWritten;
      if (this.notifyThreshold > 0 && this.accumulatedSamples >= this.notifyThreshold) {
        Atomics.add(this.control, CTRL_DATA_SIGNAL, 1);
        Atomics.notify(this.control, CTRL_DATA_SIGNAL, 1);
        this.accumulatedSamples = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);

// Empty export to make this a module (prevents TypeScript from treating as a script)
export {};
