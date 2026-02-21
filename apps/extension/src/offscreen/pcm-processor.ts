/**
 * AudioWorkletProcessor for extracting raw PCM samples using zero-copy shared memory.
 *
 * Supports two modes:
 * - `passthrough` (default): Writes clamped Float32 samples to a Float32 SAB ring buffer.
 *   Encoding happens downstream in the Worker thread.
 * - `encode`: Performs Float32→Int16 quantization with TPDF dither and frame accumulation
 *   directly on Chrome's high-priority audio rendering thread, then writes complete Int16
 *   frames to an Int16 SAB ring buffer. The Worker becomes a thin relay.
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

/** Maximum Int16 value, used for Float32→Int16 scaling. */
const INT16_MAX = 32767;

// ─────────────────────────────────────────────────────────────────────────────
// TPDF Dither Table (inlined — AudioWorkletGlobalScope cannot resolve imports)
//
// Pre-computed triangular probability density function noise. Using a lookup
// table is ~10-20x faster than calling Math.random() per sample. 4096 entries
// is large enough to avoid audible periodicity while remaining cache-friendly.
//
// Same algorithm as protocol/src/audio.ts:145-147.
// ─────────────────────────────────────────────────────────────────────────────
const DITHER_TABLE_SIZE = 4096;
const DITHER_TABLE_MASK = DITHER_TABLE_SIZE - 1;
const DITHER_TABLE = new Float32Array(DITHER_TABLE_SIZE);
for (let i = 0; i < DITHER_TABLE_SIZE; i++) {
  DITHER_TABLE[i] = Math.random() - 0.5 + (Math.random() - 0.5);
}

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
 * AudioWorkletProcessor for writing audio to shared memory ring buffers.
 *
 * In passthrough mode: writes Float32 samples to a Float32 SAB ring buffer.
 * In encode mode: quantizes Float32→Int16 with TPDF dither, accumulates into
 * frames, and writes complete Int16 frames to an Int16 SAB ring buffer.
 *
 * Uses monotonic indices that wrap at 32-bit boundary with unsigned interpretation.
 * Checks available space once per block and drops entire blocks when full.
 * Uses bulk TypedArray.set() for efficient writes with wrap handling.
 * Only notifies consumer on empty→non-empty transition.
 */
class PCMProcessor extends AudioWorkletProcessor {
  // ── Shared state (both modes) ──────────────────────────────────────────
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

  // ── Passthrough mode ───────────────────────────────────────────────────
  /** Float32 view of the SAB data region. Null when in encode mode or uninitialized. */
  private sharedFloat32: Float32Array | null = null;

  // ── Encode mode ────────────────────────────────────────────────────────
  /** Boolean flag for fast branching in process() (no string comparison). */
  private encodeMode = false;
  /** Int16 view of the SAB data region. Null when in passthrough mode or uninitialized. */
  private sharedInt16: Int16Array | null = null;
  /** Pre-allocated buffer for one quantum of encoded Int16 samples (128 * 2 channels max). */
  private encodeBuffer: Int16Array | null = null;
  /** Pre-allocated frame accumulation buffer (one complete frame). */
  private frameAccum: Int16Array | null = null;
  /** Current write position in frameAccum. */
  private frameAccumOffset = 0;
  /** Number of interleaved Int16 samples per frame. */
  private frameSizeInterleaved = 0;
  /** Current index into the TPDF dither table. */
  private ditherIndex = 0;

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
        const {
          buffer: sab,
          bufferMask,
          headerSize,
          channels,
          mode,
          frameSizeInterleaved,
        } = event.data;
        this.control = new Int32Array(sab, 0, headerSize);
        this.bufferMask = bufferMask;
        this.capacity = bufferMask + 1; // Power of two: mask + 1 = size
        this.channels = channels;

        if (mode === 'encode') {
          // Encode mode: Int16 SAB, frame accumulation, TPDF dither
          this.encodeMode = true;
          this.sharedInt16 = new Int16Array(sab, headerSize * Int32Array.BYTES_PER_ELEMENT);
          this.sharedFloat32 = null;

          // Pre-allocate encode buffers (ZERO allocations allowed in process())
          this.encodeBuffer = new Int16Array(BLOCK_SIZE * 2); // 256 max (128 samples * 2 channels)
          this.frameSizeInterleaved = frameSizeInterleaved;
          this.frameAccum = new Int16Array(frameSizeInterleaved);
          this.frameAccumOffset = 0;
          this.ditherIndex = 0;
        } else {
          // Passthrough mode (default): Float32 SAB, per-quantum writes
          this.encodeMode = false;
          this.sharedFloat32 = new Float32Array(sab, headerSize * Int32Array.BYTES_PER_ELEMENT);
          this.sharedInt16 = null;
          this.encodeBuffer = null;
          this.frameAccum = null;
        }
      }
    };
  }

  /**
   * Processes audio frames and writes to shared memory ring buffer.
   *
   * In passthrough mode: clamps Float32 samples and writes per-quantum to Float32 SAB.
   * In encode mode: clamps, quantizes with TPDF dither, accumulates into frames,
   * and writes complete Int16 frames to Int16 SAB.
   *
   * @param inputs - Input audio data from the graph
   * @returns Always true to keep the processor alive
   */
  process(inputs: Float32Array[][]): boolean {
    if (!this.control) return true;

    // Fast branch on boolean flag (no string comparison in hot path)
    if (this.encodeMode) {
      return this.processEncode(inputs);
    }
    return this.processPassthrough(inputs);
  }

  /**
   * Passthrough mode: clamp Float32 samples and write per-quantum to Float32 SAB.
   * This is the original process() behavior, unchanged.
   * @param inputs - Input audio data from the graph
   * @returns Always true to keep the processor alive
   */
  private processPassthrough(inputs: Float32Array[][]): boolean {
    if (!this.sharedFloat32 || !this.control) return true;

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
    this.clampToConversionBuffer(input, channel0, channel1, frameCount);

    // Write to ring buffer with wrap handling
    const startOffset = write & this.bufferMask;
    const endOffset = startOffset + samplesToWrite;

    if (endOffset <= this.capacity) {
      // No wrap - single set
      this.sharedFloat32.set(this.conversionBuffer.subarray(0, samplesToWrite), startOffset);
    } else {
      // Wrap - two sets
      const firstPart = this.capacity - startOffset;
      this.sharedFloat32.set(this.conversionBuffer.subarray(0, firstPart), startOffset);
      this.sharedFloat32.set(this.conversionBuffer.subarray(firstPart, samplesToWrite), 0);
    }

    // Single atomic commit
    Atomics.store(this.control, CTRL_WRITE_IDX, (write + samplesToWrite) | 0);

    // Only notify on empty→non-empty transition
    if (wasEmpty) {
      Atomics.notify(this.control, CTRL_WRITE_IDX, 1);
    }

    this.tickHeartbeat();

    return true;
  }

  /**
   * Encode mode: clamp, quantize Float32→Int16 with TPDF dither, accumulate into
   * frames, and write complete Int16 frames to the SAB ring buffer.
   *
   * Frame accumulation uses the split-write strategy (Design Doc Section 4.3,
   * Approach B) to handle the non-integer quanta-per-frame ratio cleanly.
   *
   * @param inputs - Input audio data from the graph
   * @returns Always true to keep the processor alive
   */
  private processEncode(inputs: Float32Array[][]): boolean {
    const control = this.control!;
    const sharedInt16 = this.sharedInt16!;
    const encodeBuffer = this.encodeBuffer!;
    const frameAccum = this.frameAccum!;

    const input = inputs[0];
    if (!input?.[0]) return true;

    const channel0 = input[0];
    const channel1 = input[1] || channel0;
    const frameCount = channel0.length;
    const samplesToWrite = frameCount * this.channels;

    // Step (a): Clamp and interleave into conversionBuffer (same as passthrough)
    this.clampToConversionBuffer(input, channel0, channel1, frameCount);

    // Step (b): Quantize Float32→Int16 with TPDF dither into encodeBuffer
    let ditherIdx = this.ditherIndex;
    for (let i = 0; i < samplesToWrite; i++) {
      const s = this.conversionBuffer[i]!;
      // conversionBuffer is already clamped to [-1, 1] with NaN→0
      const dithered = s * INT16_MAX + DITHER_TABLE[ditherIdx]!;
      ditherIdx = (ditherIdx + 1) & DITHER_TABLE_MASK;
      const rounded = Math.round(dithered);
      encodeBuffer[i] = rounded < -32768 ? -32768 : rounded > 32767 ? 32767 : rounded;
    }
    this.ditherIndex = ditherIdx;

    // Step (c): Append encoded samples to frame accumulation buffer using split-write.
    // At most 2 iterations per quantum (one frame boundary crossing per quantum at most).
    let encodedOffset = 0;
    while (encodedOffset < samplesToWrite) {
      const spaceInFrame = this.frameSizeInterleaved - this.frameAccumOffset;
      const toCopy =
        samplesToWrite - encodedOffset < spaceInFrame
          ? samplesToWrite - encodedOffset
          : spaceInFrame;

      frameAccum.set(
        encodeBuffer.subarray(encodedOffset, encodedOffset + toCopy),
        this.frameAccumOffset,
      );
      this.frameAccumOffset += toCopy;
      encodedOffset += toCopy;

      // Step (d): When frame is complete, write to SAB
      if (this.frameAccumOffset >= this.frameSizeInterleaved) {
        this.writeFrameToSAB(control, sharedInt16, frameAccum);
        this.frameAccumOffset = 0;
      }
    }

    this.tickHeartbeat();

    return true;
  }

  /**
   * Writes a complete Int16 frame to the SAB ring buffer.
   * Drops the frame if the buffer is full. Uses two-part copy for wrap handling.
   * @param control - Int32Array control region
   * @param sharedInt16 - Int16Array data region of the SAB
   * @param frame - Complete Int16 frame to write
   */
  private writeFrameToSAB(control: Int32Array, sharedInt16: Int16Array, frame: Int16Array): void {
    const frameSize = this.frameSizeInterleaved;

    // Check available space
    const write = Atomics.load(control, CTRL_WRITE_IDX);
    const read = Atomics.load(control, CTRL_READ_IDX);
    const used = (write - read) >>> 0;
    const available = this.capacity - used;

    if (available < frameSize) {
      // Drop frame, track samples dropped
      Atomics.add(control, CTRL_DROPPED_SAMPLES, frameSize);
      return;
    }

    const wasEmpty = write === read;

    // Write to ring buffer with wrap handling
    const startOffset = write & this.bufferMask;
    const endOffset = startOffset + frameSize;

    if (endOffset <= this.capacity) {
      // No wrap - single set
      sharedInt16.set(frame, startOffset);
    } else {
      // Wrap - two sets
      const firstPart = this.capacity - startOffset;
      sharedInt16.set(frame.subarray(0, firstPart), startOffset);
      sharedInt16.set(frame.subarray(firstPart), 0);
    }

    // Single atomic commit
    Atomics.store(control, CTRL_WRITE_IDX, (write + frameSize) | 0);

    // Only notify on empty→non-empty transition
    if (wasEmpty) {
      Atomics.notify(control, CTRL_WRITE_IDX, 1);
    }
  }

  /**
   * Clamps and interleaves input audio into the pre-allocated conversionBuffer.
   * Handles mono downmix and stereo interleaving with unrolled loops.
   * @param input - Raw input channel array from process()
   * @param channel0 - Left/mono channel
   * @param channel1 - Right channel (or same as channel0 for mono input)
   * @param frameCount - Number of frames in this quantum
   */
  private clampToConversionBuffer(
    input: Float32Array[],
    channel0: Float32Array,
    channel1: Float32Array,
    frameCount: number,
  ): void {
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
  }

  /**
   * Sends periodic heartbeat to main thread. Called at the end of both process paths.
   */
  private tickHeartbeat(): void {
    this.blockCount++;
    if (this.blockCount >= this.heartbeatIntervalBlocks) {
      this.blockCount = 0;
      this.port.postMessage({ type: 'HEARTBEAT' });
    }
  }
}

registerProcessor('pcm-processor', PCMProcessor);

// Empty export to make this a module (prevents TypeScript from treating as a script)
export {};
