// AudioWorkletProcessor for capturing PCM audio data
// This file runs in a separate AudioWorklet context

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor
): void;

const BUFFER_SIZE = 2048; // Samples per channel per message (reduced from 4096 for lower latency)

class PCMProcessor extends AudioWorkletProcessor {
  private leftBuffer: Float32Array;
  private rightBuffer: Float32Array;
  private bufferIndex: number;

  constructor() {
    super();
    this.leftBuffer = new Float32Array(BUFFER_SIZE);
    this.rightBuffer = new Float32Array(BUFFER_SIZE);
    this.bufferIndex = 0;
  }

  override process(
    inputs: Float32Array[][],
    _outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const leftChannel = input[0];
    const rightChannel = input[1] || input[0]; // Mono fallback

    if (!leftChannel) return true;

    for (let i = 0; i < leftChannel.length; i++) {
      this.leftBuffer[this.bufferIndex] = leftChannel[i] ?? 0;
      this.rightBuffer[this.bufferIndex] = rightChannel?.[i] ?? leftChannel[i] ?? 0;
      this.bufferIndex++;

      if (this.bufferIndex >= BUFFER_SIZE) {
        // Send buffer to main thread
        this.port.postMessage({
          left: this.leftBuffer.slice(),
          right: this.rightBuffer.slice(),
        });

        this.bufferIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
