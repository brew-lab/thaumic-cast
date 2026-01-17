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

/** Target heartbeat interval in seconds. */
const HEARTBEAT_INTERVAL_SEC = 1.0;

/** Samples per block (Web Audio render quantum). */
const BLOCK_SIZE = 128;

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

/** Global sample rate in AudioWorklet scope. */
declare const sampleRate: number;

// Note: Clamping logic is inlined and unrolled in the hot path below for performance.
// Uses Math.max(-1, Math.min(1, s || 0)) which handles NaN (via || 0) and ±Infinity.
// See protocol/audio.ts clampSample for the canonical (non-NaN-safe) version.

/**
 * AudioWorkletProcessor for writing Float32 audio to shared memory.
 *
 * Uses monotonic indices that wrap at 32-bit boundary with unsigned interpretation.
 * Checks available space once per block and drops entire blocks when full.
 * Uses bulk TypedArray.set() for efficient writes with wrap handling.
 * Only notifies consumer on empty→non-empty transition.
 *
 * Float32 samples are preserved throughout the pipeline until final quantization
 * at the encoder level, enabling 24-bit FLAC encoding without precision loss.
 */
class PCMProcessor extends AudioWorkletProcessor {
  private sharedBuffer: Float32Array | null = null;
  private control: Int32Array | null = null;
  /** Bitmask for efficient buffer offset calculation (power-of-two optimization). */
  private bufferMask = 0;
  /** Ring buffer capacity in samples. */
  private capacity = 0;
  /** Number of audio channels (1 for mono, 2 for stereo). */
  private channels = 2;
  /** Pre-allocated buffer for clamping and channel handling (avoids per-frame allocation). */
  private readonly conversionBuffer = new Float32Array(BLOCK_SIZE * 2);
  /** Counter for heartbeat interval. */
  private blockCount = 0;
  /** Number of blocks between heartbeats (computed from sampleRate). */
  private readonly heartbeatIntervalBlocks: number;

  /**
   * Creates a new PCM processor instance.
   */
  constructor() {
    super();

    // Compute heartbeat interval based on actual sample rate
    // blocks per second = sampleRate / BLOCK_SIZE
    // heartbeat every HEARTBEAT_INTERVAL_SEC seconds
    // Guard with Math.max(1, ...) to handle extreme/invalid sample rates
    this.heartbeatIntervalBlocks = Math.max(
      1,
      Math.round((sampleRate / BLOCK_SIZE) * HEARTBEAT_INTERVAL_SEC),
    );

    this.port.onmessage = (event) => {
      if (event.data.type === 'INIT_BUFFER') {
        const { buffer: sab, bufferMask, headerSize, channels } = event.data;
        this.sharedBuffer = new Float32Array(sab, headerSize * 4);
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

    // Clamp Float32 samples to [-1, 1] range (no quantization - that happens at encoder).
    // Web Audio API nominally outputs [-1, 1], but clamping is defensive against:
    // - Audio processing effects that may exceed range
    // - Browser implementation variations
    // - NaN values (s || 0 converts NaN to 0 to avoid undefined WebCodecs behavior)
    // - Future API changes
    // Note: ±Infinity is already handled correctly (clamped to ±1).
    //
    // Loop is unrolled by 4 for better instruction-level parallelism.
    // frameCount is typically 128 (render quantum), always divisible by 4.
    const len4 = frameCount & ~3;

    if (this.channels === 1) {
      // Mono output: average both channels for proper downmix
      // If input is already mono (channel1 === channel0), this still works correctly
      const hasSecondChannel = input[1] !== undefined;
      if (hasSecondChannel) {
        // Proper stereo-to-mono downmix: average both channels
        for (let i = 0; i < len4; i += 4) {
          const s0 = (channel0[i]! + channel1[i]!) * 0.5;
          const s1 = (channel0[i + 1]! + channel1[i + 1]!) * 0.5;
          const s2 = (channel0[i + 2]! + channel1[i + 2]!) * 0.5;
          const s3 = (channel0[i + 3]! + channel1[i + 3]!) * 0.5;
          this.conversionBuffer[i] = Math.max(-1, Math.min(1, s0 || 0));
          this.conversionBuffer[i + 1] = Math.max(-1, Math.min(1, s1 || 0));
          this.conversionBuffer[i + 2] = Math.max(-1, Math.min(1, s2 || 0));
          this.conversionBuffer[i + 3] = Math.max(-1, Math.min(1, s3 || 0));
        }
        for (let i = len4; i < frameCount; i++) {
          const s = (channel0[i]! + channel1[i]!) * 0.5;
          this.conversionBuffer[i] = Math.max(-1, Math.min(1, s || 0));
        }
      } else {
        // Input is already mono, just clamp
        for (let i = 0; i < len4; i += 4) {
          const s0 = channel0[i]!;
          const s1 = channel0[i + 1]!;
          const s2 = channel0[i + 2]!;
          const s3 = channel0[i + 3]!;
          this.conversionBuffer[i] = Math.max(-1, Math.min(1, s0 || 0));
          this.conversionBuffer[i + 1] = Math.max(-1, Math.min(1, s1 || 0));
          this.conversionBuffer[i + 2] = Math.max(-1, Math.min(1, s2 || 0));
          this.conversionBuffer[i + 3] = Math.max(-1, Math.min(1, s3 || 0));
        }
        for (let i = len4; i < frameCount; i++) {
          this.conversionBuffer[i] = Math.max(-1, Math.min(1, channel0[i]! || 0));
        }
      }
    } else {
      // Stereo output (interleaved L/R)
      for (let i = 0; i < len4; i += 4) {
        const l0 = channel0[i]!,
          r0 = channel1[i]!;
        const l1 = channel0[i + 1]!,
          r1 = channel1[i + 1]!;
        const l2 = channel0[i + 2]!,
          r2 = channel1[i + 2]!;
        const l3 = channel0[i + 3]!,
          r3 = channel1[i + 3]!;
        this.conversionBuffer[i * 2] = Math.max(-1, Math.min(1, l0 || 0));
        this.conversionBuffer[i * 2 + 1] = Math.max(-1, Math.min(1, r0 || 0));
        this.conversionBuffer[i * 2 + 2] = Math.max(-1, Math.min(1, l1 || 0));
        this.conversionBuffer[i * 2 + 3] = Math.max(-1, Math.min(1, r1 || 0));
        this.conversionBuffer[i * 2 + 4] = Math.max(-1, Math.min(1, l2 || 0));
        this.conversionBuffer[i * 2 + 5] = Math.max(-1, Math.min(1, r2 || 0));
        this.conversionBuffer[i * 2 + 6] = Math.max(-1, Math.min(1, l3 || 0));
        this.conversionBuffer[i * 2 + 7] = Math.max(-1, Math.min(1, r3 || 0));
      }
      for (let i = len4; i < frameCount; i++) {
        this.conversionBuffer[i * 2] = Math.max(-1, Math.min(1, channel0[i]! || 0));
        this.conversionBuffer[i * 2 + 1] = Math.max(-1, Math.min(1, channel1[i]! || 0));
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
    if (this.blockCount >= this.heartbeatIntervalBlocks) {
      this.blockCount = 0;
      this.port.postMessage({ type: 'HEARTBEAT' });
    }

    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);

// Empty export to make this a module (prevents TypeScript from treating as a script)
export {};
