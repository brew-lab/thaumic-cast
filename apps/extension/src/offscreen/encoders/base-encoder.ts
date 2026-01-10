import type { EncoderConfig, LatencyMode } from '@thaumic-cast/protocol';
import { CODEC_METADATA } from '@thaumic-cast/protocol';
import { createLogger, type Logger } from '@thaumic-cast/shared';
import type { AudioEncoder, ReconfigureOptions } from './types';

/**
 * Extended interface for AudioEncoderConfig to include non-standard Chrome properties.
 */
export interface ChromeAudioEncoderConfig extends AudioEncoderConfig {
  latencyMode?: LatencyMode;
}

/**
 * Default capacity for pre-allocated buffers.
 * Sized for 10ms of stereo audio at 48kHz (480 frames * 2 channels).
 */
const DEFAULT_BUFFER_CAPACITY = 960;

/**
 * Abstract base class for all audio encoders.
 * Provides common functionality for buffer management, output consolidation,
 * and WebCodecs encoder lifecycle management.
 *
 * Subclasses must implement:
 * - `handleOutput()` for codec-specific output processing
 * - `getEncoderConfig()` for codec-specific WebCodecs configuration
 * - `getLoggerName()` for logger identification
 */
export abstract class BaseAudioEncoder implements AudioEncoder {
  protected encoder: globalThis.AudioEncoder;
  protected outputQueue: Uint8Array[] = [];
  protected timestamp = 0;
  protected isClosed = false;
  protected readonly log: Logger;
  protected readonly webCodecsId: string;

  /** Current latency mode */
  private _latencyMode: LatencyMode;

  /** Pre-allocated planar conversion buffer */
  protected planarBuffer: Float32Array;

  /**
   * Returns the number of pending encode requests.
   * @returns The encode queue size
   */
  get encodeQueueSize(): number {
    return this.encoder.encodeQueueSize;
  }

  /**
   * Returns the current latency mode.
   * @returns The latency mode setting
   */
  get latencyMode(): LatencyMode {
    return this._latencyMode;
  }

  /**
   * Creates a new encoder instance.
   * @param config - The encoder configuration
   */
  constructor(public readonly config: EncoderConfig) {
    this.log = createLogger(this.getLoggerName());

    const webCodecsId = CODEC_METADATA[config.codec].webCodecsId;
    if (!webCodecsId) {
      throw new Error(`Codec ${config.codec} does not support WebCodecs`);
    }
    this.webCodecsId = webCodecsId;

    // Use latencyMode from config (defaults to 'quality' via schema)
    this._latencyMode = config.latencyMode;

    this.encoder = this.createEncoder();

    // Pre-allocate conversion buffer to minimize GC during encoding
    this.planarBuffer = new Float32Array(DEFAULT_BUFFER_CAPACITY);

    this.logConfiguration();
  }

  /**
   * Creates and configures a new WebCodecs AudioEncoder.
   * @returns The configured AudioEncoder instance
   */
  private createEncoder(): globalThis.AudioEncoder {
    const encoder = new AudioEncoder({
      output: (chunk, metadata) => this.handleOutput(chunk, metadata),
      error: (err) => this.log.error('Encoder error:', err.message),
    });

    encoder.configure(this.getEncoderConfig(this.webCodecsId, this._latencyMode));

    return encoder;
  }

  /**
   * Returns the logger name for this encoder.
   */
  protected abstract getLoggerName(): string;

  /**
   * Returns the WebCodecs encoder configuration.
   * @param webCodecsId - The WebCodecs codec identifier
   * @param latencyMode - The latency mode to use
   */
  protected abstract getEncoderConfig(
    webCodecsId: string,
    latencyMode: LatencyMode,
  ): ChromeAudioEncoderConfig;

  /**
   * Handles encoded output from WebCodecs.
   * @param chunk - The encoded audio chunk
   * @param metadata - Optional metadata containing codec description
   */
  protected abstract handleOutput(
    chunk: EncodedAudioChunk,
    metadata?: EncodedAudioChunkMetadata,
  ): void;

  /**
   * Logs the encoder configuration after initialization.
   */
  protected abstract logConfiguration(): void;

  /**
   * Called after reconfiguration to allow subclasses to reset state.
   * Override this to reset codec-specific state like header flags.
   */
  protected onReconfigure(): void {
    // Default: no-op. Subclasses can override.
  }

  /**
   * Ensures planar buffer is large enough for the given sample count.
   * @param sampleCount - Total number of samples (frames * channels)
   */
  protected ensureBufferCapacity(sampleCount: number): void {
    if (this.planarBuffer.length < sampleCount) {
      this.planarBuffer = new Float32Array(sampleCount);
    }
  }

  /**
   * Consolidates output queue into a single buffer.
   * @returns Consolidated output or null if queue is empty
   */
  protected consolidateOutput(): Uint8Array | null {
    if (this.outputQueue.length === 0) {
      return null;
    }

    // Fast path: single item, no consolidation needed
    if (this.outputQueue.length === 1) {
      const result = this.outputQueue[0]!;
      this.outputQueue = [];
      return result;
    }

    const totalLength = this.outputQueue.reduce((acc, buf) => acc + buf.byteLength, 0);
    const result = new Uint8Array(totalLength);

    let offset = 0;
    for (const buf of this.outputQueue) {
      result.set(buf, offset);
      offset += buf.byteLength;
    }
    this.outputQueue = [];

    return result;
  }

  /**
   * Converts interleaved Int16 samples to planar Float32 format.
   * Uses pre-allocated buffer to minimize GC pressure.
   * @param samples - Interleaved Int16 samples
   * @returns Object with planar data view and frame count
   */
  protected convertToPlanar(samples: Int16Array): { planarData: Float32Array; frameCount: number } {
    const channels = this.config.channels;
    const frameCount = samples.length / channels;
    const sampleCount = samples.length;

    // Ensure buffer is large enough (rare reallocation for larger frames)
    this.ensureBufferCapacity(sampleCount);

    // Deinterleave and convert Int16 to Float32 into pre-allocated buffer
    // Planar format: all samples for channel 0, then channel 1, etc.
    for (let ch = 0; ch < channels; ch++) {
      for (let i = 0; i < frameCount; i++) {
        this.planarBuffer[ch * frameCount + i] = samples[i * channels + ch]! / 0x7fff;
      }
    }

    // Return subarray view - AudioData copies internally, no need for slice()
    return {
      planarData: this.planarBuffer.subarray(0, sampleCount),
      frameCount,
    };
  }

  /**
   * Creates an AudioData object from planar Float32 samples.
   * @param planarData - Planar Float32 sample data
   * @param frameCount - Number of audio frames
   * @returns The AudioData object (caller must close it)
   */
  protected createAudioData(planarData: Float32Array, frameCount: number): AudioData {
    return new AudioData({
      format: 'f32-planar',
      sampleRate: this.config.sampleRate,
      numberOfFrames: frameCount,
      numberOfChannels: this.config.channels,
      timestamp: this.timestamp,
      // Cast needed: TS strict typing doesn't recognize Float32Array<ArrayBufferLike> as BufferSource
      data: planarData as unknown as BufferSource,
    });
  }

  /**
   * Encodes PCM samples.
   * Uses pre-allocated buffer to minimize GC pressure.
   * @param samples - Interleaved Int16 samples (mono or stereo)
   * @returns Encoded data or null if unavailable
   */
  encode(samples: Int16Array): Uint8Array | null {
    if (this.isClosed) return null;

    const { planarData, frameCount } = this.convertToPlanar(samples);
    const data = this.createAudioData(planarData, frameCount);

    this.encoder.encode(data);
    data.close();
    this.timestamp += (frameCount / this.config.sampleRate) * 1_000_000;

    return this.consolidateOutput();
  }

  /**
   * Flushes any remaining encoded data.
   * @returns Remaining encoded data or null if empty
   */
  flush(): Uint8Array | null {
    if (this.isClosed) return null;

    try {
      // flush() returns a Promise but we can't await here due to interface.
      // Catch any rejection to prevent unhandled promise errors.
      this.encoder.flush().catch(() => {
        // Silently ignore - encoder may be closing
      });
    } catch {
      // Encoder may already be in error state
    }

    return this.consolidateOutput();
  }

  /**
   * Advances the encoder's internal timestamp without encoding.
   * Used when dropping frames due to backpressure to prevent time compression.
   * @param frameCount - Number of audio frames to skip
   */
  advanceTimestamp(frameCount: number): void {
    this.timestamp += (frameCount / this.config.sampleRate) * 1_000_000;
  }

  /**
   * Reconfigures the encoder with new settings at runtime.
   * Flushes pending data, closes the current encoder, and creates a new one.
   *
   * @param options - New configuration options
   * @returns Flushed data from the old encoder, or null if nothing was buffered
   */
  reconfigure(options: ReconfigureOptions): Uint8Array | null {
    if (this.isClosed) return null;

    // Check if there's actually anything to change
    const newLatencyMode = options.latencyMode ?? this._latencyMode;
    if (newLatencyMode === this._latencyMode) {
      return null; // No change needed
    }

    this.log.info(`Reconfiguring encoder: latencyMode ${this._latencyMode} -> ${newLatencyMode}`);

    // Flush and collect any pending output
    let flushedData: Uint8Array | null = null;
    try {
      // Synchronously trigger flush (async completion handled by output callback)
      this.encoder.flush().catch(() => {
        // Ignore - we're closing anyway
      });
      flushedData = this.consolidateOutput();
    } catch {
      // Encoder may be in error state
    }

    // Close old encoder
    try {
      this.encoder.close();
    } catch {
      // Already closed
    }

    // Update latency mode
    this._latencyMode = newLatencyMode;

    // Create new encoder with updated config
    this.encoder = this.createEncoder();

    // Allow subclasses to reset their state
    this.onReconfigure();

    return flushedData;
  }

  /**
   * Closes the encoder and releases resources.
   */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;

    try {
      this.encoder.close();
    } catch {
      this.log.debug('Encoder already closed');
    }
  }
}
