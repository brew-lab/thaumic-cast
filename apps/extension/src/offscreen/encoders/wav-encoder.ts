import type { EncoderConfig } from '@thaumic-cast/protocol';
import type { AudioEncoder } from './types';

/**
 * WAV "encoder" - passes through raw PCM samples.
 * Zero encoding latency, highest bandwidth usage.
 */
export class WavEncoder implements AudioEncoder {
  /**
   * Creates a new WAV encoder instance.
   * @param config - The encoder configuration
   */
  constructor(public readonly config: EncoderConfig) {}

  /**
   * Passes through PCM samples as raw bytes.
   * @param samples - Interleaved stereo Int16 samples
   * @returns Raw PCM bytes
   */
  encode(samples: Int16Array): Uint8Array | null {
    return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  }

  /**
   * No-op for WAV encoder.
   * @returns Always null
   */
  flush(): Uint8Array | null {
    return null;
  }

  /**
   * Closes the encoder.
   */
  close(): void {
    // Nothing to clean up
  }
}
