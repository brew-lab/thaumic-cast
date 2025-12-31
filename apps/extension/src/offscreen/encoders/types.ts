import type { EncoderConfig } from '@thaumic-cast/protocol';

/**
 * Unified interface for all audio encoders.
 * Implementations handle codec-specific encoding logic.
 */
export interface AudioEncoder {
  /**
   * Encodes a chunk of interleaved stereo Int16 PCM samples.
   * @param samples - Raw PCM samples from AudioWorklet
   * @returns Encoded bytes to send over WebSocket, or null if buffering
   */
  encode(samples: Int16Array): Uint8Array | null;

  /**
   * Flushes any remaining buffered data.
   * Call before stopping the stream.
   * @returns Final encoded bytes, or null if nothing buffered
   */
  flush(): Uint8Array | null;

  /**
   * Releases encoder resources.
   * Encoder cannot be used after calling close().
   */
  close(): void;

  /**
   * Advances the encoder's internal timestamp without encoding.
   * Used when dropping frames due to backpressure to prevent time compression.
   * @param frameCount - Number of audio frames to skip
   */
  advanceTimestamp(frameCount: number): void;

  /**
   * The configuration this encoder was created with.
   */
  readonly config: EncoderConfig;

  /**
   * Number of pending encode requests in the encoder queue.
   * Used for backpressure detection - if this grows, encoder can't keep up.
   */
  readonly encodeQueueSize: number;
}
