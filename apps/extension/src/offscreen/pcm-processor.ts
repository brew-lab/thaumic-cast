/**
 * AudioWorkletProcessor for extracting raw PCM samples using zero-copy shared memory.
 * Uses Atomics for thread-safe access to control indices.
 */

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
  private bufferSize = 0;

  /**
   * Creates a new PCM processor instance.
   */
  constructor() {
    super();
    this.port.onmessage = (event) => {
      if (event.data.type === 'INIT_BUFFER') {
        const { buffer: sab, bufferSize, headerSize } = event.data;
        this.sharedBuffer = new Int16Array(sab, headerSize * 4);
        this.control = new Int32Array(sab, 0, headerSize);
        this.bufferSize = bufferSize;
      }
    };
  }

  /**
   * Processes audio frames and writes to shared memory ring buffer.
   * @param inputs - Input audio data from the graph
   * @returns Always true to keep the processor alive
   */
  process(inputs: Float32Array[][]): boolean {
    if (!this.sharedBuffer || !this.control || !this.bufferSize) return true;

    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const left = input[0];
    const right = input[1] || left;

    if (!left) return true;

    let writeIdx = Atomics.load(this.control, 0);
    const readIdx = Atomics.load(this.control, 1);

    for (let i = 0; i < left.length; i++) {
      // Convert to Int16
      const lSample = Math.max(-1, Math.min(1, left[i]!)) * 0x7fff;
      const rSample = Math.max(-1, Math.min(1, right[i]!)) * 0x7fff;

      // Check for overflow before writing
      const nextIdx = (writeIdx + 2) % this.bufferSize;
      if (nextIdx === readIdx) {
        Atomics.store(this.control, 2, 1); // Set overflow flag
        break;
      }

      this.sharedBuffer[writeIdx] = lSample;
      this.sharedBuffer[writeIdx + 1] = rSample;
      writeIdx = nextIdx;
    }

    Atomics.store(this.control, 0, writeIdx); // Update write pointer
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
