import type { EncoderConfig, LatencyMode } from '@thaumic-cast/protocol';

// Re-export LatencyMode for convenience
export type { LatencyMode } from '@thaumic-cast/protocol';

/**
 * Options for reconfiguring an encoder at runtime.
 */
export interface ReconfigureOptions {
  /**
   * New latency mode for the encoder.
   * 'realtime' tells the browser to encode faster at the cost of quality.
   */
  latencyMode?: LatencyMode;
}

/**
 * Unified interface for all audio encoders.
 * Implementations handle codec-specific encoding logic.
 */
export interface AudioEncoder {
  /**
   * Encodes a chunk of interleaved Float32 PCM samples.
   * Samples should be in the range [-1.0, 1.0].
   * @param samples - Raw PCM samples from AudioWorklet
   * @returns Encoded bytes to send over WebSocket, or null if buffering
   */
  encode(samples: Float32Array): Uint8Array | null;

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

  /**
   * Current latency mode of the encoder.
   */
  readonly latencyMode: LatencyMode;

  /**
   * Reconfigures the encoder with new settings at runtime.
   * Flushes pending data, closes the current encoder, and creates a new one.
   *
   * Use this to switch between 'quality' and 'realtime' modes when CPU load changes.
   * 'realtime' mode tells the browser to prioritize encoding speed over quality.
   *
   * @param options - New configuration options
   * @returns Flushed data from the old encoder, or null if nothing was buffered
   */
  reconfigure(options: ReconfigureOptions): Uint8Array | null;
}
